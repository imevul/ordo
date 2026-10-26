import { type Comment, type CreateCommentInput, USERNAME_PATTERN } from '@ordo/shared';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { comments, issues, users, workspaceMembers } from '../db/schema.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { type Access, canReadTeam, usersWithTeamAccess } from './access.ts';
import { claimAttachments } from './attachments.ts';
import { type Ctx, emit, record } from './context.ts';
import { getIssue } from './issues.ts';
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
  return db
    .select()
    .from(comments)
    .where(eq(comments.issueId, issue.id))
    .orderBy(asc(comments.createdAt));
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
  return comment!;
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
  if (comment.authorId !== ctx.userId) throw forbidden('You can only edit your own comments');
  const now = new Date().toISOString();
  const [row] = await ctx.tx
    .update(comments)
    .set({ body, updatedAt: now, editedAt: now })
    .where(eq(comments.id, id))
    .returning();
  await claimAttachments(ctx, comment.issueId, body);
  emit(ctx, { kind: 'comment', action: 'updated', id, issueId: comment.issueId, teamId });
  record(ctx, 'comment.updated', { comment: publicComment(row!) }, { teamIds: [teamId] });
  return row!;
}

export async function deleteComment(ctx: Ctx, id: string) {
  const { comment, teamId } = await loadComment(ctx, id);
  if (comment.authorId !== ctx.userId && !ctx.access.isAdmin) {
    throw forbidden('You can only delete your own comments');
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
