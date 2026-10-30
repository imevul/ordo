import {
  INBOX_ONLY_TYPES,
  type NotificationReason,
  type NotificationType,
  PAUSE_PASSES,
  type UserPreferences,
} from '@ordo/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { issueSubscribers, issues, notifications, users } from '../db/schema.ts';
import { usersWithTeamAccess } from './access.ts';
import { queueChatNotifications } from './chat.ts';
import { type Ctx, emit } from './context.ts';
import { resolvePreferences } from './digest.ts';
import { queuePush } from './push.ts';
import { pauseColumns, pauseOf } from './status.ts';
import { publishChanges } from './sync.ts';

export async function subscribe(ctx: Ctx, issueId: string, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  await ctx.tx
    .insert(issueSubscribers)
    .values(ids.map((userId) => ({ issueId, userId })))
    .onConflictDoNothing();
}

export async function subscriberIds(ctx: Ctx, issueId: string): Promise<string[]> {
  const rows = await ctx.tx
    .select({ userId: issueSubscribers.userId })
    .from(issueSubscribers)
    .where(eq(issueSubscribers.issueId, issueId));
  return rows.map((r) => r.userId);
}

/** Types that are about the assignee whoever else the issue has. */
const ASSIGNEE_TYPES: readonly NotificationType[] = [
  'issue_assigned',
  'issue_unassigned',
  'issue_priority_urgent',
];

/**
 * Creates notifications for each recipient except the actor, skipping anyone who can't see the
 * issue's team (non-members, guests outside it, members of the workspace outside a private team)
 * and anyone who turned the type off for their inbox. Push and chat DMs go out per the recipient's
 * channel settings, unless they paused notifications; email is left to the digest job.
 */
export async function notify(
  ctx: Ctx,
  input: {
    userIds: (string | null | undefined)[];
    type: NotificationType;
    issueId: string;
    commentId?: string | null;
    data?: Record<string, unknown>;
  },
) {
  if (ctx.silent) return;
  const ids = [...new Set(input.userIds.filter((x): x is string => !!x && x !== ctx.userId))];
  if (ids.length === 0) return;
  const [issue] = await ctx.tx
    .select({ teamId: issues.teamId, assigneeId: issues.assigneeId, creatorId: issues.creatorId })
    .from(issues)
    .where(eq(issues.id, input.issueId));
  if (!issue) return;
  const allowed = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, issue.teamId, ids);
  if (allowed.length === 0) return;
  const people = await ctx.tx
    .select({ id: users.id, preferences: users.preferences, ...pauseColumns })
    .from(users)
    .where(inArray(users.id, allowed));
  const prefs = new Map<string, UserPreferences['notifications']>(
    people.map((p) => [p.id, resolvePreferences(p.preferences).notifications]),
  );
  // A pause keeps the notification in the inbox but sends it nowhere else, now or later.
  const held = new Set(
    people
      .filter((p) => {
        const pause = pauseOf(p);
        return pause && !(pause.mode === 'mentions' && PAUSE_PASSES.includes(input.type));
      })
      .map((p) => p.id),
  );
  const now = new Date().toISOString();
  const recipients = allowed.filter((id) => prefs.get(id)?.inbox[input.type] !== false);
  if (recipients.length === 0) return;
  const reason = (userId: string): NotificationReason =>
    input.type === 'issue_mention'
      ? 'mention'
      : ASSIGNEE_TYPES.includes(input.type) || userId === issue.assigneeId
        ? 'assignee'
        : userId === issue.creatorId
          ? 'creator'
          : 'subscriber';
  const rows = await ctx.tx
    .insert(notifications)
    .values(
      recipients.map((userId) => ({
        workspaceId: ctx.workspaceId,
        userId,
        type: input.type,
        issueId: input.issueId,
        commentId: input.commentId ?? null,
        actorId: ctx.userId,
        data: { ...input.data, reason: reason(userId) },
        // Counts as handled for the email digest.
        emailedAt: held.has(userId) ? now : null,
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  if (!INBOX_ONLY_TYPES.includes(input.type)) {
    const on = (channel: 'push' | 'chat') =>
      rows.filter((r) => !held.has(r.userId) && prefs.get(r.userId)?.[channel][input.type]);
    await queueChatNotifications(ctx.tx, ctx.workspaceId, on('chat'));
    await queuePush(ctx.tx, on('push'));
  }
  for (const r of rows)
    emit(ctx, {
      kind: 'notification',
      action: 'created',
      id: r.id,
      userId: r.userId,
      issueId: input.issueId,
    });
}

/**
 * Every minute: snoozes that ran out end. Those notifications come back unread at the top of the
 * inbox, and their people's inboxes refresh.
 */
export async function wakeSnoozed(app: FastifyInstance) {
  const woken = await app.db.execute<{ id: string; user_id: string; workspace_id: string }>(sql`
    update notifications set snoozed_until = null, woke_at = now(), read_at = null
    where snoozed_until <= now()
    returning id, user_id, workspace_id`);
  await publishChanges(
    app,
    [...woken].map((n) => ({
      kind: 'notification' as const,
      action: 'updated' as const,
      id: n.id,
      workspaceId: n.workspace_id,
      userId: n.user_id,
    })),
  );
}
