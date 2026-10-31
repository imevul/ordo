import type { CycleWorkload, WorkloadEntry } from '@ordo/shared';

export type LoadLevel = 'unknown' | 'under' | 'full' | 'over';

/** How someone's load compares with their capacity; `unknown` when they have none. */
export function loadLevel(e: Pick<WorkloadEntry, 'load' | 'capacity'>): LoadLevel {
  if (e.capacity == null) return 'unknown';
  if (e.load > e.capacity) return 'over';
  return e.load === e.capacity && e.load > 0 ? 'full' : 'under';
}

/**
 * Bar widths (0–100) for an entry. With a capacity the track is the capacity and the fill stops at
 * its end; without one the bar is relative to the busiest person in the cycle (`maxLoad`).
 */
export function loadBar(
  e: Pick<WorkloadEntry, 'load' | 'completed' | 'capacity'>,
  maxLoad: number,
): { load: number; completed: number } {
  const full = e.capacity ?? maxLoad;
  if (full <= 0) return { load: e.load > 0 ? 100 : 0, completed: e.completed > 0 ? 100 : 0 };
  const pct = (n: number) => Math.min(100, Math.round((n / full) * 100));
  return { load: pct(e.load), completed: pct(e.completed) };
}

const byIdentifier = (a: { identifier: string }, b: { identifier: string }) =>
  a.identifier.localeCompare(b.identifier, undefined, { numeric: true });

/** The workload with an issue moved to someone else (null: unassigned), until the server says so. */
export function moveIssue(w: CycleWorkload, issueId: string, to: string | null): CycleWorkload {
  const from = w.entries.find((e) => e.issues.some((i) => i.id === issueId));
  const issue = from?.issues.find((i) => i.id === issueId);
  if (!from || !issue || from.userId === to) return w;
  const size = w.unit === 'points' ? (issue.estimate ?? 0) : 1;
  const change = (e: WorkloadEntry, sign: 1 | -1): WorkloadEntry => ({
    ...e,
    load: e.load + sign * size,
    completed: e.completed + (issue.completed ? sign * size : 0),
    issueCount: e.issueCount + sign,
    unestimated: e.unestimated + (w.unit === 'points' && issue.estimate == null ? sign : 0),
    issues:
      sign < 0 ? e.issues.filter((i) => i.id !== issueId) : [...e.issues, issue].sort(byIdentifier),
  });
  const entries = w.entries.map((e) =>
    e === from ? change(e, -1) : e.userId === to ? change(e, 1) : e,
  );
  if (!entries.some((e) => e.userId === to)) {
    const empty: WorkloadEntry = {
      userId: to,
      load: 0,
      completed: 0,
      issueCount: 0,
      unestimated: 0,
      capacity: null,
      capacitySource: null,
      outsideTeam: false,
      issues: [],
    };
    entries.push(change(empty, 1));
  }
  return { ...w, entries };
}
