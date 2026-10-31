import {
  type CreateIssueInput,
  type CreateRecurringInput,
  dayInZone,
  type RecurrenceUnit,
  type RecurringIssue,
} from '@ordo/shared';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { issueTemplates, recurringIssues, workspaces } from '../db/schema.ts';
import { badRequest, HttpError, notFound } from '../lib/errors.ts';
import { type Access, canReadTeam, teamScope } from './access.ts';
import { forEachIsolated, runAutomation } from './automation.ts';
import { type Ctx, emit } from './context.ts';
import { addDays, isoDay } from './cycle-automation.ts';
import { createIssue } from './issues.ts';
import { assertLabelTeam } from './labels.ts';

const toRecurring = (r: typeof recurringIssues.$inferSelect): RecurringIssue => ({
  id: r.id,
  templateId: r.templateId,
  teamId: r.teamId,
  every: r.every,
  unit: r.unit,
  nextOn: r.nextOn,
  paused: r.paused,
  lastIssueId: r.lastIssueId,
  createdById: r.createdById,
});

/** The day `every` units after `day`; months keep the day of the month where they can. */
export function advance(day: string, every: number, unit: RecurrenceUnit) {
  if (unit === 'day') return addDays(day, every);
  if (unit === 'week') return addDays(day, every * 7);
  const d = new Date(`${day}T00:00:00Z`);
  const target = d.getUTCMonth() + every;
  const last = new Date(Date.UTC(d.getUTCFullYear(), target + 1, 0)).getUTCDate();
  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), target, Math.min(d.getUTCDate(), last))));
}

export async function listRecurring(db: DbOrTx, access: Access): Promise<RecurringIssue[]> {
  const rows = await db
    .select()
    .from(recurringIssues)
    .where(
      and(
        eq(recurringIssues.workspaceId, access.workspaceId),
        teamScope(access, recurringIssues.teamId),
      ),
    )
    .orderBy(asc(recurringIssues.nextOn));
  return rows.map(toRecurring);
}

async function load(ctx: Ctx, id: string) {
  const [row] = await ctx.tx
    .select()
    .from(recurringIssues)
    .where(and(eq(recurringIssues.id, id), eq(recurringIssues.workspaceId, ctx.workspaceId)));
  if (!row || !canReadTeam(ctx.access, row.teamId)) throw notFound('Recurring issue');
  await assertLabelTeam(ctx, row.teamId, 'Guests cannot manage recurring issues');
  return row;
}

/** Schedules are managed like templates: by everyone but guests, in teams they can see. */
export async function createRecurring(ctx: Ctx, input: CreateRecurringInput) {
  await assertLabelTeam(ctx, input.teamId, 'Guests cannot manage recurring issues');
  const [template] = await ctx.tx
    .select({ teamId: issueTemplates.teamId })
    .from(issueTemplates)
    .where(
      and(eq(issueTemplates.id, input.templateId), eq(issueTemplates.workspaceId, ctx.workspaceId)),
    );
  if (!template || (template.teamId && !canReadTeam(ctx.access, template.teamId)))
    throw badRequest('Unknown template').as('unknown_template');
  if (template.teamId && template.teamId !== input.teamId)
    throw badRequest('A team template repeats in its own team');
  const [row] = await ctx.tx
    .insert(recurringIssues)
    .values({ ...input, workspaceId: ctx.workspaceId, createdById: ctx.userId })
    .returning();
  emit(ctx, { kind: 'template', action: 'updated', id: input.templateId });
  return toRecurring(row!);
}

export async function updateRecurring(
  ctx: Ctx,
  id: string,
  input: Partial<Pick<RecurringIssue, 'every' | 'unit' | 'nextOn' | 'paused'>>,
) {
  const current = await load(ctx, id);
  const [row] = await ctx.tx
    .update(recurringIssues)
    .set(input)
    .where(eq(recurringIssues.id, id))
    .returning();
  emit(ctx, { kind: 'template', action: 'updated', id: current.templateId });
  return toRecurring(row!);
}

export async function deleteRecurring(ctx: Ctx, id: string) {
  const current = await load(ctx, id);
  await ctx.tx.delete(recurringIssues).where(eq(recurringIssues.id, id));
  emit(ctx, { kind: 'template', action: 'updated', id: current.templateId });
}

/**
 * Hourly: every schedule due today or earlier creates its issue, once (missed runs don't pile
 * up), and moves on to its next date after today. "Today" is the workspace's, as for cycles.
 */
export async function runRecurring(app: FastifyInstance, at = new Date()) {
  // No zone is more than 14 hours ahead of UTC: nothing due anywhere is past tomorrow in UTC.
  const rows = await app.db
    .select({ schedule: recurringIssues, template: issueTemplates, settings: workspaces.settings })
    .from(recurringIssues)
    .innerJoin(issueTemplates, eq(issueTemplates.id, recurringIssues.templateId))
    .innerJoin(workspaces, eq(workspaces.id, recurringIssues.workspaceId))
    .where(
      and(lte(recurringIssues.nextOn, addDays(isoDay(at), 1)), eq(recurringIssues.paused, false)),
    );
  const due = rows
    .map((row) => ({ ...row, today: dayInZone(row.settings.timezone, at) }))
    .filter((row) => row.schedule.nextOn <= row.today);
  await forEachIsolated(
    app,
    'issues.recur',
    due,
    ({ schedule }) => ({ recurringId: schedule.id, workspaceId: schedule.workspaceId }),
    (row) => runSchedule(app, row, row.today),
  );
}

async function runSchedule(
  app: FastifyInstance,
  {
    schedule,
    template,
  }: {
    schedule: typeof recurringIssues.$inferSelect;
    template: typeof issueTemplates.$inferSelect;
  },
  today: string,
) {
  await runAutomation(app, schedule.workspaceId, async (ctx) => {
    let next = schedule.nextOn;
    while (next <= today) next = advance(next, schedule.every, schedule.unit);
    const sameTeam = template.teamId === schedule.teamId;
    const full: CreateIssueInput = {
      teamId: schedule.teamId,
      title: template.title.trim() || template.name,
      description: template.description,
      priority: template.priority ?? undefined,
      stateId: sameTeam ? (template.stateId ?? undefined) : undefined,
      assigneeId: template.assigneeId,
      projectId: template.projectId,
      estimate: template.estimate,
      labelIds: template.labelIds,
    };
    // What the template sets may have gone stale (someone left the team, a label moved); the
    // issue still gets made, with what's left. Those are 400s; anything else is a real failure.
    // An agent assignee gets a run with the description as its task; a paused agent's waits.
    const attempt = (input: CreateIssueInput) =>
      ctx.tx.transaction((tx) =>
        createIssue({ ...ctx, tx }, input, undefined, { runTrigger: 'scheduled' }),
      );
    const issue = await attempt(full).catch((err) => {
      if (!(err instanceof HttpError && err.statusCode === 400)) throw err;
      return attempt({ teamId: full.teamId, title: full.title, description: full.description });
    });
    await ctx.tx
      .update(recurringIssues)
      .set({ nextOn: next, lastIssueId: issue.id })
      .where(eq(recurringIssues.id, schedule.id));
  });
}
