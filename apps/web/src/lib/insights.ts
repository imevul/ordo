import { type Issue, PRIORITIES, STATE_TYPES } from '@ordo/shared';
import type { WorkspaceData } from './workspace.tsx';

/**
 * Insights computed from the issues a view already loaded: what they break down into, how work
 * flowed over time, and how long it took. Pure functions, so charts stay dumb.
 */

export type Measure = 'count' | 'estimate';
export const SLICES = [
  'state',
  'assignee',
  'priority',
  'label',
  'project',
  'team',
  'cycle',
] as const;
export type Slice = (typeof SLICES)[number];

export interface Bar {
  key: string;
  label: string;
  value: number;
}

const DAY = 86_400_000;
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayOf = (ts: string) => Date.parse(`${ts.slice(0, 10)}T00:00:00Z`);

const amount = (i: Issue, m: Measure) => (m === 'count' ? 1 : (i.estimate ?? 0));

/** Totals per value of `slice`, largest first (statuses and priorities keep their own order). */
export function breakdown(ws: WorkspaceData, issues: Issue[], slice: Slice, m: Measure): Bar[] {
  const totals = new Map<string, Bar>();
  const add = (key: string, label: string, i: Issue) => {
    const bar = totals.get(key) ?? { key, label, value: 0 };
    bar.value += amount(i, m);
    totals.set(key, bar);
  };
  for (const i of issues) {
    switch (slice) {
      case 'state': {
        // Keyed so that sorting by key gives workflow order: status type, then name.
        const s = ws.stateById.get(i.stateId);
        add(s ? `${STATE_TYPES.indexOf(s.type)}:${s.name}` : '9:Unknown', s?.name ?? 'Unknown', i);
        break;
      }
      case 'assignee':
        add(
          i.assigneeId ?? 'none',
          i.assigneeId ? (ws.memberById.get(i.assigneeId)?.name ?? 'Someone') : 'No assignee',
          i,
        );
        break;
      case 'priority':
        add(String(i.priority), PRIORITIES.find((p) => p.value === i.priority)?.label ?? '?', i);
        break;
      case 'label':
        if (i.labelIds.length === 0) add('none', 'No labels', i);
        for (const l of i.labelIds) add(l, ws.labelById.get(l)?.name ?? 'Label', i);
        break;
      case 'project':
        add(
          i.projectId ?? 'none',
          i.projectId ? (ws.projectById.get(i.projectId)?.name ?? 'Project') : 'No project',
          i,
        );
        break;
      case 'team':
        add(i.teamId, ws.teamById.get(i.teamId)?.name ?? 'Team', i);
        break;
      case 'cycle': {
        const c = i.cycleId ? ws.cycleById.get(i.cycleId) : null;
        add(i.cycleId ?? 'none', c ? c.name || `Cycle ${c.number}` : 'No cycle', i);
        break;
      }
    }
  }
  const bars = [...totals.values()];
  if (slice === 'state') return bars.sort((a, b) => a.key.localeCompare(b.key));
  if (slice === 'priority') {
    const order = ['1', '2', '3', '4', '0'];
    return bars.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return bars.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Monday of the week `ms` falls in. */
export function weekStart(ms: number) {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7;
  return dayOf(d.toISOString()) - back * DAY;
}

export interface FlowPoint {
  start: string;
  created: number;
  completed: number;
}

/** Issues created and completed per week, for the `weeks` weeks up to and including `now`'s. */
export function weeklyFlow(issues: Issue[], m: Measure, weeks = 12, now = Date.now()): FlowPoint[] {
  const last = weekStart(now);
  const first = last - (weeks - 1) * 7 * DAY;
  const points = Array.from({ length: weeks }, (_, k) => ({
    start: isoDay(first + k * 7 * DAY),
    created: 0,
    completed: 0,
  }));
  const slot = (ts: string | null) => {
    if (!ts) return null;
    const k = Math.floor((weekStart(Date.parse(ts)) - first) / (7 * DAY));
    return k >= 0 && k < weeks ? points[k]! : null;
  };
  for (const i of issues) {
    const c = slot(i.createdAt);
    if (c) c.created += amount(i, m);
    const d = slot(i.completedAt);
    if (d) d.completed += amount(i, m);
  }
  return points;
}

export interface BurnPoint {
  day: string;
  scope: number;
  completed: number;
}

/**
 * Scope and completed work per day from `from` to `to` (inclusive, capped at today): the
 * issues as they are now, counted from the day each was created (clamped into the range, so
 * work added after the end still shows on the last day) and completed. Canceled issues leave the
 * scope on the day they were canceled.
 */
export function burnUp(
  issues: Issue[],
  m: Measure,
  from: string,
  to: string,
  now = Date.now(),
): BurnPoint[] {
  const start = dayOf(from);
  const end = Math.min(dayOf(to), dayOf(new Date(now).toISOString()));
  const out: BurnPoint[] = [];
  for (let d = start; d <= end; d += DAY) {
    let scope = 0;
    let completed = 0;
    for (const i of issues) {
      const created = Math.min(Math.max(dayOf(i.createdAt), start), end);
      if (created > d) continue;
      if (i.canceledAt && dayOf(i.canceledAt) <= d) continue;
      scope += amount(i, m);
      if (i.completedAt && Math.min(dayOf(i.completedAt), end) <= d) completed += amount(i, m);
    }
    out.push({ day: isoDay(d), scope, completed });
  }
  return out;
}

export interface Durations {
  count: number;
  /** Started to completed, in days: median and 75th percentile. */
  cycle: { median: number; p75: number } | null;
  /** Created to completed, in days. */
  lead: { median: number; p75: number } | null;
}

const quantile = (sorted: number[], q: number) => {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/** How long completed issues took, over those completed since `since`. */
export function durations(issues: Issue[], since: number): Durations {
  const done = issues.filter((i) => i.completedAt && Date.parse(i.completedAt) >= since);
  const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
  const stats = (values: number[]) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75) };
  };
  return {
    count: done.length,
    cycle: stats(done.filter((i) => i.startedAt).map((i) => days(i.startedAt!, i.completedAt!))),
    lead: stats(done.map((i) => days(i.createdAt, i.completedAt!))),
  };
}

/** "3.5 days", "6 hours". */
export function formatDays(d: number) {
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h`;
  return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)} d`;
}
