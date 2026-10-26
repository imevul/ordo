import { createCycleSchema, updateCycleSchema } from '@ordo/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { cycles, issues, teams } from '../db/schema.ts';
import { requireAccess } from '../lib/auth.ts';
import { badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { assertTeamAccess, canReadTeam } from '../services/access.ts';
import { type Ctx, emit } from '../services/context.ts';
import { listCycles } from '../services/cycles.ts';
import { toCycle } from '../services/serialize.ts';

/** Cycles are planned by the team: anyone who can read the team, except guests. */
function assertCanPlan(ctx: Ctx, teamId: string) {
  assertTeamAccess(ctx.access, teamId);
  if (ctx.access.isGuest) throw forbidden('Guests cannot manage cycles');
}

export async function cycleRoutes(app: FastifyInstance) {
  app.get('/cycles', async (req) => listCycles(app.db, requireAccess(req)));

  app.post('/teams/:teamId/cycles', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(createCycleSchema, req.body);
    return mutate(app, req, async (ctx) => {
      assertCanPlan(ctx, teamId);
      const [team] = await ctx.tx
        .update(teams)
        .set({ cycleCounter: sql`${teams.cycleCounter} + 1` })
        .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)))
        .returning({ counter: teams.cycleCounter });
      if (!team) throw notFound('Team');
      const [cycle] = await ctx.tx
        .insert(cycles)
        .values({ teamId, number: team.counter, ...input })
        .returning();
      emit(ctx, { kind: 'cycle', action: 'created', id: cycle!.id, teamId });
      return toCycle(cycle!);
    });
  });

  const loadCycle = async (ctx: Ctx, id: string) => {
    const [row] = await ctx.tx
      .select({ cycle: cycles })
      .from(cycles)
      .innerJoin(teams, eq(teams.id, cycles.teamId))
      .where(and(eq(cycles.id, id), eq(teams.workspaceId, ctx.workspaceId)));
    if (!row || !canReadTeam(ctx.access, row.cycle.teamId)) throw notFound('Cycle');
    assertCanPlan(ctx, row.cycle.teamId);
    return row.cycle;
  };

  app.patch('/cycles/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateCycleSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const cycle = await loadCycle(ctx, id);
      const next = { ...cycle, ...input };
      if (next.endsAt <= next.startsAt) throw badRequest('End date must be after start date');
      const [row] = await ctx.tx.update(cycles).set(input).where(eq(cycles.id, id)).returning();
      emit(ctx, { kind: 'cycle', action: 'updated', id, teamId: cycle.teamId });
      return toCycle(row!);
    });
  });

  app.delete('/cycles/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const cycle = await loadCycle(ctx, id);
      await ctx.tx.update(issues).set({ cycleId: null }).where(eq(issues.cycleId, id));
      await ctx.tx.delete(cycles).where(eq(cycles.id, id));
      emit(ctx, { kind: 'cycle', action: 'deleted', id, teamId: cycle.teamId });
      emit(ctx, { kind: 'issue', action: 'updated', id, teamId: cycle.teamId });
      return { ok: true };
    });
  });
}
