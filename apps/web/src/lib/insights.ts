import {
  BREAKDOWN_SLICES,
  type BreakdownSlice,
  type InsightsDay,
  type Issue,
  STATE_TYPES,
  type StateType,
} from '@ordo/shared';
import { t } from '../i18n/index.ts';
import { priorityLabel } from '../i18n/labels.ts';
import type { WorkspaceData } from './workspace.tsx';

/**
 * Insights computed from the issues a view already loaded: what they break down into, how work
 * flowed over time, and how long it took. Pure functions, so charts stay dumb.
 */

export type Measure = 'count' | 'estimate';
export const SLICES = BREAKDOWN_SLICES;
export type Slice = BreakdownSlice;

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
        add(
          s ? `${STATE_TYPES.indexOf(s.type)}:${s.name}` : '9:Unknown',
          s?.name ?? t('common.unknown'),
          i,
        );
        break;
      }
      case 'assignee':
        add(
          i.assigneeId ?? 'none',
          i.assigneeId
            ? (ws.memberById.get(i.assigneeId)?.name ?? t('insights.breakdown.someone'))
            : t('insights.breakdown.noAssignee'),
          i,
        );
        break;
      case 'priority':
        add(String(i.priority), priorityLabel(i.priority), i);
        break;
      case 'label':
        if (i.labelIds.length === 0) add('none', t('insights.breakdown.noLabels'), i);
        for (const l of i.labelIds) add(l, ws.labelById.get(l)?.name ?? t('common.label'), i);
        break;
      case 'project':
        add(
          i.projectId ?? 'none',
          i.projectId
            ? (ws.projectById.get(i.projectId)?.name ?? t('common.project'))
            : t('insights.breakdown.noProject'),
          i,
        );
        break;
      case 'team':
        add(i.teamId, ws.teamById.get(i.teamId)?.name ?? t('common.team'), i);
        break;
      case 'cycle': {
        const c = i.cycleId ? ws.cycleById.get(i.cycleId) : null;
        add(
          i.cycleId ?? 'none',
          c
            ? c.name || t('common.cycleNumber', { number: c.number })
            : t('insights.breakdown.noCycle'),
          i,
        );
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

const pick = (d: InsightsDay, m: Measure) => (m === 'count' ? d.issues : d.points);
const sum = (r: Record<StateType, number>) =>
  STATE_TYPES.reduce((a, s) => (s === 'canceled' ? a : a + r[s]), 0);

/** Scope (everything not canceled) and completed work per day of a history timeline. */
export function timelineBurnUp(days: InsightsDay[], m: Measure): BurnPoint[] {
  return days.map((d) => ({ day: d.day, scope: sum(pick(d, m)), completed: pick(d, m).completed }));
}

/** Status types bottom to top in a cumulative flow: finished work settles at the bottom. */
export const FLOW_TYPES = ['completed', 'started', 'unstarted', 'backlog', 'triage'] as const;

/** Per status type (canceled left out) per day, for a stacked cumulative flow chart. */
export function cumulativeFlow(days: InsightsDay[], m: Measure) {
  return FLOW_TYPES.map((type) => ({ type, values: days.map((d) => pick(d, m)[type]) }));
}

export interface Burndown {
  /** Days from the first of the timeline to whichever is last: today, the target, the forecast. */
  x: string[];
  /** Work left each day up to today. */
  remaining: (number | null)[];
  /** Straight from the first day with work left to zero on the target date. */
  ideal: (number | null)[];
  /** From today's remaining work down to zero at the recent rate. */
  forecast: (number | null)[];
  /** When the remaining work is done at the recent rate; null without progress to go by. */
  forecastDate: string | null;
  /** Completed per day over the last `window` days. */
  rate: number;
  /** Nothing left to do. */
  done: boolean;
}

/**
 * Work left per day, an ideal line to `target`, and a forecast at the rate work was completed over
 * the last `window` days (or since the start, if shorter). The forecast runs at most `horizon` days
 * past today; further than that, there's no date to promise.
 */
export function burndown(
  days: InsightsDay[],
  m: Measure,
  target: string | null,
  window = 28,
  horizon = 365,
): Burndown {
  const points = timelineBurnUp(days, m);
  const left = points.map((p) => Math.max(0, p.scope - p.completed));
  const today = points.at(-1);
  const remaining = left.at(-1) ?? 0;
  const span = Math.min(window, points.length - 1);
  const rate =
    span > 0
      ? Math.max(0, (today!.completed - points[points.length - 1 - span]!.completed) / span)
      : 0;
  const start = points.length ? dayOf(points[0]!.day) : 0;
  const end = today ? dayOf(today.day) : 0;
  const ahead = rate > 0 ? Math.ceil(remaining / rate) : null;
  const forecastDate =
    remaining > 0 && ahead !== null && ahead <= horizon ? isoDay(end + ahead * DAY) : null;
  let last = end;
  if (target && dayOf(target) > last) last = dayOf(target);
  if (forecastDate && dayOf(forecastDate) > last) last = dayOf(forecastDate);
  const x: string[] = [];
  for (let d = start; d <= last; d += DAY) x.push(isoDay(d));
  const targetAt = target ? dayOf(target) : null;
  // The ideal starts on the first day with work, so a project that began empty still gets one.
  const k = Math.max(
    0,
    left.findIndex((v) => v > 0),
  );
  const from = start + k * DAY;
  const first = left[k] ?? 0;
  return {
    x,
    remaining: x.map((_, i) => left[i] ?? null),
    ideal: x.map((day) => {
      const d = dayOf(day);
      if (targetAt === null || targetAt <= from || d < from || d > targetAt) return null;
      return Math.max(0, first * (1 - (d - from) / (targetAt - from)));
    }),
    forecast: x.map((day) => {
      const d = dayOf(day);
      if (!forecastDate || d < end) return null;
      return Math.max(0, remaining - ((d - end) / DAY) * rate);
    }),
    forecastDate,
    rate,
    done: remaining === 0 && points.length > 0,
  };
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

/** "3.5 d", "6 h", in the reader's language. */
export function formatDays(d: number) {
  if (d < 1) return t('insights.durations.hours', { count: Math.max(1, Math.round(d * 24)) });
  return t('insights.durations.days', { count: d < 10 ? Math.round(d * 10) / 10 : Math.round(d) });
}
