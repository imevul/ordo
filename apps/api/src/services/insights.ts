import {
  type HistoryChange,
  type InsightsDay,
  type InsightsTimeline,
  type IssueAmount,
  STATE_TYPES,
  type StateType,
  type Velocity,
} from '@ordo/shared';
import { type AnyColumn, and, asc, desc, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { cycles, issueHistory, issues, teams, workflowStates } from '../db/schema.ts';
import { notFound } from '../lib/errors.ts';
import { type Access, assertTeamAccess, teamScope } from './access.ts';
import { listProjects } from './projects.ts';

/**
 * Charts over time, rebuilt from issue history: each issue's team, project, cycle, estimate,
 * status type and deletion are replayed, so a day counts what the scope held that day, not what
 * it holds now.
 */

const DAY = 86_400_000;
const MAX_DAYS = 731;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** What an issue looked like at one moment. */
export interface Snapshot {
  type: StateType;
  teamId: string;
  projectId: string | null;
  cycleId: string | null;
  estimate: number | null;
  deleted: boolean;
}

export interface ReplayIssue extends Omit<Snapshot, 'deleted'> {
  id: string;
  createdAt: string;
  deletedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
}

export interface ReplayEntry {
  createdAt: string;
  changes: HistoryChange[];
}

export interface Timeline {
  born: number;
  initial: Snapshot;
  /** Ascending. */
  events: { at: number; set: Partial<Snapshot> }[];
}

const FIELDS: Record<string, keyof Snapshot> = {
  state: 'type',
  team: 'teamId',
  project: 'projectId',
  cycle: 'cycleId',
  estimate: 'estimate',
};

/**
 * One issue's life from its history. A field's value before its first change is that change's
 * `from`; without changes it's the current value. Issues whose status never changed in history
 * (imports, old data) get one from their started/completed/canceled timestamps.
 */
export function issueTimeline(
  issue: ReplayIssue,
  history: ReplayEntry[],
  typeOf: (stateId: unknown) => StateType | undefined,
): Timeline {
  const initial: Snapshot = {
    type: issue.type,
    teamId: issue.teamId,
    projectId: issue.projectId,
    cycleId: issue.cycleId,
    estimate: issue.estimate,
    deleted: false,
  };
  const seen = new Set<string>();
  const events: Timeline['events'] = [];
  let deletion = false;
  for (const entry of history) {
    const at = Date.parse(entry.createdAt);
    const set: Partial<Snapshot> = {};
    for (const c of entry.changes) {
      if (c.field === 'deleted' || c.field === 'restored') {
        set.deleted = c.field === 'deleted';
        deletion = true;
        continue;
      }
      const key = FIELDS[c.field];
      if (!key) continue;
      const value = (v: unknown) =>
        key === 'type' ? (typeOf(v) ?? 'unstarted') : ((v ?? null) as never);
      if (!seen.has(key)) {
        seen.add(key);
        (initial as unknown as Record<string, unknown>)[key] = value(c.from);
      }
      (set as Record<string, unknown>)[key] = value(c.to);
    }
    if (Object.keys(set).length) events.push({ at, set });
  }
  const born = Date.parse(issue.createdAt);
  if (!seen.has('type') && ['started', 'completed', 'canceled'].includes(issue.type)) {
    const steps: [number, StateType][] = [];
    if (issue.startedAt) steps.push([Date.parse(issue.startedAt), 'started']);
    const closedAt = issue.type === 'completed' ? issue.completedAt : issue.canceledAt;
    if (closedAt && issue.type !== 'started') steps.push([Date.parse(closedAt), issue.type]);
    if (steps.some(([at]) => at > born)) {
      initial.type = 'unstarted';
      for (const [at, type] of steps) {
        if (at <= born) initial.type = type;
        else events.push({ at, set: { type } });
      }
      // It ends in the status it has now, whatever order the timestamps are in.
      events.push({ at: Math.max(...steps.map(([at]) => at)), set: { type: issue.type } });
    }
  }
  if (!deletion && issue.deletedAt)
    events.push({ at: Date.parse(issue.deletedAt), set: { deleted: true } });
  events.sort((a, b) => a.at - b.at);
  return { born, initial, events };
}

/** The issue at each of `times` (ascending): null before it was created. */
export function snapshotsAt(tl: Timeline, times: number[]): (Snapshot | null)[] {
  const s = { ...tl.initial };
  let k = 0;
  return times.map((t) => {
    while (k < tl.events.length && tl.events[k]!.at < t) Object.assign(s, tl.events[k++]!.set);
    return tl.born < t ? { ...s } : null;
  });
}

const zeros = () => Object.fromEntries(STATE_TYPES.map((s) => [s, 0])) as Record<StateType, number>;

/** Per day (UTC, counted at its end) from `from` to `to`: issues for which `inScope` holds. */
export function dailyTotals(
  timelines: Timeline[],
  inScope: (s: Snapshot) => boolean,
  from: string,
  to: string,
): InsightsDay[] {
  const starts: number[] = [];
  for (let d = dayStart(from); d <= dayStart(to); d += DAY) starts.push(d);
  const days = starts.map((d) => ({ day: isoDay(d), issues: zeros(), points: zeros() }));
  const ends = starts.map((d) => d + DAY);
  for (const tl of timelines) {
    snapshotsAt(tl, ends).forEach((s, i) => {
      if (!s || s.deleted || !inScope(s)) return;
      days[i]!.issues[s.type] += 1;
      days[i]!.points[s.type] += s.estimate ?? 0;
    });
  }
  return days;
}

type Scope = { teamId?: string; projectId?: string; cycleId?: string };

/** Issues with `column` in `ids` now, or once according to their history. */
function everIn(column: AnyColumn, field: string, ids: string[]): SQL {
  const once = ids.flatMap((id) => [
    sql`h.changes @> ${JSON.stringify([{ field, from: id }])}::jsonb`,
    sql`h.changes @> ${JSON.stringify([{ field, to: id }])}::jsonb`,
  ]);
  return sql`(${inArray(column, ids)} or exists (select 1 from issue_history h where h.issue_id = "issues"."id" and (${sql.join(once, sql` or `)})))`;
}

async function loadTimelines(db: DbOrTx, access: Access, where: SQL | undefined) {
  const cond = and(
    eq(issues.workspaceId, access.workspaceId),
    teamScope(access, issues.teamId),
    where,
  );
  const [rows, states] = await Promise.all([
    db
      .select({
        id: issues.id,
        createdAt: issues.createdAt,
        deletedAt: issues.deletedAt,
        stateType: workflowStates.type,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
        canceledAt: issues.canceledAt,
        teamId: issues.teamId,
        projectId: issues.projectId,
        cycleId: issues.cycleId,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
      .where(cond),
    db
      .select({ id: workflowStates.id, type: workflowStates.type })
      .from(workflowStates)
      .innerJoin(teams, eq(teams.id, workflowStates.teamId))
      .where(eq(teams.workspaceId, access.workspaceId)),
  ]);
  const history = rows.length
    ? await db
        .select({
          issueId: issueHistory.issueId,
          createdAt: issueHistory.createdAt,
          changes: issueHistory.changes,
        })
        .from(issueHistory)
        .where(
          and(
            inArray(issueHistory.issueId, db.select({ id: issues.id }).from(issues).where(cond)),
            sql`jsonb_path_exists(${issueHistory.changes}, '$[*] ? (@.field == "state" || @.field == "team" || @.field == "project" || @.field == "cycle" || @.field == "estimate" || @.field == "deleted" || @.field == "restored")')`,
          ),
        )
        .orderBy(asc(issueHistory.createdAt))
    : [];
  const byIssue = new Map<string, ReplayEntry[]>();
  for (const h of history) {
    const list = byIssue.get(h.issueId) ?? [];
    list.push(h);
    byIssue.set(h.issueId, list);
  }
  const typeById = new Map(states.map((s) => [s.id, s.type]));
  const typeOf = (id: unknown) => (typeof id === 'string' ? typeById.get(id) : undefined);
  return rows.map(({ stateType, ...r }) =>
    issueTimeline({ ...r, type: stateType }, byIssue.get(r.id) ?? [], typeOf),
  );
}

export async function insightsTimeline(
  db: DbOrTx,
  access: Access,
  q: Scope & { from?: string; to?: string },
  now = Date.now(),
): Promise<InsightsTimeline> {
  let where: SQL | undefined;
  let inScope: (s: Snapshot) => boolean = () => true;
  let from = q.from;
  let to = q.to;
  if (q.teamId) {
    assertTeamAccess(access, q.teamId);
    where = everIn(issues.teamId, 'team', [q.teamId]);
    inScope = (s) => s.teamId === q.teamId;
  } else if (q.projectId) {
    const [project] = await listProjects(db, access, q.projectId);
    if (!project) throw notFound('Project');
    where = everIn(issues.projectId, 'project', [q.projectId]);
    inScope = (s) => s.projectId === q.projectId;
    from ??= project.startDate ?? undefined;
  } else if (q.cycleId) {
    const [cycle] = await db
      .select()
      .from(cycles)
      .innerJoin(teams, eq(teams.id, cycles.teamId))
      .where(and(eq(cycles.id, q.cycleId), eq(teams.workspaceId, access.workspaceId)));
    if (!cycle) throw notFound('Cycle');
    assertTeamAccess(access, cycle.cycles.teamId);
    where = everIn(issues.cycleId, 'cycle', [q.cycleId]);
    inScope = (s) => s.cycleId === q.cycleId;
    from ??= cycle.cycles.startsAt;
    to ??= cycle.cycles.endsAt;
  }
  const timelines = await loadTimelines(db, access, where);
  const today = isoDay(now);
  if (!to || to > today) to = today;
  if (!from) {
    // A project without a start date starts with its first issue; anything else shows 12 weeks.
    const first =
      q.projectId && timelines.length ? Math.min(...timelines.map((t) => t.born)) : null;
    from = isoDay(first ?? dayStart(to) - 83 * DAY);
  }
  // Not started yet (a future cycle or project start): nothing to show.
  if (from > to) return { from, to, days: [] };
  if ((dayStart(to) - dayStart(from)) / DAY >= MAX_DAYS)
    from = isoDay(dayStart(to) - (MAX_DAYS - 1) * DAY);
  return { from, to, days: dailyTotals(timelines, inScope, from, to) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function insightsVelocity(
  db: DbOrTx,
  access: Access,
  q: { teamId: string; cycles: number },
  now = Date.now(),
): Promise<Velocity> {
  assertTeamAccess(access, q.teamId);
  const today = isoDay(now);
  const rows = (
    await db
      .select()
      .from(cycles)
      .innerJoin(teams, eq(teams.id, cycles.teamId))
      .where(
        and(
          eq(cycles.teamId, q.teamId),
          eq(teams.workspaceId, access.workspaceId),
          lte(cycles.startsAt, today),
        ),
      )
      .orderBy(desc(cycles.startsAt))
      .limit(q.cycles)
  )
    .map((r) => r.cycles)
    .reverse();
  if (rows.length === 0) return { teamId: q.teamId, cycles: [], average: null };
  const timelines = await loadTimelines(
    db,
    access,
    everIn(
      issues.cycleId,
      'cycle',
      rows.map((c) => c.id),
    ),
  );
  const out = rows.map((c) => {
    const committedAt = Math.min(dayStart(c.startsAt) + DAY, now);
    const endAt = Math.min(dayStart(c.endsAt) + DAY, now);
    const committed: IssueAmount = { issues: 0, points: 0 };
    const completed: IssueAmount = { issues: 0, points: 0 };
    for (const tl of timelines) {
      const [atStart, atEnd] = snapshotsAt(tl, [committedAt, endAt]);
      if (atStart && !atStart.deleted && atStart.cycleId === c.id && atStart.type !== 'canceled') {
        committed.issues += 1;
        committed.points += atStart.estimate ?? 0;
      }
      if (atEnd && !atEnd.deleted && atEnd.cycleId === c.id && atEnd.type === 'completed') {
        completed.issues += 1;
        completed.points += atEnd.estimate ?? 0;
      }
    }
    return {
      cycleId: c.id,
      number: c.number,
      name: c.name,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      current: c.endsAt >= today,
      committed,
      completed,
    };
  });
  const done = out.filter((c) => !c.current);
  const average = done.length
    ? {
        issues: round1(done.reduce((a, c) => a + c.completed.issues, 0) / done.length),
        points: round1(done.reduce((a, c) => a + c.completed.points, 0) / done.length),
      }
    : null;
  return { teamId: q.teamId, cycles: out, average };
}
