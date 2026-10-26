import { createLabelSchema, updateLabelSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { labels, teams } from '../db/schema.ts';
import { badRequest, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { assertCan, canReadTeam } from '../services/access.ts';
import { type Ctx, emit } from '../services/context.ts';
import { toLabel } from '../services/serialize.ts';

/** Labels are managed by everyone but guests; team labels only by people who can see the team. */
async function assertTeam(ctx: Ctx, teamId: string | null | undefined) {
  assertCan(ctx.access, 'labels.create', 'Guests cannot manage labels');
  if (!teamId) return;
  const [t] = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!t || !canReadTeam(ctx.access, t.id)) throw badRequest('Unknown team');
}

async function loadLabel(ctx: Ctx, id: string) {
  const [label] = await ctx.tx
    .select()
    .from(labels)
    .where(and(eq(labels.id, id), eq(labels.workspaceId, ctx.workspaceId)));
  if (!label || (label.teamId && !canReadTeam(ctx.access, label.teamId))) throw notFound('Label');
  await assertTeam(ctx, label.teamId);
  return label;
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
      await loadLabel(ctx, id);
      if (input.teamId !== undefined) await assertTeam(ctx, input.teamId);
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
