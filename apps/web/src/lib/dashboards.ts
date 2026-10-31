import {
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

/** Tailwind needs whole class names, so spans map to literal ones. */
const COL_SPAN = ['', 'md:col-span-1', 'md:col-span-2', 'md:col-span-3', 'md:col-span-4'];
const ROW_SPAN = ['', 'row-span-1', 'row-span-2', 'row-span-3'];
export const spanClass = (w: DashboardWidget) => `${COL_SPAN[w.w]} ${ROW_SPAN[w.h]}`;
