import type { NotificationType } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import { issueSubscribers, issues, notifications } from '../db/schema.ts';
import { usersWithTeamAccess } from './access.ts';
import { queueChatNotifications } from './chat.ts';
import { type Ctx, emit } from './context.ts';

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

/**
 * Creates notifications for each recipient except the actor, skipping anyone who can't see the
 * issue's team (non-members, guests outside it, members of the workspace outside a private team).
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
    .select({ teamId: issues.teamId })
    .from(issues)
    .where(eq(issues.id, input.issueId));
  if (!issue) return;
  const recipients = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, issue.teamId, ids);
  if (recipients.length === 0) return;
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
        data: input.data ?? {},
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  // Reactions are too small for a direct message; they wait in the inbox.
  if (input.type !== 'comment_reaction') {
    await queueChatNotifications(ctx.tx, ctx.workspaceId, rows);
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
