import { createCycleSchema, updateCycleSchema } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { cycles, issues } from '../db/schema.ts';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { emit, record } from '../services/context.ts';
import { createCycle, listCycles, loadCycle, updateCycle } from '../services/cycles.ts';
import { bulkUpdateIssues } from '../services/issues.ts';
import { toCycle } from '../services/serialize.ts';

export async function cycleRoutes(app: FastifyInstance) {
  app.get('/cycles', async (req) => listCycles(app.db, requireAccess(req)));

  app.post('/teams/:teamId/cycles', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(createCycleSchema, req.body);
    return mutate(app, req, (ctx) => createCycle(ctx, teamId, input));
  });

  app.patch('/cycles/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateCycleSchema, req.body);
    return mutate(app, req, (ctx) => updateCycle(ctx, id, input));
  });

  app.delete('/cycles/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const cycle = await loadCycle(ctx, id);
      const inCycle = await ctx.tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.cycleId, id));
      await bulkUpdateIssues(
        ctx,
        inCycle.map((i) => i.id),
        { cycleId: null },
      );
      await ctx.tx.delete(cycles).where(eq(cycles.id, id));
      emit(ctx, { kind: 'cycle', action: 'deleted', id, teamId: cycle.teamId });
      record(ctx, 'cycle.deleted', toCycle(cycle), { teamIds: [cycle.teamId] });
      return { ok: true };
    });
  });
}
