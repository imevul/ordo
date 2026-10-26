import { createViewSchema, DEFAULT_ISSUE_DISPLAY, updateViewSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { views } from '../db/schema.ts';
import { requireWorkspace } from '../lib/auth.ts';
import { forbidden, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { type Ctx, emit } from '../services/context.ts';
import { toView } from '../services/serialize.ts';

async function loadEditableView(ctx: Ctx, id: string, isAdmin: boolean) {
  const [view] = await ctx.tx
    .select()
    .from(views)
    .where(and(eq(views.id, id), eq(views.workspaceId, ctx.workspaceId)));
  if (!view || (!view.shared && view.ownerId !== ctx.userId)) throw notFound('View');
  if (view.ownerId !== ctx.userId && !isAdmin)
    throw forbidden('Only the owner or an admin can change this view');
  return view;
}

export async function viewRoutes(app: FastifyInstance) {
  app.post('/views', async (req) => {
    const input = parse(createViewSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .insert(views)
        .values({
          workspaceId: ctx.workspaceId,
          ownerId: ctx.userId,
          name: input.name,
          description: input.description ?? null,
          teamId: input.teamId ?? null,
          shared: input.shared,
          filters: input.filters,
          display: input.display ?? DEFAULT_ISSUE_DISPLAY,
        })
        .returning();
      emit(ctx, { kind: 'view', action: 'created', id: row!.id });
      return toView(row!);
    });
  });

  app.patch('/views/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateViewSchema, req.body);
    const isAdmin = requireWorkspace(req).role === 'admin';
    return mutate(app, req, async (ctx) => {
      await loadEditableView(ctx, id, isAdmin);
      const [row] = await ctx.tx
        .update(views)
        .set({ ...input, updatedAt: new Date().toISOString() })
        .where(eq(views.id, id))
        .returning();
      emit(ctx, { kind: 'view', action: 'updated', id });
      return toView(row!);
    });
  });

  app.delete('/views/:id', async (req) => {
    const { id } = req.params as { id: string };
    const isAdmin = requireWorkspace(req).role === 'admin';
    return mutate(app, req, async (ctx) => {
      await loadEditableView(ctx, id, isAdmin);
      await ctx.tx.delete(views).where(eq(views.id, id));
      emit(ctx, { kind: 'view', action: 'deleted', id });
      return { ok: true };
    });
  });
}
