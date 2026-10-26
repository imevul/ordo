import { createLabelSchema, updateLabelSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { labels, teams } from '../db/schema.ts';
import { badRequest, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { type Ctx, emit } from '../services/context.ts';
import { toLabel } from '../services/serialize.ts';

async function assertTeam(ctx: Ctx, teamId: string | null | undefined) {
  if (!teamId) return;
  const [t] = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!t) throw badRequest('Unknown team');
}

export async function labelRoutes(app: FastifyInstance) {
  app.post('/labels', async (req) => {
    const input = parse(createLabelSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await assertTeam(ctx, input.teamId);
      const [row] = await ctx.tx
        .insert(labels)
        .values({ ...input, teamId: input.teamId ?? null, workspaceId: ctx.workspaceId })
        .returning();
      emit(ctx, { kind: 'label', action: 'created', id: row!.id });
      return toLabel(row!);
    });
  });

  app.patch('/labels/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateLabelSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await assertTeam(ctx, input.teamId);
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
