import type {
  CreateIssueInput,
  CreateRecurringInput,
  RecurrenceUnit,
  RecurringIssue,
} from '@ordo/shared';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { issueTemplates, recurringIssues } from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { type Access, canReadTeam, teamScope } from './access.ts';
import { runAutomation } from './automation.ts';
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
    throw badRequest('Unknown template');
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
 * up), and moves on to its next date after today.
 */
export async function runRecurring(app: FastifyInstance, today = isoDay(new Date())) {
  const due = await app.db
    .select({ schedule: recurringIssues, template: issueTemplates })
    .from(recurringIssues)
    .innerJoin(issueTemplates, eq(issueTemplates.id, recurringIssues.templateId))
    .where(and(lte(recurringIssues.nextOn, today), eq(recurringIssues.paused, false)));
  for (const { schedule, template } of due) {
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
      // issue still gets made, with what's left.
      const attempt = (input: CreateIssueInput) =>
        ctx.tx.transaction((tx) => createIssue({ ...ctx, tx }, input));
      const issue = await attempt(full).catch(() =>
        attempt({ teamId: full.teamId, title: full.title, description: full.description }),
      );
      await ctx.tx
        .update(recurringIssues)
        .set({ nextOn: next, lastIssueId: issue.id })
        .where(eq(recurringIssues.id, schedule.id));
    });
  }
}
