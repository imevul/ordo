import { type Cycle, type DashboardWidget, dashboardWidgetSchema } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import {
  currentCycle,
  dropWidget,
  moveWidget,
  putWidget,
  resizeWidget,
  timelineScope,
} from './dashboards.ts';

const widget = (id: string, extra: object = {}): DashboardWidget =>
  dashboardWidgetSchema.parse({ id, type: 'agents', ...extra });
const ids = (list: DashboardWidget[]) => list.map((w) => w.id).join('');
const list = ['a', 'b', 'c', 'd'].map((id) => widget(id));

const cycle = (id: string, teamId: string, startsAt: string, endsAt: string) =>
  ({ id, teamId, startsAt, endsAt }) as Cycle;
const NOW = Date.parse('2026-11-10T12:00:00Z');

describe('dashboard layout', () => {
  it('moves widgets along the order, stopping at the ends', () => {
    expect(ids(moveWidget(list, 'b', 1))).toBe('acbd');
    expect(ids(moveWidget(list, 'b', -5))).toBe('bacd');
    expect(moveWidget(list, 'd', 1)).toBe(list);
    expect(moveWidget(list, 'zz', 1)).toBe(list);
  });

  it('drops a dragged widget in the place of the one under it', () => {
    expect(ids(dropWidget(list, 'a', 'c'))).toBe('bcad');
    expect(ids(dropWidget(list, 'd', 'a'))).toBe('dabc');
  });

  it('resizes within the grid', () => {
    const [a] = resizeWidget(list, 'a', { w: 5, h: -3 });
    expect(a).toMatchObject({ w: 4, h: 1 });
    const [b] = resizeWidget([widget('b', { w: 3, h: 2 })], 'b', { w: -1, h: 1 });
    expect(b).toMatchObject({ w: 2, h: 3 });
  });

  it('adds new widgets at the end and replaces edited ones in place', () => {
    expect(ids(putWidget(list, widget('e')))).toBe('abcde');
    const edited = putWidget(list, widget('b', { days: 30 }));
    expect(ids(edited)).toBe('abcd');
    expect(edited[1]).toMatchObject({ days: 30 });
  });
});

describe('chart scopes', () => {
  const cycles = [
    cycle('old', 'eng', '2026-10-20', '2026-11-02'),
    cycle('now', 'eng', '2026-11-03', '2026-11-16'),
    cycle('other', 'ops', '2026-11-03', '2026-11-16'),
  ];
  // Short made-up ids, so no parsing (it wants UUIDs).
  const chart = (extra: object) =>
    ({ id: 'c', type: 'chart', w: 2, h: 1, measure: 'count', ...extra }) as DashboardWidget;

  it('finds the team’s running cycle', () => {
    expect(currentCycle(cycles, 'eng', '2026-11-16')?.id).toBe('now');
    expect(currentCycle(cycles, 'eng', '2026-11-17')).toBeUndefined();
  });

  it('asks for the current cycle, a project since its start, or the last weeks', () => {
    expect(
      timelineScope(chart({ chart: 'burnUp', teamId: 'eng', currentCycle: true }), cycles, NOW),
    ).toEqual({ cycleId: 'now' });
    expect(
      timelineScope(chart({ chart: 'burnUp', teamId: 'dev', currentCycle: true }), cycles, NOW),
    ).toBeNull();
    expect(timelineScope(chart({ chart: 'burndown', projectId: 'p' }), cycles, NOW)).toEqual({
      projectId: 'p',
      from: undefined,
    });
    expect(timelineScope(chart({ chart: 'cumulativeFlow', weeks: 4 }), cycles, NOW)).toEqual({
      from: '2026-10-14',
    });
    expect(timelineScope(chart({ chart: 'breakdown' }), cycles, NOW)).toBeNull();
  });
});
