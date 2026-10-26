import { createTemplateSchema, updateTemplateSchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from '../services/templates.ts';

/** Issue templates; the web app gets the list with the bootstrap payload. */
export async function templateRoutes(app: FastifyInstance) {
  app.get('/templates', async (req) => listTemplates(app.db, requireAccess(req)));

  app.post('/templates', async (req) => {
    const input = parse(createTemplateSchema, req.body);
    return mutate(app, req, (ctx) => createTemplate(ctx, input));
  });

  app.patch('/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateTemplateSchema, req.body);
    return mutate(app, req, (ctx) => updateTemplate(ctx, id, input));
  });

  app.delete('/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteTemplate(ctx, id));
    return { ok: true };
  });
}
