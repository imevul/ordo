import {
  type Comment,
  type CommentReaction,
  type CreateCommentInput,
  MAX_REACTION_KINDS,
  USERNAME_PATTERN,
} from '@ordo/shared';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  commentReactions,
  comments,
  issues,
  notifications,
  users,
  workspaceMembers,
} from '../db/schema.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { type Access, canReadTeam, teamScope, usersWithTeamAccess } from './access.ts';
import { onComment } from './agents.ts';
import { claimAttachments } from './attachments.ts';
import { type Ctx, emit, record } from './context.ts';
import { getIssue, retriedCreate } from './issues.ts';
import { notify, subscribe, subscriberIds } from './notifications.ts';

const MENTION_RE = /(?:^|[\s(])@([a-z0-9._-]{2,32})/g;

/** Usernames mentioned as @username in a comment body. */
export function extractMentions(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) if (USERNAME_PATTERN.test(m[1]!)) names.add(m[1]!);
  return [...names];
}

/** Mentioned workspace members who can see the issue's team; anyone else is silently ignored. */
async function mentionedUserIds(ctx: Ctx, teamId: string, body: string) {
  const names = extractMentions(body);
  if (names.length === 0) return [];
  const rows = await ctx.tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, ctx.workspaceId)),
    )
    .where(inArray(users.username, names));
  return usersWithTeamAccess(
    ctx.tx,
    ctx.workspaceId,
    teamId,
    rows.map((r) => r.id),
  );
}

export async function listComments(
  db: DbOrTx,
  access: Access,
  issueIdOrIdentifier: string,
): Promise<Comment[]> {
  const issue = await getIssue(db, access, issueIdOrIdentifier);
  const rows = await db
    .select()
    .from(comments)
    .where(eq(comments.issueId, issue.id))
    .orderBy(asc(comments.createdAt));
  return withReactions(db, rows);
}

/** The given comments, on issues `access` can see (not trashed or archived); for sync clients. */
export async function commentsByIds(db: DbOrTx, access: Access, ids: string[]): Promise<Comment[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ comment: comments })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(
      and(
        inArray(comments.id, ids),
        eq(issues.workspaceId, access.workspaceId),
        teamScope(access, issues.teamId),
        isNull(issues.deletedAt),
        isNull(issues.archivedAt),
      ),
    );
  return withReactions(
    db,
    rows.map((r) => r.comment),
  );
}

/** Reactions per comment, grouped by emoji in the order each was first used. */
export async function reactionsFor(db: DbOrTx, commentIds: string[]) {
  const byComment = new Map<string, CommentReaction[]>();
  if (commentIds.length === 0) return byComment;
  const rows = await db
    .select()
    .from(commentReactions)
    .where(inArray(commentReactions.commentId, commentIds))
    .orderBy(asc(commentReactions.createdAt));
  for (const r of rows) {
    const list = byComment.get(r.commentId) ?? [];
    const group = list.find((g) => g.emoji === r.emoji);
    if (group) group.userIds.push(r.userId);
    else list.push({ emoji: r.emoji, userIds: [r.userId] });
    byComment.set(r.commentId, list);
  }
  return byComment;
}

async function withReactions(
  db: DbOrTx,
  rows: (typeof comments.$inferSelect)[],
): Promise<Comment[]> {
  const reactions = await reactionsFor(
    db,
    rows.map((c) => c.id),
  );
  return rows.map((c) => ({ ...c, reactions: reactions.get(c.id) ?? [] }));
}

/**
 * Comments on an issue. Imports pass `imported` to keep the source's author and date; the issue
 * then keeps its own updated time, and the importer isn't subscribed.
 */
export async function createComment(
  ctx: Ctx,
  issueIdOrIdentifier: string,
  input: CreateCommentInput,
  imported?: { authorId: string | null; createdAt?: string },
) {
  const authorId = imported ? imported.authorId : ctx.userId;
  const issue = await getIssue(ctx.tx, ctx.access, issueIdOrIdentifier);
  if (input.id && (await retriedCreate(ctx, comments, input.id, comments.authorId))) {
    const [again] = await commentsByIds(ctx.tx, ctx.access, [input.id]);
    if (again) return again;
  }
  if (input.parentId) {
    const [parent] = await ctx.tx
      .select({ issueId: comments.issueId })
      .from(comments)
      .where(eq(comments.id, input.parentId));
    if (parent?.issueId !== issue.id) throw badRequest('Reply must belong to the same issue');
  }
  const [comment] = await ctx.tx
    .insert(comments)
    .values({
      ...(input.id && { id: input.id }),
      issueId: issue.id,
      authorId,
      body: input.body,
      parentId: input.parentId ?? null,
      createdAt: imported?.createdAt,
      updatedAt: imported?.createdAt,
    })
    .returning();
  await claimAttachments(ctx, issue.id, input.body);
  const mentioned = await mentionedUserIds(ctx, issue.teamId, input.body);
  const subscribers = await subscriberIds(ctx, issue.id);
  await subscribe(ctx, issue.id, [authorId, ...mentioned]);
  await notify(ctx, {
    userIds: mentioned,
    type: 'issue_mention',
    issueId: issue.id,
    commentId: comment!.id,
  });
  await notify(ctx, {
    userIds: subscribers.filter((s) => !mentioned.includes(s)),
    type: 'issue_comment',
    issueId: issue.id,
    commentId: comment!.id,
  });
  if (!imported) {
    await ctx.tx
      .update(issues)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(issues.id, issue.id));
  }
  emit(ctx, {
    kind: 'comment',
    action: 'created',
    id: comment!.id,
    issueId: issue.id,
    teamId: issue.teamId,
  });
  record(
    ctx,
    'comment.created',
    {
      comment: publicComment(comment!),
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
    },
    { teamIds: [issue.teamId] },
  );
  // A person's reply answers an agent that's waiting on this issue.
  if (!imported) await onComment(ctx, issue.id, authorId);
  return { ...comment!, reactions: [] } satisfies Comment;
}

/** A comment on an issue the caller can read. */
async function loadComment(ctx: Ctx, id: string) {
  const [row] = await ctx.tx
    .select({ comment: comments, workspaceId: issues.workspaceId, teamId: issues.teamId })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(comments.id, id));
  if (!row || row.workspaceId !== ctx.workspaceId || !canReadTeam(ctx.access, row.teamId)) {
    throw notFound('Comment');
  }
  return row;
}

export async function updateComment(ctx: Ctx, id: string, body: string) {
  const { comment, teamId } = await loadComment(ctx, id);
  if (comment.authorId !== ctx.userId)
    throw forbidden('You can only edit your own comments').as('own_comments_edit');
  const now = new Date().toISOString();
  const [row] = await ctx.tx
    .update(comments)
    .set({ body, updatedAt: now, editedAt: now })
    .where(eq(comments.id, id))
    .returning();
  await claimAttachments(ctx, comment.issueId, body);
  emit(ctx, { kind: 'comment', action: 'updated', id, issueId: comment.issueId, teamId });
  record(ctx, 'comment.updated', { comment: publicComment(row!) }, { teamIds: [teamId] });
  return (await withReactions(ctx.tx, [row!]))[0]!;
}

/** Adds the caller's reaction (idempotent) and tells the comment's author in their inbox. */
export async function addReaction(ctx: Ctx, commentId: string, emoji: string) {
  const { comment, teamId } = await loadComment(ctx, commentId);
  const kinds = await ctx.tx
    .selectDistinct({ emoji: commentReactions.emoji })
    .from(commentReactions)
    .where(eq(commentReactions.commentId, commentId));
  if (kinds.length >= MAX_REACTION_KINDS && !kinds.some((k) => k.emoji === emoji)) {
    throw badRequest(`A comment can have at most ${MAX_REACTION_KINDS} different reactions`).as(
      'max_reactions',
      { max: MAX_REACTION_KINDS },
    );
  }
  const [row] = await ctx.tx
    .insert(commentReactions)
    .values({ commentId, userId: ctx.userId, emoji })
    .onConflictDoNothing()
    .returning();
  if (row) {
    await notify(ctx, {
      userIds: [comment.authorId],
      type: 'comment_reaction',
      issueId: comment.issueId,
      commentId,
      data: { emoji },
    });
    emit(ctx, {
      kind: 'comment',
      action: 'updated',
      id: commentId,
      issueId: comment.issueId,
      teamId,
    });
    record(
      ctx,
      'reaction.created',
      { reaction: { commentId, issueId: comment.issueId, userId: ctx.userId, emoji } },
      { teamIds: [teamId] },
    );
  }
  return (await reactionsFor(ctx.tx, [commentId])).get(commentId) ?? [];
}

export async function removeReaction(ctx: Ctx, commentId: string, emoji: string) {
  const { comment, teamId } = await loadComment(ctx, commentId);
  const [row] = await ctx.tx
    .delete(commentReactions)
    .where(
      and(
        eq(commentReactions.commentId, commentId),
        eq(commentReactions.userId, ctx.userId),
        eq(commentReactions.emoji, emoji),
      ),
    )
    .returning();
  if (row) {
    // A reaction taken back before it was seen isn't news.
    const gone = await ctx.tx
      .delete(notifications)
      .where(
        and(
          eq(notifications.commentId, commentId),
          eq(notifications.type, 'comment_reaction'),
          eq(notifications.actorId, ctx.userId),
          isNull(notifications.readAt),
          sql`${notifications.data}->>'emoji' = ${emoji}`,
        ),
      )
      .returning({ id: notifications.id, userId: notifications.userId });
    for (const n of gone) {
      emit(ctx, { kind: 'notification', action: 'deleted', id: n.id, userId: n.userId });
    }
    emit(ctx, {
      kind: 'comment',
      action: 'updated',
      id: commentId,
      issueId: comment.issueId,
      teamId,
    });
    record(
      ctx,
      'reaction.deleted',
      { reaction: { commentId, issueId: comment.issueId, userId: ctx.userId, emoji } },
      { teamIds: [teamId] },
    );
  }
  return (await reactionsFor(ctx.tx, [commentId])).get(commentId) ?? [];
}

export async function deleteComment(ctx: Ctx, id: string) {
  const { comment, teamId } = await loadComment(ctx, id);
  if (comment.authorId !== ctx.userId && !ctx.access.isAdmin) {
    throw forbidden('You can only delete your own comments').as('own_comments_delete');
  }
  await ctx.tx.delete(comments).where(or(eq(comments.id, id), eq(comments.parentId, id)));
  emit(ctx, { kind: 'comment', action: 'deleted', id, issueId: comment.issueId, teamId });
  record(
    ctx,
    'comment.deleted',
    { comment: { id, issueId: comment.issueId } },
    { teamIds: [teamId] },
  );
}

const publicComment = (c: typeof comments.$inferSelect) => ({
  id: c.id,
  issueId: c.issueId,
  authorId: c.authorId,
  parentId: c.parentId,
  body: c.body,
  createdAt: c.createdAt,
  editedAt: c.editedAt,
});
