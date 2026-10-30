import type { CreateCycleInput, Cycle } from '@ordo/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { cycles, teams } from '../db/schema.ts';
import { forbidden, notFound, one } from '../lib/errors.ts';
import { type Access, assertTeamAccess, teamScope } from './access.ts';
import { type Ctx, emit, record } from './context.ts';
import { progressBy } from './progress.ts';
import { toCycle } from './serialize.ts';

/** Cycles are planned by the team: anyone who can read the team, except guests. */
export function assertCanPlan(ctx: Ctx, teamId: string) {
  assertTeamAccess(ctx.access, teamId);
  if (ctx.access.isGuest) throw forbidden('Guests cannot manage cycles').as('guests_cycles');
}

export async function createCycle(
  ctx: Ctx,
  teamId: string,
  input: CreateCycleInput,
): Promise<Cycle> {
  assertCanPlan(ctx, teamId);
  const [team] = await ctx.tx
    .update(teams)
    .set({ cycleCounter: sql`${teams.cycleCounter} + 1` })
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)))
    .returning({ counter: teams.cycleCounter });
  if (!team) throw notFound('Team');
  const cycle = one(
    await ctx.tx
      .insert(cycles)
      .values({ teamId, number: team.counter, ...input })
      .returning(),
  );
  emit(ctx, { kind: 'cycle', action: 'created', id: cycle.id, teamId });
  record(ctx, 'cycle.created', toCycle(cycle), { teamIds: [teamId] });
  return toCycle(cycle);
}

/** Cycles of the teams `access` can see. */
export async function listCycles(db: DbOrTx, access: Access): Promise<Cycle[]> {
  const teamIds = (
    await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.workspaceId, access.workspaceId), teamScope(access, teams.id)))
  ).map((t) => t.id);
  if (teamIds.length === 0) return [];
  const [rows, progress] = await Promise.all([
    db.select().from(cycles).where(inArray(cycles.teamId, teamIds)).orderBy(asc(cycles.startsAt)),
    progressBy(db, 'cycle_id', access),
  ]);
  return rows.map((c) => toCycle(c, progress.get(c.id)));
}
