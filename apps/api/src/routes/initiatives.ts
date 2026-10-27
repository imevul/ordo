import { createInitiativeSchema, updateInitiativeSchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  createInitiative,
  deleteInitiative,
  listInitiatives,
  updateInitiative,
} from '../services/initiatives.ts';

/** Initiatives; the web app gets the list with the bootstrap payload. */
export async function initiativeRoutes(app: FastifyInstance) {
  app.get('/initiatives', async (req) => listInitiatives(app.db, requireAccess(req)));

  app.post('/initiatives', async (req) => {
    const input = parse(createInitiativeSchema, req.body);
    return mutate(app, req, (ctx) => createInitiative(ctx, input));
  });

  app.patch('/initiatives/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateInitiativeSchema, req.body);
    return mutate(app, req, (ctx) => updateInitiative(ctx, id, input));
  });

  app.delete('/initiatives/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteInitiative(ctx, id));
    return { ok: true };
  });
}
