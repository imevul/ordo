import { mergePlaceholderSchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { listPlaceholders, mergePlaceholder } from '../services/placeholders.ts';

/** People imports brought along who aren't members, managed by workspace admins. */
export async function placeholderRoutes(app: FastifyInstance) {
  app.get('/placeholders', async (req) => listPlaceholders(app.db, requireAdmin(req).id));

  app.post('/placeholders/:id/merge', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const { userId } = parse(mergePlaceholderSchema, req.body);
    return mutate(app, req, (ctx) => mergePlaceholder(ctx, id, userId));
  });
}
