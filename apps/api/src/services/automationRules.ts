import {
  AUTOMATION_FIELDS,
  type AutomationActions,
  type AutomationConditions,
  type AutomationRule,
  type AutomationTrigger,
  type AutomationTriggerType,
  type HistoryChange,
} from '@ordo/shared';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  automationRules,
  cycles,
  domainEvents,
  issues,
  teams,
  workflowStates,
} from '../db/schema.ts';
import { enqueue } from '../lib/jobs/index.ts';
import { runAutomation } from './automation.ts';
import { createComment } from './comments.ts';
import type { Ctx } from './context.ts';
import { workspaceToday } from './cycle-automation.ts';
import type { EventRow } from './events.ts';
import {
  assertAssignee,
  assertCycle,
  assertLabels,
  assertProject,
  filterConditions,
  stateOf,
  updateIssue,
} from './issues.ts';

/**
 * Loop protection: a rule never acts twice in one chain of changes it caused, and a chain stops
 * after this many rules ("when priority changes, add a label" and "when a label is added, change
 * the priority" can't ping-pong).
 */
export const MAX_AUTOMATION_CHAIN = 5;

export const toAutomationRule = (r: typeof automationRules.$inferSelect): AutomationRule => ({
  id: r.id,
  teamId: r.teamId,
  name: r.name,
  enabled: r.enabled,
  position: r.position,
  trigger: r.trigger,
  conditions: r.conditions,
  actions: r.actions,
  lastRunAt: r.lastRunAt,
  runCount: r.runCount,
});

export async function automationRulesOf(db: DbOrTx, teamIds: string[]) {
  if (teamIds.length === 0) return [];
  return db
    .select()
    .from(automationRules)
    .where(inArray(automationRules.teamId, teamIds))
    .orderBy(asc(automationRules.position), asc(automationRules.createdAt));
}

/** That a rule's statuses, labels, people, cycle and project make sense in its team. */
export async function assertAutomationRule(
  ctx: Ctx,
  teamId: string,
  rule: { trigger?: AutomationTrigger; actions?: AutomationActions },
) {
  const t = rule.trigger;
  if (t?.type === 'status_changed') for (const s of t.stateIds ?? []) await stateOf(ctx, teamId, s);
  if (t?.type === 'label_added') await assertLabels(ctx, teamId, t.labelIds ?? []);
  const a = rule.actions ?? {};
  if (a.stateId) await stateOf(ctx, teamId, a.stateId);
  if (a.assigneeId) await assertAssignee(ctx, teamId, a.assigneeId);
  await assertLabels(ctx, teamId, [...(a.addLabelIds ?? []), ...(a.removeLabelIds ?? [])]);
  if (a.cycleId && a.cycleId !== 'active') await assertCycle(ctx, teamId, a.cycleId);
  if (a.projectId) await assertProject(ctx, a.projectId);
}

/** Something that happened to an issue, which rules with this trigger may act on. */
interface Firing {
  issueId: string;
  type: AutomationTriggerType;
  changes?: HistoryChange[];
}

const WATCHED = new Set<string>(AUTOMATION_FIELDS);

function triggerMatches(trigger: AutomationTrigger, changes: HistoryChange[] = []) {
  switch (trigger.type) {
    case 'issue_updated': {
      const fields = trigger.fields?.length ? new Set<string>(trigger.fields) : WATCHED;
      return changes.some((c) => fields.has(c.field));
    }
    case 'status_changed':
      return changes.some(
        (c) =>
          c.field === 'state' &&
          (!trigger.stateIds?.length || trigger.stateIds.includes(c.to as string)),
      );
    case 'label_added':
      return changes.some((c) => {
        if (c.field !== 'labels') return false;
        const from = (c.from as string[] | null) ?? [];
        const added = ((c.to as string[] | null) ?? []).filter((l) => !from.includes(l));
        return trigger.labelIds?.length
          ? added.some((l) => trigger.labelIds!.includes(l))
          : added.length > 0;
      });
    default:
      return true;
  }
}

const closed = sql`(select ws.type from workflow_states ws where ws.id = "issues"."state_id") in ('completed', 'canceled')`;

/** The parent of a sub-issue that just closed, if that closed its last open sibling. */
async function completedParent(db: DbOrTx, issueId: string) {
  const [row] = await db
    .select({ parentId: issues.parentId })
    .from(issues)
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .where(and(eq(issues.id, issueId), inArray(workflowStates.type, ['completed', 'canceled'])));
  if (!row?.parentId) return null;
  const [parent] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, row.parentId), isNull(issues.deletedAt), sql`not ${closed}`));
  if (!parent) return null;
  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where not ${closed})::int`,
      done: sql<number>`count(*) filter (where (select ws.type from workflow_states ws where ws.id = "issues"."state_id") = 'completed')::int`,
    })
    .from(issues)
    .where(and(eq(issues.parentId, parent.id), isNull(issues.deletedAt)));
  // All canceled isn't "done".
  return counts && counts.open === 0 && counts.done > 0 ? parent.id : null;
}

/** What an outbox event can set off. */
async function firingsOf(db: DbOrTx, event: EventRow): Promise<Firing[]> {
  const issueId = (event.data as { id?: string }).id;
  if (!issueId) return [];
  if (event.type === 'issue.created') return [{ issueId, type: 'issue_created' }];
  if (event.type !== 'issue.updated') return [];
  const changes = event.changes ?? [];
  const out: Firing[] = (['issue_updated', 'status_changed', 'label_added'] as const).map(
    (type) => ({ issueId, type, changes }),
  );
  if (changes.some((c) => c.field === 'state')) {
    const parentId = await completedParent(db, issueId);
    if (parentId) out.push({ issueId: parentId, type: 'sub_issues_completed' });
  }
  return out;
}

/**
 * Called with each transaction's outbox events: queues a run for the ones automation rules may
 * act on. Once per event, so a retried dispatch doesn't act twice.
 */
export async function queueAutomations(
  app: FastifyInstance,
  workspaceId: string,
  events: EventRow[],
) {
  const candidates = events.filter(
    (e) =>
      (e.type === 'issue.created' || e.type === 'issue.updated') &&
      (e.automationChain?.length ?? 0) < MAX_AUTOMATION_CHAIN,
  );
  if (!candidates.length) return;
  const [any] = await app.db
    .select({ id: automationRules.id })
    .from(automationRules)
    .innerJoin(teams, eq(teams.id, automationRules.teamId))
    .where(and(eq(teams.workspaceId, workspaceId), eq(automationRules.enabled, true)))
    .limit(1);
  if (!any) return;
  for (const e of candidates)
    await enqueue(
      app.db,
      'automations.event',
      { workspaceId, eventId: e.id },
      { once: true, dedupeKey: `automation:${e.id}` },
    );
}

/** A pull request linked to an issue (one that closes it) was opened or merged. */
export async function queuePullRequestAutomation(
  ctx: Ctx,
  issueId: string,
  type: 'pull_request_opened' | 'pull_request_merged',
) {
  await enqueue(ctx.tx, 'automations.run', {
    workspaceId: ctx.workspaceId,
    chain: ctx.automation?.chain ?? [],
    firings: [{ issueId, type }],
  });
}

export async function runAutomationEvent(
  app: FastifyInstance,
  { workspaceId, eventId }: { workspaceId: string; eventId: number },
) {
  const [event] = await app.db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.id, eventId), eq(domainEvents.workspaceId, workspaceId)));
  if (!event) return;
  const firings = await firingsOf(app.db, event);
  await runAutomationRules(app, { workspaceId, chain: event.automationChain ?? [], firings });
}

/** Runs the matching rules for each firing, in one transaction, as the Ordo bot. */
export async function runAutomationRules(
  app: FastifyInstance,
  { workspaceId, chain, firings }: { workspaceId: string; chain: string[]; firings: Firing[] },
) {
  if (!firings.length || chain.length >= MAX_AUTOMATION_CHAIN) return;
  await runAutomation(app, workspaceId, async (ctx) => {
    ctx.automation = { chain };
    for (const f of firings) await fire(app, ctx, chain, f);
  });
}

async function fire(app: FastifyInstance, ctx: Ctx, chain: string[], f: Firing) {
  const [issue] = await ctx.tx
    .select({ teamId: issues.teamId })
    .from(issues)
    .where(
      and(
        eq(issues.id, f.issueId),
        eq(issues.workspaceId, ctx.workspaceId),
        isNull(issues.deletedAt),
      ),
    );
  if (!issue) return;
  const rules = (await automationRulesOf(ctx.tx, [issue.teamId])).filter(
    (r) =>
      r.enabled &&
      r.trigger.type === f.type &&
      !chain.includes(r.id) &&
      triggerMatches(r.trigger, f.changes),
  );
  for (const rule of rules) {
    // Checked when the rule runs, so an earlier rule's changes count.
    if (!(await conditionsHold(ctx, f.issueId, rule.conditions))) continue;
    await applyRule(app, ctx, chain, rule, f.issueId, issue.teamId);
  }
}

async function conditionsHold(ctx: Ctx, issueId: string, conditions: AutomationConditions) {
  const [row] = await ctx.tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), ...filterConditions(ctx.access, conditions)));
  return !!row;
}

async function activeCycle(ctx: Ctx, teamId: string) {
  const today = await workspaceToday(ctx.tx, ctx.workspaceId);
  const [active] = await ctx.tx
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(eq(cycles.teamId, teamId), lte(cycles.startsAt, today), sql`${cycles.endsAt} > ${today}`),
    );
  return active?.id ?? null;
}

async function applyRule(
  app: FastifyInstance,
  ctx: Ctx,
  chain: string[],
  rule: typeof automationRules.$inferSelect,
  issueId: string,
  teamId: string,
) {
  const a = rule.actions;
  const patch: Parameters<typeof updateIssue>[2] = {};
  if (a.stateId) patch.stateId = a.stateId;
  if (a.priority !== undefined) patch.priority = a.priority;
  if (a.assigneeId !== undefined) patch.assigneeId = a.assigneeId;
  if (a.addLabelIds?.length) patch.addLabelIds = a.addLabelIds;
  if (a.removeLabelIds?.length) patch.removeLabelIds = a.removeLabelIds;
  if (a.projectId !== undefined) patch.projectId = a.projectId;
  if (a.cycleId === 'active') {
    const active = await activeCycle(ctx, teamId);
    if (active) patch.cycleId = active;
  } else if (a.cycleId !== undefined) patch.cycleId = a.cycleId;

  const events = ctx.events.length;
  const recorded = ctx.domainEvents.length;
  try {
    // A savepoint: a rule gone stale (a deleted label, someone who left the team) fails alone.
    await ctx.tx.transaction(async (tx) => {
      const sub: Ctx = {
        ...ctx,
        tx,
        automation: { chain, rule: { id: rule.id, name: rule.name } },
      };
      if (Object.keys(patch).length) await updateIssue(sub, issueId, patch);
      if (a.comment) await createComment(sub, issueId, { body: a.comment });
    });
  } catch (err) {
    ctx.events.length = events;
    ctx.domainEvents.length = recorded;
    app.log.warn({ err, ruleId: rule.id, issueId }, 'automation rule failed; skipped');
    return;
  }
  // Nothing to change (already in that status…) isn't a run.
  if (ctx.domainEvents.length === recorded) return;
  await ctx.tx
    .update(automationRules)
    .set({ lastRunAt: new Date().toISOString(), runCount: sql`${automationRules.runCount} + 1` })
    .where(eq(automationRules.id, rule.id));
}
