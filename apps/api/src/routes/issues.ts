import {
  batchDeleteIssuesSchema,
  batchUpdateIssuesSchema,
  createCommentSchema,
  createIssueSchema,
  createRelationSchema,
  issueFilterSchema,
  USERNAME_PATTERN,
  updateCommentSchema,
  updateIssueSchema,
} from '@ordo/shared';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  comments,
  issueHistory,
  issueRelations,
  issueSubscribers,
  issues,
  users,
  workflowStates,
  workspaceMembers,
} from '../db/schema.ts';
import { requireAdmin, requireUser, requireWorkspace } from '../lib/auth.ts';
import { badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { type Ctx, emit } from '../services/context.ts';
import {
  createIssue,
  getIssue,
  getIssueDetail,
  purgeIssue,
  queryIssues,
  trashIssue,
  updateIssue,
} from '../services/issues.ts';
import { notify, subscribe, subscriberIds } from '../services/notifications.ts';

const MENTION_RE = /(?:^|[\s(])@([a-z0-9._-]{2,32})/g;

/** Usernames mentioned as @username in a comment body. */
export function extractMentions(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) if (USERNAME_PATTERN.test(m[1]!)) names.add(m[1]!);
  return [...names];
}

async function mentionedUserIds(ctx: Ctx, body: string) {
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
  return rows.map((r) => r.id);
}

export async function issueRoutes(app: FastifyInstance) {
  const { db } = app;
  const resolveIssue = async (req: { workspace: { id: string } | null }, id: string) =>
    getIssue(db, req.workspace!.id, id);

  app.post('/issues/query', async (req) => {
    const body = (req.body ?? {}) as { filter?: unknown; limit?: number };
    const filter = parse(issueFilterSchema, body.filter ?? {});
    const limit = Math.min(Math.max(Number(body.limit) || 2000, 1), 5000);
    return queryIssues(db, requireWorkspace(req).id, requireUser(req).id, filter, limit);
  });

  app.get('/issues/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getIssueDetail(db, requireWorkspace(req).id, requireUser(req).id, id);
  });

  app.post('/issues', async (req) => {
    const input = parse(createIssueSchema, req.body);
    return mutate(app, req, (ctx) => createIssue(ctx, input));
  });

  app.patch('/issues/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = parse(updateIssueSchema, req.body);
    const issue = await resolveIssue(req, id);
    return mutate(app, req, (ctx) => updateIssue(ctx, issue.id, patch));
  });

  app.post('/issues/batch', async (req) => {
    const { ids, patch } = parse(batchUpdateIssuesSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const out = [];
      for (const id of ids) out.push(await updateIssue(ctx, id, patch));
      return out;
    });
  });

  app.post('/issues/batch-delete', async (req) => {
    const { ids } = parse(batchDeleteIssuesSchema, req.body);
    return mutate(app, req, async (ctx) => {
      for (const id of ids) await trashIssue(ctx, id);
      return { ok: true };
    });
  });

  app.delete('/issues/:id', async (req) => {
    const { id } = req.params as { id: string };
    const issue = await resolveIssue(req, id);
    await mutate(app, req, (ctx) => trashIssue(ctx, issue.id));
    return { ok: true };
  });

  app.post('/issues/:id/restore', async (req) => {
    const { id } = req.params as { id: string };
    const issue = await resolveIssue(req, id);
    await mutate(app, req, (ctx) => trashIssue(ctx, issue.id, true));
    return { ok: true };
  });

  app.delete('/issues/:id/purge', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const issue = await resolveIssue(req, id);
    await mutate(app, req, (ctx) => purgeIssue(ctx, issue.id));
    return { ok: true };
  });

  app.get('/issues/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    const issue = await resolveIssue(req, id);
    return db
      .select()
      .from(issueHistory)
      .where(eq(issueHistory.issueId, issue.id))
      .orderBy(asc(issueHistory.createdAt));
  });

  // ─── subscriptions ───────────────────────────────────────────────────

  app.post('/issues/:id/subscription', async (req) => {
    const { id } = req.params as { id: string };
    const issue = await resolveIssue(req, id);
    return mutate(app, req, async (ctx) => {
      await subscribe(ctx, issue.id, [ctx.userId]);
      emit(ctx, { kind: 'issue', action: 'updated', id: issue.id, teamId: issue.teamId });
      return { ok: true };
    });
  });

  app.delete('/issues/:id/subscription', async (req) => {
    const { id } = req.params as { id: string };
    const issue = await resolveIssue(req, id);
    return mutate(app, req, async (ctx) => {
      await ctx.tx
        .delete(issueSubscribers)
        .where(
          and(eq(issueSubscribers.issueId, issue.id), eq(issueSubscribers.userId, ctx.userId)),
        );
      emit(ctx, { kind: 'issue', action: 'updated', id: issue.id, teamId: issue.teamId });
      return { ok: true };
    });
  });

  // ─── relations ───────────────────────────────────────────────────────

  app.post('/issues/:id/relations', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createRelationSchema, req.body);
    const issue = await resolveIssue(req, id);
    const other = await resolveIssue(req, input.relatedIssueId);
    if (issue.id === other.id) throw badRequest('An issue cannot relate to itself');
    return mutate(app, req, async (ctx) => {
      const [from, to] = input.type === 'blocked_by' ? [other, issue] : [issue, other];
      const type =
        input.type === 'blocked_by'
          ? 'blocks'
          : input.type === 'duplicate_of'
            ? 'duplicate'
            : input.type;
      const existing = await ctx.tx
        .select({ id: issueRelations.id })
        .from(issueRelations)
        .where(
          or(
            and(eq(issueRelations.issueId, from.id), eq(issueRelations.relatedIssueId, to.id)),
            and(eq(issueRelations.issueId, to.id), eq(issueRelations.relatedIssueId, from.id)),
          ),
        );
      if (existing.length)
        await ctx.tx.delete(issueRelations).where(
          inArray(
            issueRelations.id,
            existing.map((e) => e.id),
          ),
        );
      const [row] = await ctx.tx
        .insert(issueRelations)
        .values({ issueId: from.id, relatedIssueId: to.id, type, createdBy: ctx.userId })
        .returning();
      // Marking a duplicate closes it, like Linear does.
      if (type === 'duplicate') {
        const states = await ctx.tx
          .select()
          .from(workflowStates)
          .where(and(eq(workflowStates.teamId, issue.teamId), eq(workflowStates.type, 'canceled')))
          .orderBy(asc(workflowStates.position));
        const target = states.find((s) => s.name.toLowerCase() === 'duplicate') ?? states[0];
        if (target && target.id !== issue.stateId)
          await updateIssue(ctx, issue.id, { stateId: target.id });
      }
      emit(ctx, { kind: 'issue', action: 'updated', id: issue.id, teamId: issue.teamId });
      emit(ctx, { kind: 'issue', action: 'updated', id: other.id, teamId: other.teamId });
      return row;
    });
  });

  app.delete('/relations/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .select({ rel: issueRelations, workspaceId: issues.workspaceId, teamId: issues.teamId })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.issueId))
        .where(eq(issueRelations.id, id));
      if (!row || row.workspaceId !== ctx.workspaceId) throw notFound('Relation');
      await ctx.tx.delete(issueRelations).where(eq(issueRelations.id, id));
      emit(ctx, { kind: 'issue', action: 'updated', id: row.rel.issueId, teamId: row.teamId });
      emit(ctx, { kind: 'issue', action: 'updated', id: row.rel.relatedIssueId });
      return { ok: true };
    });
  });

  // ─── comments ────────────────────────────────────────────────────────

  app.get('/issues/:id/comments', async (req) => {
    const { id } = req.params as { id: string };
    const issue = await resolveIssue(req, id);
    return db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue.id))
      .orderBy(asc(comments.createdAt));
  });

  app.post('/issues/:id/comments', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createCommentSchema, req.body);
    const issue = await resolveIssue(req, id);
    return mutate(app, req, async (ctx) => {
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
          authorId: ctx.userId,
          body: input.body,
          parentId: input.parentId ?? null,
        })
        .returning();
      const mentioned = await mentionedUserIds(ctx, input.body);
      const subscribers = await subscriberIds(ctx, issue.id);
      await subscribe(ctx, issue.id, [ctx.userId, ...mentioned]);
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
      await ctx.tx
        .update(issues)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(issues.id, issue.id));
      emit(ctx, {
        kind: 'comment',
        action: 'created',
        id: comment!.id,
        issueId: issue.id,
        teamId: issue.teamId,
      });
      return comment;
    });
  });

  const loadComment = async (ctx: Ctx, id: string) => {
    const [row] = await ctx.tx
      .select({ comment: comments, workspaceId: issues.workspaceId, teamId: issues.teamId })
      .from(comments)
      .innerJoin(issues, eq(issues.id, comments.issueId))
      .where(eq(comments.id, id));
    if (!row || row.workspaceId !== ctx.workspaceId) throw notFound('Comment');
    return row;
  };

  app.patch('/comments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { body } = parse(updateCommentSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const { comment, teamId } = await loadComment(ctx, id);
      if (comment.authorId !== ctx.userId) throw forbidden('You can only edit your own comments');
      const now = new Date().toISOString();
      const [row] = await ctx.tx
        .update(comments)
        .set({ body, updatedAt: now, editedAt: now })
        .where(eq(comments.id, id))
        .returning();
      emit(ctx, { kind: 'comment', action: 'updated', id, issueId: comment.issueId, teamId });
      return row;
    });
  });

  app.delete('/comments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const ws = requireWorkspace(req);
    return mutate(app, req, async (ctx) => {
      const { comment, teamId } = await loadComment(ctx, id);
      if (comment.authorId !== ctx.userId && ws.role !== 'admin')
        throw forbidden('You can only delete your own comments');
      await ctx.tx.delete(comments).where(or(eq(comments.id, id), eq(comments.parentId, id)));
      emit(ctx, { kind: 'comment', action: 'deleted', id, issueId: comment.issueId, teamId });
      return { ok: true };
    });
  });
}
