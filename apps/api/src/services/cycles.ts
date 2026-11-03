import type { CreateCycleInput, Cycle, CycleHold, UpdateCycleInput } from '@ordo/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { cycles, issues, teams, workflowStates } from '../db/schema.ts';
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
  if (input.startsAfterId) await assertStartsAfter(ctx, teamId, null, input.startsAfterId);
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

/** That `cycleId` (null for a new cycle) may start after `after`: same team, and no loop. */
async function assertStartsAfter(ctx: Ctx, teamId: string, cycleId: string | null, after: string) {
  const rows = await ctx.tx
    .select({ id: cycles.id, startsAfterId: cycles.startsAfterId })
    .from(cycles)
    .where(eq(cycles.teamId, teamId));
  const byId = new Map(rows.map((c) => [c.id, c.startsAfterId]));
  if (!byId.has(after)) throw badRequest('A cycle can only start after a cycle of its own team');
  // Walking back from `after` must not lead to this cycle.
  for (let at: string | null | undefined = after; at; at = byId.get(at))
    if (at === cycleId) throw badRequest("Cycles can't wait for each other in a loop");
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
  if (input.startsAfterId) await assertStartsAfter(ctx, cycle.teamId, id, input.startsAfterId);
  const row = one(await ctx.tx.update(cycles).set(input).where(eq(cycles.id, id)).returning());
  emit(ctx, { kind: 'cycle', action: 'updated', id, teamId: cycle.teamId });
  record(ctx, 'cycle.updated', toCycle(row), { teamIds: [cycle.teamId] });
  return toCycle(row);
}

/**
 * The workspace's cycles that aren't open to agents on `today`. A cycle opens on its start date, or,
 * if it starts after another, when that one is finished: open itself, with no open issues, and with
 * something closed or its end date passed (so a cycle still being filed doesn't count as finished).
 * Worked out when asked, not stored, so changed dates and reopened issues take effect by themselves.
 */
export async function heldCycles(db: DbOrTx, workspaceId: string, today: string) {
  const rows = await db
    .select({
      id: cycles.id,
      number: cycles.number,
      name: cycles.name,
      startsAt: cycles.startsAt,
      endsAt: cycles.endsAt,
      startsAfterId: cycles.startsAfterId,
    })
    .from(cycles)
    .innerJoin(teams, eq(teams.id, cycles.teamId))
    .where(and(eq(teams.workspaceId, workspaceId), eq(teams.cyclesEnabled, true)));
  const awaited = [...new Set(rows.flatMap((c) => c.startsAfterId ?? []))];
  const tallies = awaited.length
    ? await db
        .select({
          cycleId: issues.cycleId,
          open: sql<number>`count(*) filter (where ${workflowStates.type} not in ('completed', 'canceled'))::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(issues)
        .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
        .where(and(inArray(issues.cycleId, awaited), isNull(issues.deletedAt)))
        .groupBy(issues.cycleId)
    : [];
  const byId = new Map(rows.map((c) => [c.id, c]));
  const tally = new Map(tallies.map((t) => [t.cycleId, t]));
  const opened = new Map<string, boolean>();
  const isOpen = (c: (typeof rows)[number]): boolean => {
    const known = opened.get(c.id);
    if (known !== undefined) return known;
    // Two concurrent edits could still make a loop; it stays closed rather than recursing forever.
    opened.set(c.id, false);
    const before = c.startsAfterId ? byId.get(c.startsAfterId) : undefined;
    const open = before ? isFinished(before) : c.startsAt <= today;
    opened.set(c.id, open);
    return open;
  };
  const isFinished = (c: (typeof rows)[number]) => {
    const t = tally.get(c.id);
    return isOpen(c) && !t?.open && (!!t?.total || c.endsAt <= today);
  };
  const held = new Map<string, CycleHold>();
  for (const c of rows) {
    if (isOpen(c)) continue;
    const before = c.startsAfterId ? byId.get(c.startsAfterId) : undefined;
    const t = before && tally.get(before.id);
    held.set(c.id, {
      id: c.id,
      number: c.number,
      name: c.name,
      startsAt: c.startsAt,
      startsAfter: before
        ? {
            id: before.id,
            number: before.number,
            name: before.name,
            endsAt: before.endsAt,
            open: t?.open ?? 0,
            total: t?.total ?? 0,
          }
        : null,
    });
  }
  return held;
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
