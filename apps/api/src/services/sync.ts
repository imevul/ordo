import type { RealtimeEvent } from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { syncChanges, syncCursors } from '../db/schema.ts';

/**
 * The change log behind offline sync. Every change clients should hear about is an `emit()` in a
 * transaction; at the end of that transaction its events are numbered and written here, so a
 * client can ask "what changed since #1234?" and catch up after being offline.
 *
 * Numbers are claimed by the last statement of the transaction, which locks the workspace's
 * cursor row until commit. So they follow commit order with no gaps: once #7 is visible, #6 is
 * too, and a client that read up to #6 misses nothing.
 */

/** What the log keeps of one change, once per entity per transaction. */
function entries(events: RealtimeEvent[]) {
  const byEntity = new Map<string, RealtimeEvent & { teamIds: Set<string> }>();
  for (const e of events) {
    const key = `${e.kind}:${e.id}:${e.userId ?? ''}`;
    const seen = byEntity.get(key);
    const teamIds = seen?.teamIds ?? new Set<string>();
    if (e.teamId) teamIds.add(e.teamId);
    if (e.prevTeamId) teamIds.add(e.prevTeamId);
    // The last action wins, except that something created here stays "created".
    const action = seen?.action === 'created' && e.action === 'updated' ? 'created' : e.action;
    byEntity.set(key, { ...e, action, teamIds });
  }
  return [...byEntity.values()];
}

/**
 * Logs a transaction's events for one workspace and returns where they landed, or null when
 * there was nothing to log. Call it last in the transaction.
 */
export async function logChanges(tx: DbOrTx, workspaceId: string, events: RealtimeEvent[]) {
  const rows = entries(events.filter((e) => e.workspaceId === workspaceId && loggable(e)));
  if (!rows.length) return null;
  const [cursor] = await tx
    .insert(syncCursors)
    .values({ workspaceId, seq: rows.length })
    .onConflictDoUpdate({
      target: syncCursors.workspaceId,
      set: { seq: sql`${syncCursors.seq} + ${rows.length}` },
    })
    .returning({ seq: syncCursors.seq, epoch: syncCursors.epoch });
  const first = cursor!.seq - rows.length + 1;
  await tx.insert(syncChanges).values(
    rows.map((e, i) => ({
      workspaceId,
      seq: first + i,
      kind: e.kind,
      entityId: e.id,
      action: e.action,
      teamIds: [...e.teamIds],
      userId: e.userId ?? null,
    })),
  );
  return { seq: cursor!.seq, epoch: cursor!.epoch };
}

/**
 * A deleted workspace takes its log with it; nothing to log about that. Live run output arrives
 * every few seconds and no local copy holds it, so it would only fill the log.
 */
const loggable = (e: RealtimeEvent) =>
  !(e.kind === 'workspace' && e.action === 'deleted') && e.kind !== 'agentRunOutput';

/** Events stamped with their place in the log, for clients to know how far they've read. */
export const stamp = (
  events: RealtimeEvent[],
  cursor: { seq: number; epoch: number } | null,
): RealtimeEvent[] => (cursor ? events.map((e) => ({ ...e, ...cursor })) : events);

/**
 * Publishes changes made outside `runInWorkspace` (profile edits, background jobs): logs them in
 * a transaction of their own, then tells open clients. Everything published goes through here or
 * `runInWorkspace`, so the log misses nothing clients were told.
 */
export async function publishChanges(app: FastifyInstance, events: RealtimeEvent[]) {
  const byWorkspace = new Map<string, RealtimeEvent[]>();
  for (const e of events)
    byWorkspace.set(e.workspaceId, [...(byWorkspace.get(e.workspaceId) ?? []), e]);
  for (const [workspaceId, list] of byWorkspace) {
    const cursor = list.some(loggable)
      ? await app.db.transaction((tx) => logChanges(tx, workspaceId, list))
      : null;
    app.realtime.publish(stamp(list, cursor));
  }
}

/**
 * Starts a new epoch: clients load the workspace again instead of replaying the log. For changes
 * too big to replay one by one (imports) or that take a whole team away (team deletion).
 */
export async function bumpEpoch(tx: DbOrTx, workspaceId: string) {
  const [cursor] = await tx
    .insert(syncCursors)
    .values({ workspaceId, epoch: 2 })
    .onConflictDoUpdate({
      target: syncCursors.workspaceId,
      set: { epoch: sql`${syncCursors.epoch} + 1`, minSeq: sql`${syncCursors.seq}` },
    })
    .returning({ seq: syncCursors.seq, epoch: syncCursors.epoch });
  return cursor!;
}

/** Daily: the log keeps 30 days. Clients further behind load everything again. */
export async function pruneChanges(db: DbOrTx) {
  await db.execute(sql`
    with gone as (
      delete from sync_changes where created_at < now() - interval '30 days'
      returning workspace_id, seq
    )
    update sync_cursors c set min_seq = greatest(c.min_seq, g.last)
    from (select workspace_id, max(seq) as last from gone group by workspace_id) g
    where c.workspace_id = g.workspace_id`);
}
