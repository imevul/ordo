import {
  createRecurringSchema,
  createTemplateSchema,
  updateRecurringSchema,
  updateTemplateSchema,
} from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  createRecurring,
  deleteRecurring,
  listRecurring,
  updateRecurring,
} from '../services/recurring.ts';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from '../services/templates.ts';

/** Issue templates; the web app gets the list with the bootstrap payload. */
export async function templateRoutes(app: FastifyInstance) {
  app.get('/templates', async (req) => listTemplates(app.db, requireAccess(req)));

  app.get('/recurring', async (req) => listRecurring(app.db, requireAccess(req)));

  app.post('/recurring', async (req) => {
    const input = parse(createRecurringSchema, req.body);
    return mutate(app, req, (ctx) => createRecurring(ctx, input));
  });

  app.patch('/recurring/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateRecurringSchema, req.body);
    return mutate(app, req, (ctx) => updateRecurring(ctx, id, input));
  });

  app.delete('/recurring/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteRecurring(ctx, id));
    return { ok: true };
  });

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
