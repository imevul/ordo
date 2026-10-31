import {
  addReleaseIssuesSchema,
  createReleaseSchema,
  releaseMarkdown,
  releaseReleaseSchema,
  updateReleaseSchema,
} from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  addReleaseIssues,
  createRelease,
  deleteRelease,
  draftNotes,
  getRelease,
  listReleases,
  releaseRelease,
  releaseSuggestions,
  reopenRelease,
  updateRelease,
} from '../services/releases.ts';

export async function releaseRoutes(app: FastifyInstance) {
  app.get('/releases', async (req) => listReleases(app.db, requireAccess(req)));

  app.post('/releases', async (req) => {
    const input = parse(createReleaseSchema, req.body);
    return mutate(app, req, (ctx) => createRelease(ctx, input));
  });

  app.get('/releases/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getRelease(app.db, requireAccess(req), id);
  });

  app.patch('/releases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateReleaseSchema, req.body);
    return mutate(app, req, (ctx) => updateRelease(ctx, id, input));
  });

  app.delete('/releases/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await deleteRelease(ctx, id);
      return { ok: true };
    });
  });

  /** Done issues that came after the previous release, not in one yet. */
  app.get('/releases/:id/suggestions', async (req) => {
    const { id } = req.params as { id: string };
    return releaseSuggestions(app.db, requireAccess(req), id);
  });

  /** Adds issues to the release, as many as its suggestions in one request. */
  app.post('/releases/:id/issues', async (req) => {
    const { id } = req.params as { id: string };
    const { ids } = parse(addReleaseIssuesSchema, req.body);
    return mutate(app, req, async (ctx) => ({ ids: await addReleaseIssues(ctx, id, ids) }));
  });

  /** Notes drafted from the release's issues, without saving them. */
  app.post('/releases/:id/draft', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => ({ notes: await draftNotes(ctx, id) }));
  });

  app.post('/releases/:id/release', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(releaseReleaseSchema, req.body ?? {});
    return mutate(app, req, (ctx) => releaseRelease(ctx, id, input));
  });

  app.post('/releases/:id/reopen', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => reopenRelease(ctx, id));
  });

  /** The notes as a Markdown file. */
  app.get('/releases/:id/notes.md', async (req, reply) => {
    const { id } = req.params as { id: string };
    const release = await getRelease(app.db, requireAccess(req), id);
    const file = `${release.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'release'}.md`;
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file}"`)
      .send(releaseMarkdown({ ...release, notes: release.notes ?? '' }));
  });
}
