import {
  type AgentMetric,
  type AgentMetricPoint,
  type AgentMetricsReport,
  type Cycle,
  DASHBOARD_COLUMNS,
  DASHBOARD_MAX_ROWS,
  type DashboardWidget,
} from '@ordo/shared';

/** Layout edits on a dashboard's widgets: pure, so the editor only keeps a draft list. */

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const newWidgetId = () => Math.random().toString(36).slice(2, 10);

/** Moves a widget `by` places along the grid's order (the grid packs them in that order). */
export function moveWidget(list: DashboardWidget[], id: string, by: number): DashboardWidget[] {
  const from = list.findIndex((w) => w.id === id);
  if (from < 0) return list;
  const to = Math.max(0, Math.min(list.length - 1, from + by));
  if (to === from) return list;
  const next = [...list];
  const [w] = next.splice(from, 1);
  next.splice(to, 0, w!);
  return next;
}

/** Puts a dragged widget where the one it was dropped on is. */
export function dropWidget(list: DashboardWidget[], id: string, onto: string): DashboardWidget[] {
  const to = list.findIndex((w) => w.id === onto);
  const from = list.findIndex((w) => w.id === id);
  if (to < 0 || from < 0) return list;
  return moveWidget(list, id, to - from);
}

/** Grows or shrinks a widget, within the grid's columns and rows. */
export function resizeWidget(
  list: DashboardWidget[],
  id: string,
  by: { w?: number; h?: number },
): DashboardWidget[] {
  const clamp = (n: number, max: number) => Math.max(1, Math.min(max, n));
  return list.map((w) =>
    w.id === id
      ? {
          ...w,
          w: clamp(w.w + (by.w ?? 0), DASHBOARD_COLUMNS),
          h: clamp(w.h + (by.h ?? 0), DASHBOARD_MAX_ROWS),
        }
      : w,
  );
}

/** Adds or replaces (by id) a widget. */
export function putWidget(list: DashboardWidget[], widget: DashboardWidget): DashboardWidget[] {
  return list.some((w) => w.id === widget.id)
    ? list.map((w) => (w.id === widget.id ? widget : w))
    : [...list, widget];
}

/** The team's cycle running on `today`, if any. */
export function currentCycle(cycles: Cycle[], teamId: string, today: string): Cycle | undefined {
  return cycles.find((c) => c.teamId === teamId && c.startsAt <= today && today <= c.endsAt);
}

export type TimelineScope = {
  teamId?: string;
  projectId?: string;
  cycleId?: string;
  from?: string;
};

/**
 * What `GET /insights/timeline` a chart widget asks for, or null when it isn't over a timeline
 * or has nothing to show (a team without a current cycle). A cycle is shown whole; a project
 * since its start unless weeks are given; the rest the last `weeks` (12 by default).
 */
export function timelineScope(
  w: DashboardWidget,
  cycles: Cycle[],
  now = Date.now(),
): TimelineScope | null {
  if (w.type !== 'chart' || !['burnUp', 'burndown', 'cumulativeFlow'].includes(w.chart))
    return null;
  if (w.currentCycle && w.teamId) {
    const cycle = currentCycle(cycles, w.teamId, isoDay(now));
    return cycle ? { cycleId: cycle.id } : null;
  }
  const from = w.projectId && !w.weeks ? undefined : isoDay(now - ((w.weeks ?? 12) * 7 - 1) * DAY);
  if (w.projectId) return { projectId: w.projectId, from };
  if (w.teamId) return { teamId: w.teamId, from };
  return { from };
}

/** Lines an agent graph can tell apart; the agents past them still count in the average. */
export const AGENT_METRIC_LINES = 5;

/** A metric's total and the runs that reported it. Durations are in minutes, for a round axis. */
function metricOf(p: AgentMetricPoint, metric: AgentMetric): [total: number, runs: number] {
  if (metric === 'duration') return [p.durationMs / 60_000, p.durationRuns];
  if (metric === 'tokens') return [p.tokens, p.tokenRuns];
  return [p.costUsd, p.costRuns];
}

const mean = (points: AgentMetricPoint[], metric: AgentMetric) => {
  let total = 0;
  let runs = 0;
  for (const p of points) {
    const [t, r] = metricOf(p, metric);
    total += t;
    runs += r;
  }
  return { value: runs ? total / runs : null, runs };
};

export interface AgentMetricChart {
  /** Per run, one line per agent. `slot` picks its color. */
  lines: { agentId: string; slot: number; values: (number | null)[] }[];
  /** Per run across all agents; null when that would only repeat the one agent's line. */
  average: (number | null)[] | null;
  /** Agents only in the average, for not fitting. */
  hidden: number;
  /** The whole period, for the one agent asked for or else all of them. */
  overall: { value: number | null; runs: number };
}

/**
 * A metric's lines: one agent's if one is asked for, or else the busiest agents'. Slots go by id
 * among the busiest, counting all runs rather than the metric's, so an agent keeps its color
 * across a dashboard's graphs, also on one of its own (or the first, if it's not among them).
 */
export function agentMetricChart(
  report: AgentMetricsReport,
  metric: AgentMetric,
  agentId?: string | null,
): AgentMetricChart {
  const reported = report.points.filter((p) => metricOf(p, metric)[1] > 0);
  const runs = new Map<string, number>();
  for (const p of report.points) runs.set(p.agentId, (runs.get(p.agentId) ?? 0) + p.runs);
  const busiest = [...runs.keys()].sort((a, b) => runs.get(b)! - runs.get(a)! || (a < b ? -1 : 1));
  const shown = busiest.slice(0, AGENT_METRIC_LINES).sort();
  const perDay = (points: AgentMetricPoint[]) =>
    report.days.map(
      (day) =>
        mean(
          points.filter((p) => p.day === day),
          metric,
        ).value,
    );
  const reporting = new Set(reported.map((p) => p.agentId));
  return {
    lines: (agentId ? [agentId] : shown)
      .filter((id) => reporting.has(id))
      .map((id) => ({
        agentId: id,
        slot: Math.max(0, shown.indexOf(id)),
        values: perDay(reported.filter((p) => p.agentId === id)),
      })),
    average: reporting.size > 1 ? perDay(reported) : null,
    hidden: agentId ? 0 : [...reporting].filter((id) => !shown.includes(id)).length,
    overall: mean(agentId ? reported.filter((p) => p.agentId === agentId) : reported, metric),
  };
}

/** Tailwind needs whole class names, so spans map to literal ones. */
const COL_SPAN = ['', 'md:col-span-1', 'md:col-span-2', 'md:col-span-3', 'md:col-span-4'];
const ROW_SPAN = ['', 'row-span-1', 'row-span-2', 'row-span-3'];
export const spanClass = (w: DashboardWidget) => `${COL_SPAN[w.w]} ${ROW_SPAN[w.h]}`;
