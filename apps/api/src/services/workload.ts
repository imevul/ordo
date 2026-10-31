import type { CycleWorkload, WorkloadEntry } from '@ordo/shared';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  cycleCapacities,
  cycles,
  issues,
  teamMembers,
  teams,
  users,
  workflowStates,
} from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { type Access, canReadTeam } from './access.ts';
import { type Ctx, emit } from './context.ts';
import { loadCycle } from './cycles.ts';

/** A cycle of the workspace whose team `access` can read, with its team. */
async function readableCycle(db: DbOrTx, access: Access, id: string) {
  const [row] = await db
    .select({ cycle: cycles, team: teams })
    .from(cycles)
    .innerJoin(teams, eq(teams.id, cycles.teamId))
    .where(and(eq(cycles.id, id), eq(teams.workspaceId, access.workspaceId)));
  if (!row || !canReadTeam(access, row.cycle.teamId)) throw notFound('Cycle');
  return row;
}

/**
 * Who has what in a cycle. Canceled issues don't count. Capacity is the cycle's override for the
 * person, else their own default on the team, else the team's.
 */
export async function cycleWorkload(
  db: DbOrTx,
  access: Access,
  cycleId: string,
): Promise<CycleWorkload> {
  const { cycle, team } = await readableCycle(db, access, cycleId);
  const [rows, members, overrides] = await Promise.all([
    db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        estimate: issues.estimate,
        stateId: issues.stateId,
        stateType: workflowStates.type,
        assigneeId: issues.assigneeId,
      })
      .from(issues)
      .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
      .where(
        and(
          eq(issues.cycleId, cycle.id),
          eq(issues.workspaceId, access.workspaceId),
          eq(issues.teamId, team.id),
          isNull(issues.deletedAt),
          ne(workflowStates.type, 'canceled'),
        ),
      )
      .orderBy(asc(issues.number)),
    db
      .select({
        userId: teamMembers.userId,
        capacity: teamMembers.capacity,
        name: users.name,
        kind: users.kind,
        disabledAt: users.disabledAt,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, team.id))
      .orderBy(asc(users.name)),
    db.select().from(cycleCapacities).where(eq(cycleCapacities.cycleId, cycle.id)),
  ]);

  const unit =
    team.estimateScale !== 'none' && rows.some((r) => r.estimate != null) ? 'points' : 'issues';
  const override = new Map(overrides.map((o) => [o.userId, o.capacity]));
  const entries = new Map<string | null, WorkloadEntry>();
  const entry = (userId: string | null, outsideTeam: boolean): WorkloadEntry => {
    let e = entries.get(userId);
    if (!e) {
      e = {
        userId,
        load: 0,
        completed: 0,
        issueCount: 0,
        unestimated: 0,
        capacity: null,
        capacitySource: null,
        outsideTeam,
        issues: [],
      };
      entries.set(userId, e);
    }
    return e;
  };

  // People who can take work: everyone on the team but placeholders and disabled accounts.
  const memberIds = new Set(members.map((m) => m.userId));
  for (const m of members) {
    if (m.kind === 'placeholder' || m.disabledAt) continue;
    const e = entry(m.userId, false);
    const own = override.get(m.userId);
    if (own != null) [e.capacity, e.capacitySource] = [own, 'cycle'];
    else if (m.capacity != null) [e.capacity, e.capacitySource] = [m.capacity, 'member'];
    else if (team.defaultCapacity != null)
      [e.capacity, e.capacitySource] = [team.defaultCapacity, 'team'];
  }

  for (const r of rows) {
    const e = entry(r.assigneeId, r.assigneeId != null && !memberIds.has(r.assigneeId));
    const completed = r.stateType === 'completed';
    const size = unit === 'points' ? (r.estimate ?? 0) : 1;
    e.load += size;
    if (completed) e.completed += size;
    e.issueCount += 1;
    if (unit === 'points' && r.estimate == null) e.unestimated += 1;
    e.issues.push({
      id: r.id,
      identifier: `${team.key}-${r.number}`,
      title: r.title,
      estimate: r.estimate,
      stateId: r.stateId,
      completed,
    });
  }

  // The team (disabled members with work at its end), then assignees outside it, unassigned last.
  const all = [...entries.values()];
  const unassigned = entries.get(null);
  return {
    cycleId: cycle.id,
    unit,
    entries: [
      ...all.filter((e) => e.userId != null && !e.outsideTeam),
      ...all.filter((e) => e.outsideTeam),
      ...(unassigned ? [unassigned] : []),
    ],
  };
}

/** Sets (or, with null, clears) someone's capacity in one cycle. */
export async function setCycleCapacity(
  ctx: Ctx,
  cycleId: string,
  userId: string,
  capacity: number | null,
) {
  const cycle = await loadCycle(ctx, cycleId);
  const [member] = await ctx.tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, cycle.teamId), eq(teamMembers.userId, userId)));
  if (!member) throw badRequest('Only team members have a capacity in its cycles');
  if (capacity == null) {
    await ctx.tx
      .delete(cycleCapacities)
      .where(and(eq(cycleCapacities.cycleId, cycleId), eq(cycleCapacities.userId, userId)));
  } else {
    await ctx.tx
      .insert(cycleCapacities)
      .values({ cycleId, userId, capacity })
      .onConflictDoUpdate({
        target: [cycleCapacities.cycleId, cycleCapacities.userId],
        set: { capacity },
      });
  }
  emit(ctx, { kind: 'cycle', action: 'updated', id: cycleId, teamId: cycle.teamId });
  return { ok: true };
}
