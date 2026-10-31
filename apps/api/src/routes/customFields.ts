import { createCustomFieldSchema, updateCustomFieldSchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireWorkspace } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  updateCustomField,
} from '../services/customFields.ts';

export async function customFieldRoutes(app: FastifyInstance) {
  app.get('/custom-fields', async (req) => listCustomFields(app.db, requireWorkspace(req).access));

  app.post('/custom-fields', async (req) => {
    const input = parse(createCustomFieldSchema, req.body);
    return mutate(app, req, (ctx) => createCustomField(ctx, input));
  });

  app.patch('/custom-fields/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateCustomFieldSchema, req.body);
    return mutate(app, req, (ctx) => updateCustomField(ctx, id, input));
  });

  app.delete('/custom-fields/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await deleteCustomField(ctx, id);
      return { ok: true };
    });
  });
}
