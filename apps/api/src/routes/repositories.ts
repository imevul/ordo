import { createRepositorySchema, updateRepositorySchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireWorkspace } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  createRepository,
  deleteRepository,
  listRepositories,
  updateRepository,
} from '../services/repositories.ts';

/** Repositories: everyone may list them (they're in the bootstrap too); admins manage them. */
export async function repositoryRoutes(app: FastifyInstance) {
  app.get('/repositories', async (req) => listRepositories(app.db, requireWorkspace(req).id));

  app.post('/repositories', async (req) => {
    requireAdmin(req);
    const input = parse(createRepositorySchema, req.body);
    return mutate(app, req, (ctx) => createRepository(ctx, input));
  });

  app.patch('/repositories/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const input = parse(updateRepositorySchema, req.body);
    return mutate(app, req, (ctx) => updateRepository(ctx, id, input));
  });

  app.delete('/repositories/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteRepository(ctx, id));
    return { ok: true };
  });
}
