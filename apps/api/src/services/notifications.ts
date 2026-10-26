import type { NotificationType } from '@ordo/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { issueSubscribers, notifications, workspaceMembers } from '../db/schema.ts';
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

/** Creates notifications for each recipient except the actor, skipping non-members. */
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
  const ids = [...new Set(input.userIds.filter((x): x is string => !!x && x !== ctx.userId))];
  if (ids.length === 0) return;
  const members = await ctx.tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, ctx.workspaceId), inArray(workspaceMembers.userId, ids)),
    );
  if (members.length === 0) return;
  const rows = await ctx.tx
    .insert(notifications)
    .values(
      members.map((m) => ({
        workspaceId: ctx.workspaceId,
        userId: m.userId,
        type: input.type,
        issueId: input.issueId,
        commentId: input.commentId ?? null,
        actorId: ctx.userId,
        data: input.data ?? {},
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  for (const r of rows)
    emit(ctx, {
      kind: 'notification',
      action: 'created',
      id: r.id,
      userId: r.userId,
      issueId: input.issueId,
    });
}
