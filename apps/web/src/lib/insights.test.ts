import type { Issue } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import { breakdown, burnUp, durations, formatDays, weeklyFlow, weekStart } from './insights.ts';
import type { WorkspaceData } from './workspace.tsx';

const NOW = Date.parse('2026-10-28T12:00:00Z'); // a Wednesday

const issue = (over: Partial<Issue>): Issue =>
  ({
    id: Math.random().toString(36),
    stateId: 'todo',
    priority: 0,
    assigneeId: null,
    labelIds: [],
    projectId: null,
    cycleId: null,
    teamId: 't',
    estimate: null,
    createdAt: '2026-10-01T10:00:00Z',
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    ...over,
  }) as Issue;

const ws = {
  stateById: new Map([
    ['todo', { type: 'unstarted', name: 'Todo' }],
    ['doing', { type: 'started', name: 'Doing' }],
    ['done', { type: 'completed', name: 'Done' }],
  ]),
  memberById: new Map([['ada', { name: 'Ada' }]]),
  labelById: new Map([['bug', { name: 'Bug' }]]),
} as unknown as WorkspaceData;

describe('breakdown', () => {
  const list = [
    issue({ stateId: 'done', assigneeId: 'ada', estimate: 3, labelIds: ['bug'] }),
    issue({ stateId: 'todo', estimate: 2 }),
    issue({ stateId: 'doing', assigneeId: 'ada', priority: 1 }),
  ];
  it('keeps workflow order for statuses', () => {
    expect(breakdown(ws, list, 'state', 'count').map((b) => [b.label, b.value])).toEqual([
      ['Todo', 1],
      ['Doing', 1],
      ['Done', 1],
    ]);
  });
  it('sums estimates and sorts the rest by size', () => {
    expect(breakdown(ws, list, 'assignee', 'estimate')).toMatchObject([
      { label: 'Ada', value: 3 },
      { label: 'No assignee', value: 2 },
    ]);
    expect(breakdown(ws, list, 'label', 'count').map((b) => b.label)).toEqual(['No labels', 'Bug']);
    expect(breakdown(ws, list, 'priority', 'count').map((b) => b.key)).toEqual(['1', '0']);
  });
});

describe('time series', () => {
  it('finds Mondays', () => {
    expect(new Date(weekStart(NOW)).toISOString().slice(0, 10)).toBe('2026-10-26');
  });
  it('counts created and completed per week', () => {
    const flow = weeklyFlow(
      [
        issue({ createdAt: '2026-10-27T09:00:00Z', completedAt: '2026-10-28T09:00:00Z' }),
        issue({ createdAt: '2026-10-20T09:00:00Z' }),
        issue({ createdAt: '2025-01-01T09:00:00Z' }), // too old to show
      ],
      'count',
      2,
      NOW,
    );
    expect(flow).toEqual([
      { start: '2026-10-19', created: 1, completed: 0 },
      { start: '2026-10-26', created: 1, completed: 1 },
    ]);
  });
  it('burns up from a start day, dropping canceled work', () => {
    const points = burnUp(
      [
        issue({ createdAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-27T15:00:00Z' }),
        issue({ createdAt: '2026-10-27T08:00:00Z' }),
        issue({ createdAt: '2026-10-01T00:00:00Z', canceledAt: '2026-10-27T10:00:00Z' }),
      ],
      'count',
      '2026-10-26',
      '2026-11-09',
      NOW,
    );
    expect(points).toEqual([
      { day: '2026-10-26', scope: 2, completed: 0 },
      { day: '2026-10-27', scope: 2, completed: 1 },
      { day: '2026-10-28', scope: 2, completed: 1 },
    ]);
  });
  it('shows work added after a time box on its last day', () => {
    const points = burnUp(
      [issue({ createdAt: '2026-10-25T00:00:00Z', completedAt: '2026-10-26T00:00:00Z' })],
      'count',
      '2026-10-05',
      '2026-10-07',
      NOW,
    );
    expect(points.map((p) => [p.scope, p.completed])).toEqual([
      [0, 0],
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('durations', () => {
  it('reports median and p75 cycle and lead time', () => {
    const d = durations(
      [1, 2, 3, 10].map((days) =>
        issue({
          createdAt: '2026-10-01T00:00:00Z',
          startedAt: '2026-10-10T00:00:00Z',
          completedAt: new Date(
            Date.parse('2026-10-10T00:00:00Z') + days * 86_400_000,
          ).toISOString(),
        }),
      ),
      Date.parse('2026-09-01T00:00:00Z'),
    );
    expect(d.count).toBe(4);
    expect(d.cycle).toEqual({ median: 2.5, p75: 4.75 });
    expect(d.lead!.median).toBe(11.5);
    expect(formatDays(0.25)).toBe('6 h');
    expect(formatDays(2.54)).toBe('2.5 d');
  });
});
