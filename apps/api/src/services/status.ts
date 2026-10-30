import type { NotifyPause, NotifyPauseMode, UserStatus, UserStatusKind } from '@ordo/shared';
import { inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { users, workspaceMembers } from '../db/schema.ts';
import { publishChanges } from './sync.ts';

/** The columns `statusOf` and `pauseOf` read, for spreading into a select. */
export const statusColumns = {
  statusKind: users.statusKind,
  statusEmoji: users.statusEmoji,
  statusText: users.statusText,
  statusUntil: users.statusUntil,
};
export const pauseColumns = {
  notifyPause: users.notifyPause,
  notifyPauseUntil: users.notifyPauseUntil,
};

const live = (until: string | null, now: number) => !until || Date.parse(until) > now;

/** Someone's status, or null when they have none or it ran out (the expiry job may not have run yet). */
export function statusOf(
  row: {
    statusKind: UserStatusKind | null;
    statusEmoji: string | null;
    statusText: string | null;
    statusUntil: string | null;
  },
  now = Date.now(),
): UserStatus | null {
  if (!row.statusKind && !row.statusEmoji && !row.statusText) return null;
  if (!live(row.statusUntil, now)) return null;
  return {
    kind: row.statusKind,
    emoji: row.statusEmoji,
    text: row.statusText,
    until: row.statusUntil,
  };
}

export function pauseOf(
  row: { notifyPause: NotifyPauseMode | null; notifyPauseUntil: string | null },
  now = Date.now(),
): NotifyPause | null {
  if (!row.notifyPause || !live(row.notifyPauseUntil, now)) return null;
  return { mode: row.notifyPause, until: row.notifyPauseUntil };
}

/** Profile changes (name, picture, status) show up in every workspace the people belong to. */
export async function publishProfileChanged(app: FastifyInstance, userIds: string[]) {
  if (userIds.length === 0) return;
  const rows = await app.db
    .select({ userId: workspaceMembers.userId, workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.userId, userIds));
  await publishChanges(
    app,
    rows.map((r) => ({
      kind: 'member' as const,
      action: 'updated' as const,
      id: r.userId,
      workspaceId: r.workspaceId,
      actorId: r.userId,
    })),
  );
}

/**
 * Every minute: statuses and pauses whose time is up are cleared, and the workspaces of the people
 * concerned refresh, so dots disappear for everyone (and the pause for its owner) on time.
 */
export async function expireStatuses(app: FastifyInstance) {
  const statuses = await app.db
    .update(users)
    .set({ statusKind: null, statusEmoji: null, statusText: null, statusUntil: null })
    .where(sql`${users.statusUntil} <= now()`)
    .returning({ id: users.id });
  const pauses = await app.db
    .update(users)
    .set({ notifyPause: null, notifyPauseUntil: null })
    .where(sql`${users.notifyPauseUntil} <= now()`)
    .returning({ id: users.id });
  await publishProfileChanged(app, [...new Set([...statuses, ...pauses].map((u) => u.id))]);
}
