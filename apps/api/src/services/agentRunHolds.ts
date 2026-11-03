import {
  AGENT_RUN_PERSON_REASONS,
  type AgentRunHoldChain,
  type AgentRunHoldCycle,
  type AgentRunHoldIssue,
  type AgentRunHolds,
  type CycleHold,
} from '@ordo/shared';
import { aliasedTable, and, eq, inArray, isNull, not, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  agentRuns,
  cycles,
  issueLabels,
  issueRelations,
  issues,
  labels,
  teams,
  workflowStates,
} from '../db/schema.ts';
import { type Access, teamScope } from './access.ts';
import { loadRunHolds, runIsWaiting, waitReasonsColumn } from './agentRunWaits.ts';
import { workspaceToday } from './cycle-automation.ts';
import { heldCycles } from './cycles.ts';

const CLOSED = ['completed', 'canceled'] as const;
const PERSON: readonly string[] = AGENT_RUN_PERSON_REASONS;

/** Whether agents will get to an issue by themselves, or someone has to do something first. */
type IssueState = 'moving' | 'needs_person' | 'no_run';

/** An agent on it wins, then a person it waits for. Anything else queued gets picked up. */
function issueStates(rows: { issueId: string; status: string; reasons: string[] }[]) {
  const rank = new Map<string, number>();
  for (const r of rows) {
    const score =
      r.status === 'claimed' || r.status === 'running'
        ? 2
        : r.status === 'waiting' || r.reasons.some((x) => PERSON.includes(x))
          ? 1
          : 0;
    rank.set(r.issueId, Math.max(rank.get(r.issueId) ?? 0, score));
  }
  return (id: string): IssueState => {
    const score = rank.get(id);
    if (score === undefined) return 'no_run';
    return score === 1 ? 'needs_person' : 'moving';
  };
}

/** The blocks between open issues the reader can see, both ways. */
async function openBlocks(db: DbOrTx, access: Access) {
  const blocked = aliasedTable(issues, 'blocked');
  const blockedState = aliasedTable(workflowStates, 'blocked_state');
  const rows = await db
    .select({ blocker: issueRelations.issueId, blocked: issueRelations.relatedIssueId })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.issueId))
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .innerJoin(blocked, eq(blocked.id, issueRelations.relatedIssueId))
    .innerJoin(blockedState, eq(blockedState.id, blocked.stateId))
    .where(
      and(
        eq(issueRelations.type, 'blocks'),
        eq(teams.workspaceId, access.workspaceId),
        isNull(issues.deletedAt),
        isNull(blocked.deletedAt),
        not(inArray(workflowStates.type, [...CLOSED])),
        not(inArray(blockedState.type, [...CLOSED])),
        teamScope(access, issues.teamId),
        teamScope(access, blocked.teamId),
      ),
    );
  const blockersOf = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  for (const r of rows) {
    blockersOf.set(r.blocked, [...(blockersOf.get(r.blocked) ?? []), r.blocker]);
    blockedBy.set(r.blocker, [...(blockedBy.get(r.blocker) ?? []), r.blocked]);
  }
  return { blockersOf, blockedBy };
}

/** Everything reachable from `start`, without it. Relations can loop, so each id counts once. */
function reach(start: string, next: Map<string, string[]>) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    for (const id of next.get(stack.pop()!) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(id);
    }
  }
  seen.delete(start);
  return seen;
}

/** The issues listed for people to act on, with what they need and who they hold up. */
async function loadHoldIssues(
  db: DbOrTx,
  ids: string[],
  stateOf: (id: string) => IssueState,
  blockedBy: Map<string, string[]>,
) {
  const byId = new Map<string, AgentRunHoldIssue>();
  if (!ids.length) return byId;
  const rows = await db
    .select({
      id: issues.id,
      number: issues.number,
      title: issues.title,
      assigneeId: issues.assigneeId,
      teamKey: teams.key,
      status: workflowStates.name,
    })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .where(inArray(issues.id, ids));
  const labelRows = await db
    .select({ issueId: issueLabels.issueId, name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(inArray(issueLabels.issueId, ids));
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      identifier: `${r.teamKey}-${r.number}`,
      title: r.title,
      status: r.status,
      assigneeId: r.assigneeId,
      labels: labelRows.filter((l) => l.issueId === r.id).map((l) => l.name),
      reason: stateOf(r.id) === 'needs_person' ? 'needs_person' : 'no_run',
      behind: reach(r.id, blockedBy).size,
    });
  }
  return byId;
}

/**
 * What's holding queued runs back, grouped by the one thing each group waits for. The reasons come
 * from the same conditions that decide what a runner may claim, so this can't tell another story.
 */
export async function agentRunHolds(
  db: DbOrTx,
  access: Access,
  opts: { teamId?: string } = {},
): Promise<AgentRunHolds> {
  const holds = await loadRunHolds(db, access);
  // Every team the reader can see, since a blocker can sit in another team than the runs it holds.
  const runs = await db
    .select({
      issueId: agentRuns.issueId,
      status: agentRuns.status,
      teamId: issues.teamId,
      cycleId: issues.cycleId,
      reasons: waitReasonsColumn(holds),
    })
    .from(agentRuns)
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(
      and(
        eq(agentRuns.workspaceId, access.workspaceId),
        teamScope(access, issues.teamId),
        isNull(issues.deletedAt),
        or(runIsWaiting, inArray(agentRuns.status, ['claimed', 'running'])),
      ),
    );
  const stateOf = issueStates(runs);
  const shown = opts.teamId ? runs.filter((r) => r.teamId === opts.teamId) : runs;
  const { blockersOf, blockedBy } = await openBlocks(db, access);

  /** The unblocked issues `id` waits for, or itself when nothing blocks it (or only a loop does). */
  const rootsOf = (id: string) => {
    if (!blockersOf.get(id)?.length) return [id];
    const roots = [...reach(id, blockersOf)].filter((b) => !blockersOf.get(b)?.length);
    return roots.length ? roots : [id];
  };
  const stuckRootsOf = (id: string) => rootsOf(id).filter((r) => stateOf(r) !== 'moving');

  // Group held runs by the cycle at the head of their chain.
  const held = await heldCycles(
    db,
    access.workspaceId,
    await workspaceToday(db, access.workspaceId),
  );
  const runsIn = new Map<string, number>();
  for (const r of shown) {
    if (r.cycleId && r.reasons.includes('cycle')) {
      runsIn.set(r.cycleId, (runsIn.get(r.cycleId) ?? 0) + 1);
    }
  }
  /** From a held cycle to the head of its chain: the cycles passed, last the head's own hold. */
  const walk = (start: CycleHold) => {
    const path = [start];
    const seen = new Set([start.id]);
    for (;;) {
      const next = path.at(-1)!.startsAfter;
      const before = next && held.get(next.id);
      if (!before || seen.has(before.id)) return path;
      seen.add(before.id);
      path.push(before);
    }
  };
  const groups = new Map<string, { head: CycleHold; path: Map<string, CycleHold> }>();
  /** How far each cycle is from the head, to list them in the order they open. */
  const depth = new Map<string, number>();
  /** Held cycles with runs behind them: their open issues would stall the chain. */
  const waitedOn = new Set<string>();
  for (const cycleId of runsIn.keys()) {
    const start = held.get(cycleId);
    if (!start) continue;
    const path = walk(start);
    const head = path.at(-1)!;
    const key = head.startsAfter?.id ?? head.id;
    const group = groups.get(key) ?? { head, path: new Map() };
    path.forEach((c, i) => {
      group.path.set(c.id, c);
      depth.set(c.id, path.length - i);
      if (i > 0) waitedOn.add(c.id);
    });
    groups.set(key, group);
  }

  // The head of a chain that has to finish is open, so it isn't among the held cycles.
  const chainCycleIds = [
    ...new Set(
      [...groups.values()].flatMap((g) => [
        ...g.path.keys(),
        ...(g.head.startsAfter ? [g.head.startsAfter.id] : []),
      ]),
    ),
  ];
  const cycleRows = chainCycleIds.length
    ? await db
        .select({ id: cycles.id, teamKey: teams.key })
        .from(cycles)
        .innerJoin(teams, eq(teams.id, cycles.teamId))
        .where(inArray(cycles.id, chainCycleIds))
    : [];
  const teamKeys = new Map(cycleRows.map((c) => [c.id, c.teamKey]));
  const openRows = chainCycleIds.length
    ? await db
        .select({ id: issues.id, cycleId: issues.cycleId, number: issues.number })
        .from(issues)
        .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
        .where(
          and(
            inArray(issues.cycleId, chainCycleIds),
            isNull(issues.deletedAt),
            not(inArray(workflowStates.type, [...CLOSED])),
            teamScope(access, issues.teamId),
          ),
        )
        .orderBy(issues.number)
    : [];
  const openIn = (cycleId: string) =>
    openRows.filter((i) => i.cycleId === cycleId).map((i) => i.id);

  const planned = [...groups.values()].map(({ head, path }) => {
    const before = head.startsAfter;
    const finishes = !!before?.open;
    const open = openIn(before?.id ?? head.id);
    const issueIds = finishes ? [...new Set(open.flatMap(stuckRootsOf))] : [];
    const later = [...path.keys()]
      .filter((id) => waitedOn.has(id))
      .sort((a, b) => depth.get(a)! - depth.get(b)!);
    const stalling = [...new Set(later.flatMap((id) => openIn(id).flatMap(stuckRootsOf)))].filter(
      (id) => !issueIds.includes(id),
    );
    return { head, path, before, finishes, open, issueIds, stalling };
  });

  const blockedRuns = new Map<string, number>();
  for (const r of shown) {
    if (!r.reasons.includes('blocker') || r.reasons.includes('cycle')) continue;
    for (const root of stuckRootsOf(r.issueId)) {
      blockedRuns.set(root, (blockedRuns.get(root) ?? 0) + 1);
    }
  }

  const details = await loadHoldIssues(
    db,
    [
      ...new Set([
        ...planned.flatMap((p) => [...p.issueIds, ...p.stalling]),
        ...blockedRuns.keys(),
      ]),
    ],
    stateOf,
    blockedBy,
  );
  const listed = (ids: string[]) =>
    ids
      .flatMap((id) => details.get(id) ?? [])
      .sort((a, b) => b.behind - a.behind || a.identifier.localeCompare(b.identifier));

  const describe = (c: Pick<CycleHold, 'id' | 'number' | 'name'>): AgentRunHoldCycle => ({
    id: c.id,
    number: c.number,
    name: c.name,
    teamKey: teamKeys.get(c.id) ?? '',
  });
  const chains = planned.map(({ head, path, before, finishes, open, issueIds, stalling }) => {
    const later = [...path.values()]
      // A chain on a date has its head among the held cycles; it's already at the top.
      .filter((c) => (before || c.id !== head.id) && runsIn.get(c.id))
      .sort((a, b) => depth.get(a.id)! - depth.get(b.id)!)
      .map((c) => ({ ...describe(c), runs: runsIn.get(c.id)! }));
    return {
      cycle: describe(before ?? head),
      waitsFor: finishes ? 'finish' : before ? 'end' : 'start',
      date: finishes ? null : (before?.endsAt ?? head.startsAt),
      open: before?.open ?? 0,
      total: before?.total ?? 0,
      runs: [...path.keys()].reduce((sum, id) => sum + (runsIn.get(id) ?? 0), 0),
      later,
      working: finishes ? open.filter((id) => !stuckRootsOf(id).length).length : 0,
      issues: listed(issueIds),
      nextToStall: listed(stalling).map(({ id, identifier, title }) => ({
        id,
        identifier,
        title,
      })),
    } satisfies AgentRunHoldChain;
  });

  return {
    working: shown.filter((r) => r.status === 'claimed' || r.status === 'running').length,
    queued: shown.filter((r) => r.status === 'queued').length,
    needPerson: shown.filter((r) => r.reasons.some((x) => PERSON.includes(x))).length,
    ready: shown.filter((r) => r.reasons.includes('runner')).length,
    chains: chains.sort((a, b) => b.issues.length - a.issues.length || b.runs - a.runs),
    blocked: [...blockedRuns]
      .flatMap(([id, count]) => {
        const issue = details.get(id);
        return issue ? [{ issue, runs: count }] : [];
      })
      .sort((a, b) => b.runs - a.runs),
  };
}
