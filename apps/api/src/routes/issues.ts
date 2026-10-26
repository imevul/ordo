import {
  batchDeleteIssuesSchema,
  batchUpdateIssuesSchema,
  createCommentSchema,
  createIssueSchema,
  createRelationSchema,
  issueFilterSchema,
  reactionEmojiSchema,
  updateCommentSchema,
  updateIssueSchema,
} from '@ordo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { issueHistory, issueSubscribers } from '../db/schema.ts';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { assertCan } from '../services/access.ts';
import {
  addReaction,
  createComment,
  deleteComment,
  listComments,
  removeReaction,
  updateComment,
} from '../services/comments.ts';
import { emit } from '../services/context.ts';
import {
  createIssue,
  getIssue,
  getIssueDetail,
  purgeIssue,
  queryIssues,
  trashIssue,
  updateIssue,
} from '../services/issues.ts';
import { subscribe } from '../services/notifications.ts';
import { createRelation, deleteRelation } from '../services/relations.ts';

// Thin HTTP layer: every service below scopes its reads and writes by the caller's access.
export async function issueRoutes(app: FastifyInstance) {
  const { db } = app;
  const resolveIssue = (req: FastifyRequest, id: string) => getIssue(db, requireAccess(req), id);

  app.post('/issues/query', async (req) => {
    const body = (req.body ?? {}) as { filter?: unknown; limit?: number };
    const filter = parse(issueFilterSchema, body.filter ?? {});
    const limit = Math.min(Math.max(Number(body.limit) || 2000, 1), 5000);
    return queryIssues(db, requireAccess(req), filter, limit);
  });

  app.get('/issues/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getIssueDetail(db, requireAccess(req), id);
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
    assertCan(
      requireAccess(req),
      'issues.purge',
      'Only workspace admins can delete issues permanently',
    );
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
    return mutate(app, req, (ctx) => createRelation(ctx, id, input));
  });

  app.delete('/relations/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteRelation(ctx, id));
    return { ok: true };
  });

  // ─── comments ────────────────────────────────────────────────────────

  app.get('/issues/:id/comments', async (req) => {
    const { id } = req.params as { id: string };
    return listComments(db, requireAccess(req), id);
  });

  app.post('/issues/:id/comments', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createCommentSchema, req.body);
    return mutate(app, req, (ctx) => createComment(ctx, id, input));
  });

  app.patch('/comments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { body } = parse(updateCommentSchema, req.body);
    return mutate(app, req, (ctx) => updateComment(ctx, id, body));
  });

  app.delete('/comments/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteComment(ctx, id));
    return { ok: true };
  });

  // The emoji is URL-encoded in the path; both calls return the comment's reactions.
  app.put('/comments/:id/reactions/:emoji', async (req) => {
    const { id, emoji } = req.params as { id: string; emoji: string };
    const valid = parse(reactionEmojiSchema, emoji);
    return mutate(app, req, (ctx) => addReaction(ctx, id, valid));
  });

  app.delete('/comments/:id/reactions/:emoji', async (req) => {
    const { id, emoji } = req.params as { id: string; emoji: string };
    return mutate(app, req, (ctx) => removeReaction(ctx, id, emoji));
  });
}
