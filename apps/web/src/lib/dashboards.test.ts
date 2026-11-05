import {
  type AgentMetricPoint,
  type AgentMetricsReport,
  type Cycle,
  type DashboardWidget,
  dashboardWidgetSchema,
} from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import {
  AGENT_METRIC_LINES,
  agentMetricChart,
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

describe('agentMetricChart', () => {
  const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
  const point = (agentId: string, day: string, extra: Partial<AgentMetricPoint>) => ({
    agentId,
    day,
    runs: 1,
    durationMs: 0,
    durationRuns: 0,
    tokens: 0,
    tokenRuns: 0,
    costUsd: 0,
    costRuns: 0,
    ...extra,
  });
  const report = (points: AgentMetricPoint[]): AgentMetricsReport => ({ since: '', days, points });
  const two = report([
    point('a', days[0]!, { costUsd: 3, costRuns: 3, runs: 3 }),
    point('a', days[2]!, { costUsd: 2, costRuns: 1 }),
    point('b', days[0]!, { costUsd: 5, costRuns: 1, durationMs: 120_000, durationRuns: 1 }),
  ]);

  it('averages per run, each agent and all of them, with gaps on days without any', () => {
    const c = agentMetricChart(two, 'cost');
    expect(c.lines).toEqual([
      { agentId: 'a', slot: 0, values: [1, null, 2] },
      { agentId: 'b', slot: 1, values: [5, null, null] },
    ]);
    expect(c.average).toEqual([2, null, 2]);
    expect(c.overall).toEqual({ value: 2, runs: 5 });
    expect(c.hidden).toBe(0);
  });

  it('divides by the runs that reported the metric, and leaves out agents with none', () => {
    const c = agentMetricChart(two, 'duration');
    expect(c.lines).toEqual([{ agentId: 'b', slot: 1, values: [2, null, null] }]);
    // Only one agent reported it: the average would be the same line again.
    expect(c.average).toBeNull();
    expect(c.overall).toEqual({ value: 2, runs: 1 });
    expect(agentMetricChart(two, 'tokens')).toMatchObject({
      lines: [],
      average: null,
      overall: { value: null, runs: 0 },
    });
  });

  it('sets one agent against the average of all of them', () => {
    const c = agentMetricChart(two, 'cost', 'b');
    // In the slot it has on the graph of all agents.
    expect(c.lines).toEqual([{ agentId: 'b', slot: 1, values: [5, null, null] }]);
    expect(c.average).toEqual([2, null, 2]);
    expect(c.overall).toEqual({ value: 5, runs: 1 });
    expect(agentMetricChart(two, 'cost', 'gone').lines).toEqual([]);
  });

  it('draws the busiest agents, and an agent’s color does not depend on the metric', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const many = report(
      ids.map((id, i) =>
        // The quietest, g, is the only one to report durations but keeps out of the lines.
        point(id, days[0]!, {
          runs: 10 - i,
          costUsd: 1,
          costRuns: 1,
          ...(id === 'g' || id === 'c' ? { durationMs: 60_000, durationRuns: 1 } : {}),
        }),
      ),
    );
    const cost = agentMetricChart(many, 'cost');
    expect(cost.lines.map((l) => l.agentId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(cost.lines).toHaveLength(AGENT_METRIC_LINES);
    expect(cost.hidden).toBe(2);
    const duration = agentMetricChart(many, 'duration');
    expect(duration.lines).toEqual([{ agentId: 'c', slot: 2, values: [1, null, null] }]);
    expect(duration.hidden).toBe(1);
    // An agent past the lines still gets a graph of its own, in the first color.
    expect(agentMetricChart(many, 'cost', 'g').lines).toMatchObject([{ agentId: 'g', slot: 0 }]);
  });

  it('draws the average when the only agent to report a metric is past the lines', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const quietestReports = report(
      ids.map((id, i) =>
        point(id, days[1]!, {
          runs: 10 - i,
          ...(id === 'f' ? { costUsd: 0.5, costRuns: 1 } : {}),
        }),
      ),
    );
    const c = agentMetricChart(quietestReports, 'cost');
    expect(c.lines).toEqual([]);
    expect(c.average).toEqual([null, 0.5, null]);
    expect(c.hidden).toBe(1);
    expect(c.overall).toEqual({ value: 0.5, runs: 1 });
    // On its own graph it has a line, so the average would only repeat it.
    expect(agentMetricChart(quietestReports, 'cost', 'f')).toMatchObject({
      lines: [{ agentId: 'f', slot: 0, values: [null, 0.5, null] }],
      average: null,
    });
    // A graph of an agent with nothing to show stays a note, whoever else reports.
    expect(agentMetricChart(quietestReports, 'cost', 'a').overall.value).toBeNull();
  });
});

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
