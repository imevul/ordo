import { type CycleAutomation, cycleAutomationOf } from '@ordo/shared';
import { and, asc, eq, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { cycles, issues, teams, workflowStates } from '../db/schema.ts';
import { runAutomation } from './automation.ts';
import type { Ctx } from './context.ts';
import { createCycle } from './cycles.ts';
import { updateIssue } from './issues.ts';

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

/** The first `weekday` (0 = Sunday) on or after `day`. */
export function nextWeekday(day: string, weekday: number) {
  const current = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, (weekday - current + 7) % 7);
}

/** Hourly: every team with cycle automation plans ahead and closes the cycles that ended. */
export async function automateCycles(app: FastifyInstance, today = isoDay(new Date())) {
  const rows = await app.db
    .select({ id: teams.id, workspaceId: teams.workspaceId, auto: teams.cycleAutomation })
    .from(teams)
    .where(
      and(eq(teams.cyclesEnabled, true), sql`(${teams.cycleAutomation}->>'enabled')::boolean`),
    );
  for (const team of rows) {
    await runAutomation(app, team.workspaceId, (ctx) =>
      automateTeamCycles(ctx, team.id, cycleAutomationOf(team.auto), today),
    );
  }
}

/**
 * Keeps `upcoming` cycles planned after today, then closes the cycles that ended: their unfinished
 * issues move on to the cycle that follows (when roll-over is on). Idempotent; run it as often as
 * you like.
 */
export async function automateTeamCycles(
  ctx: Ctx,
  teamId: string,
  auto: CycleAutomation,
  today: string,
) {
  const list = await ctx.tx
    .select()
    .from(cycles)
    .where(eq(cycles.teamId, teamId))
    .orderBy(asc(cycles.startsAt));
  let lastEnd = list.at(-1)?.endsAt;
  let ahead = list.filter((c) => c.startsAt > today).length;
  for (let guard = 0; ahead < auto.upcoming && guard < 20; guard++) {
    // Pick up where the last cycle ends; after a gap (or at the very start), on the next start day.
    const startsAt =
      lastEnd && lastEnd >= today
        ? addDays(lastEnd, auto.cooldownWeeks * 7)
        : nextWeekday(today, auto.startDay);
    lastEnd = addDays(startsAt, auto.weeks * 7);
    await createCycle(ctx, teamId, { startsAt, endsAt: lastEnd });
    if (startsAt > today) ahead++;
  }

  const ended = await ctx.tx
    .select()
    .from(cycles)
    .where(and(eq(cycles.teamId, teamId), lte(cycles.endsAt, today), isNull(cycles.completedAt)))
    .orderBy(asc(cycles.endsAt));
  for (const cycle of ended) {
    if (auto.rollOver) {
      const [next] = await ctx.tx
        .select({ id: cycles.id })
        .from(cycles)
        .where(and(eq(cycles.teamId, teamId), sql`${cycles.startsAt} >= ${cycle.endsAt}`))
        .orderBy(asc(cycles.startsAt))
        .limit(1);
      if (next) {
        const open = await ctx.tx
          .select({ id: issues.id })
          .from(issues)
          .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
          .where(
            and(
              eq(issues.cycleId, cycle.id),
              isNull(issues.deletedAt),
              notInArray(workflowStates.type, ['completed', 'canceled']),
            ),
          );
        for (const issue of open) await updateIssue(ctx, issue.id, { cycleId: next.id });
      }
    }
    await ctx.tx
      .update(cycles)
      .set({ completedAt: new Date().toISOString() })
      .where(eq(cycles.id, cycle.id));
  }
}

/**
 * The cycle an issue joins when work on it starts, if its team automates cycles that way: the
 * active one, or null.
 */
export async function cycleForStartedIssue(ctx: Ctx, teamId: string, today = isoDay(new Date())) {
  const [team] = await ctx.tx
    .select({ cyclesEnabled: teams.cyclesEnabled, auto: teams.cycleAutomation })
    .from(teams)
    .where(eq(teams.id, teamId));
  const auto = cycleAutomationOf(team?.auto);
  if (!team?.cyclesEnabled || !auto.enabled || !auto.addStarted) return null;
  const [active] = await ctx.tx
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(eq(cycles.teamId, teamId), lte(cycles.startsAt, today), sql`${cycles.endsAt} > ${today}`),
    );
  return active?.id ?? null;
}
