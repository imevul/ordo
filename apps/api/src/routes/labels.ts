import { createLabelSchema, updateLabelSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { labels } from '../db/schema.ts';
import { notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { canReadTeam } from '../services/access.ts';
import { type Ctx, emit } from '../services/context.ts';
import { assertLabelTeam, createLabel } from '../services/labels.ts';
import { toLabel } from '../services/serialize.ts';

async function loadLabel(ctx: Ctx, id: string) {
  const [label] = await ctx.tx
    .select()
    .from(labels)
    .where(and(eq(labels.id, id), eq(labels.workspaceId, ctx.workspaceId)));
  if (!label || (label.teamId && !canReadTeam(ctx.access, label.teamId))) throw notFound('Label');
  await assertLabelTeam(ctx, label.teamId);
  return label;
}

export async function labelRoutes(app: FastifyInstance) {
  app.post('/labels', async (req) => {
    const input = parse(createLabelSchema, req.body);
    return mutate(app, req, (ctx) => createLabel(ctx, input));
  });

  app.patch('/labels/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateLabelSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await loadLabel(ctx, id);
      if (input.teamId !== undefined) await assertLabelTeam(ctx, input.teamId);
      const [row] = await ctx.tx
        .update(labels)
        .set(input)
        .where(and(eq(labels.id, id), eq(labels.workspaceId, ctx.workspaceId)))
        .returning();
      if (!row) throw notFound('Label');
      emit(ctx, { kind: 'label', action: 'updated', id });
      return toLabel(row);
    });
  });

  app.delete('/labels/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await loadLabel(ctx, id);
      const [row] = await ctx.tx
        .delete(labels)
        .where(and(eq(labels.id, id), eq(labels.workspaceId, ctx.workspaceId)))
        .returning({ id: labels.id });
      if (!row) throw notFound('Label');
      emit(ctx, { kind: 'label', action: 'deleted', id });
      emit(ctx, { kind: 'issue', action: 'updated', id });
      return { ok: true };
    });
  });
}
