import { AGENT_RUN_OPEN, type AgentRunStatus, type WebhookPayload } from '@ordo/shared';
import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  agentRuns,
  domainEvents,
  jobKeys,
  teams,
  users,
  webhookDeliveries,
  webhooks,
  workspaces,
} from '../db/schema.ts';
import { enqueue } from '../lib/jobs/index.ts';
import { queueAutomations } from './automationRules.ts';
import { type Ctx, record } from './context.ts';
import { dispatchToIntegrations } from './integrations.ts';
import { queueDelivery, wants } from './webhooks.ts';

/**
 * The outbox. `runInWorkspace` calls `writeOutbox` at the end of every transaction: the events of
 * one transaction become rows plus a single dispatch job, ordered per workspace, so consumers see
 * a workspace's changes in commit order. Silent contexts (imports) record nothing.
 */
export async function writeOutbox(ctx: Ctx) {
  if (ctx.silent) return;
  if (ctx.runStopped) await recordIdleRuns(ctx);
  if (ctx.domainEvents.length === 0) return;
  const rows = await ctx.tx
    .insert(domainEvents)
    .values(
      ctx.domainEvents.map((e) => ({
        workspaceId: ctx.workspaceId,
        type: e.type,
        actorId: ctx.userId,
        source: ctx.source,
        teamIds: e.teamIds,
        data: e.data,
        changes: e.changes ?? null,
        automationChain: e.automationChain ?? null,
      })),
    )
    .returning({ id: domainEvents.id });
  ctx.domainEvents = [];
  await enqueue(
    ctx.tx,
    'events.dispatch',
    { workspaceId: ctx.workspaceId, ids: rows.map((r) => r.id) },
    { orderingKey: `events:${ctx.workspaceId}` },
  );
}

/**
 * `agent_runs.idle`: a run stopped working and none is left. This waits for the end of the
 * transaction and takes a lock, because two runs stopping at once would otherwise each still see
 * the other working, and nobody would report it. Every team hears it: no run works in any of them.
 */
async function recordIdleRuns(ctx: Ctx) {
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`agent-runs-idle:${ctx.workspaceId}`}))`,
  );
  const open = await ctx.tx
    .select({ status: agentRuns.status, n: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, ctx.workspaceId),
        inArray(agentRuns.status, [...AGENT_RUN_OPEN]),
      ),
    )
    .groupBy(agentRuns.status);
  const runs = (status: AgentRunStatus) => open.find((r) => r.status === status)?.n ?? 0;
  if (runs('claimed') + runs('running') > 0) return;
  const inWorkspace = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.workspaceId, ctx.workspaceId));
  record(
    ctx,
    'agent_runs.idle',
    { queued: runs('queued'), waiting: runs('waiting') },
    { teamIds: inWorkspace.map((t) => t.id) },
  );
}

export type EventRow = typeof domainEvents.$inferSelect;

export async function toPayloads(app: FastifyInstance, events: EventRow[]) {
  if (!events.length) return [];
  const [ws] = await app.db
    .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, events[0]!.workspaceId));
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((a): a is string => !!a))];
  const actors = actorIds.length
    ? await app.db
        .select({ id: users.id, name: users.name, username: users.username, kind: users.kind })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  return events.map(
    (e): WebhookPayload => ({
      id: String(e.id),
      type: e.type,
      createdAt: e.createdAt,
      workspace: ws!,
      actor: actors.find((a) => a.id === e.actorId) ?? null,
      source: e.source,
      data: e.data,
      ...(e.changes && { changes: e.changes }),
    }),
  );
}

/** Fans one transaction's events out to webhooks and integrations. Safe to retry. */
export async function dispatchEvents(
  app: FastifyInstance,
  { workspaceId, ids }: { workspaceId: string; ids: number[] },
) {
  const events = await app.db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.workspaceId, workspaceId), inArray(domainEvents.id, ids)))
    .orderBy(asc(domainEvents.id));
  if (!events.length) return;
  const payloads = await toPayloads(app, events);

  const hooks = await app.db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.enabled, true)));
  if (hooks.length) {
    await app.db.transaction(async (tx) => {
      // A retried dispatch must not deliver twice.
      const done = await tx
        .select({ webhookId: webhookDeliveries.webhookId, eventId: webhookDeliveries.eventId })
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.eventId, ids));
      const seen = new Set(done.map((d) => `${d.webhookId}:${d.eventId}`));
      for (const [i, event] of events.entries()) {
        for (const hook of hooks) {
          if (seen.has(`${hook.id}:${event.id}`) || !wants(hook, event.type, event.teamIds))
            continue;
          // A backlog drained after a webhook was added doesn't belong to it.
          if (hook.createdAt > event.createdAt) continue;
          await queueDelivery(tx, hook.id, payloads[i]!, event.id);
        }
      }
    });
  }
  await dispatchToIntegrations(app, workspaceId, events);
  await queueAutomations(app, workspaceId, events);
}

/**
 * Events are kept for a month (enough to debug and redeliver), deliveries likewise. So are the
 * once-only job keys made from them: no event that old is dispatched again.
 */
export async function pruneEvents(app: FastifyInstance) {
  await app.db.delete(jobKeys).where(lt(jobKeys.createdAt, sql`now() - interval '30 days'`));
  await app.db
    .delete(domainEvents)
    .where(lt(domainEvents.createdAt, sql`now() - interval '30 days'`));
  await app.db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.createdAt, sql`now() - interval '30 days'`));
}
