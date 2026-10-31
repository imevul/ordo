import type { CreateCycleInput, Cycle, UpdateCycleInput } from '@ordo/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { cycles, teams } from '../db/schema.ts';
import { badRequest, forbidden, notFound, one } from '../lib/errors.ts';
import { type Access, assertTeamAccess, canReadTeam, teamScope } from './access.ts';
import { type Ctx, emit, record } from './context.ts';
import { progressBy } from './progress.ts';
import { toCycle } from './serialize.ts';

/**
 * Cycles are planned by the team: anyone who can read the team, except guests. Agents are guests
 * of their teams only to limit what they see; they plan there like members.
 */
export function assertCanPlan(ctx: Ctx, teamId: string) {
  assertTeamAccess(ctx.access, teamId);
  if (ctx.access.isGuest && !ctx.access.isAgent)
    throw forbidden('Guests cannot manage cycles').as('guests_cycles');
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

/** A cycle of this workspace that the caller may plan. */
export async function loadCycle(ctx: Ctx, id: string) {
  const [row] = await ctx.tx
    .select({ cycle: cycles })
    .from(cycles)
    .innerJoin(teams, eq(teams.id, cycles.teamId))
    .where(and(eq(cycles.id, id), eq(teams.workspaceId, ctx.workspaceId)));
  if (!row || !canReadTeam(ctx.access, row.cycle.teamId)) throw notFound('Cycle');
  assertCanPlan(ctx, row.cycle.teamId);
  return row.cycle;
}

export async function updateCycle(ctx: Ctx, id: string, input: UpdateCycleInput): Promise<Cycle> {
  const cycle = await loadCycle(ctx, id);
  const next = { ...cycle, ...input };
  if (next.endsAt <= next.startsAt)
    throw badRequest('End date must be after start date').as('end_after_start');
  const row = one(await ctx.tx.update(cycles).set(input).where(eq(cycles.id, id)).returning());
  emit(ctx, { kind: 'cycle', action: 'updated', id, teamId: cycle.teamId });
  record(ctx, 'cycle.updated', toCycle(row), { teamIds: [cycle.teamId] });
  return toCycle(row);
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
