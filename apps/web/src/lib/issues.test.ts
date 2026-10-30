import {
  DEFAULT_ISSUE_DISPLAY,
  type GroupBy,
  type Issue,
  type IssueDisplay,
  type OrderBy,
} from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import { groupIssues, isDone, patchForGroup, sortIssues, visibleIssues } from './issues.ts';
import type { WorkspaceData } from './workspace.tsx';

let seq = 0;
const issue = (over: Partial<Issue> = {}): Issue =>
  ({
    id: `i${++seq}`,
    title: `Issue ${seq}`,
    teamId: 'eng',
    stateId: 'todo',
    priority: 0,
    assigneeId: null,
    labelIds: [],
    projectId: null,
    milestoneId: null,
    cycleId: null,
    parentId: null,
    dueDate: null,
    sortOrder: 0,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    ...over,
  }) as Issue;

const state = (id: string, type: string, position = 0) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  type,
  position,
  color: `#${id}`,
});

/**
 * Two teams: ENG without triage (its triage status must not become a group) and OPS with
 * triage, whose two unstarted statuses are listed out of position order.
 */
function workspace(): WorkspaceData {
  const teams = [
    {
      id: 'eng',
      key: 'ENG',
      triageEnabled: false,
      states: [
        state('done', 'completed'),
        state('todo', 'unstarted'),
        state('triage', 'triage'),
        state('doing', 'started'),
        state('backlog', 'backlog'),
        state('canceled', 'canceled'),
      ],
    },
    {
      id: 'ops',
      key: 'OPS',
      triageEnabled: true,
      states: [
        state('later', 'unstarted', 2),
        state('inbox', 'triage'),
        state('next', 'unstarted', 1),
        state('shipped', 'completed'),
      ],
    },
  ];
  const projects = [
    {
      id: 'p1',
      name: 'Alpha',
      color: '#a',
      milestones: [
        { id: 'm1', name: 'Beta' },
        { id: 'm2', name: 'GA' },
      ],
    },
    { id: 'p2', name: 'Bravo', color: '#b', milestones: [{ id: 'm3', name: 'Launch' }] },
  ];
  const members = [
    { id: 'ada', name: 'Ada', avatarColor: '#ada' },
    { id: 'bo', name: 'Bo', avatarColor: '#b0' },
  ];
  const placeholders = [{ id: 'imp', name: 'Imported Ivy', avatarColor: '#1' }];
  return {
    teams,
    teamById: new Map(teams.map((t) => [t.id, t])),
    stateById: new Map(teams.flatMap((t) => t.states).map((s) => [s.id, s])),
    members,
    placeholders,
    // As WorkspaceProvider builds it: placeholders are flagged; removed members aren't in it.
    memberById: new Map(
      [...placeholders.map((p) => ({ ...p, placeholder: true })), ...members].map((m) => [m.id, m]),
    ),
    projects,
    cycles: [
      { id: 'c1', teamId: 'eng', number: 1, name: '' },
      { id: 'c2', teamId: 'eng', number: 2, name: 'Polish' },
      { id: 'c3', teamId: 'ops', number: 1, name: '' },
    ],
    labels: [
      { id: 'bug', name: 'Bug', color: '#f00' },
      { id: 'feat', name: 'Feature', color: '#0f0' },
    ],
  } as unknown as WorkspaceData;
}

const ws = workspace();
const display = (over: Partial<IssueDisplay> = {}): IssueDisplay => ({
  ...DEFAULT_ISSUE_DISPLAY,
  ...over,
});
const group = (by: GroupBy, issues: Issue[], over: Partial<IssueDisplay> = {}, teamId?: string) =>
  groupIssues(ws, issues, display({ groupBy: by, ...over }), teamId);
const summary = (groups: ReturnType<typeof groupIssues>) =>
  groups.map((g) => [g.key, g.issues.map((i) => i.id)]);
const ids = (list: Issue[]) => list.map((i) => i.id);

describe('isDone', () => {
  it('is true for completed and canceled statuses only', () => {
    expect(isDone(ws, issue({ stateId: 'done' }))).toBe(true);
    expect(isDone(ws, issue({ stateId: 'canceled' }))).toBe(true);
    expect(isDone(ws, issue({ stateId: 'doing' }))).toBe(false);
    expect(isDone(ws, issue({ stateId: 'gone' }))).toBe(false);
  });
});

describe('sortIssues', () => {
  const a = issue({
    id: 'a',
    title: 'banana',
    priority: 0,
    sortOrder: 1,
    dueDate: null,
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
  });
  const b = issue({
    id: 'b',
    title: 'apple',
    priority: 3,
    sortOrder: 2,
    dueDate: '2026-11-02',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
  });
  const c = issue({
    id: 'c',
    title: 'cherry',
    priority: 1,
    sortOrder: 0,
    dueDate: '2026-11-01',
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  });
  const cases: [OrderBy, string[]][] = [
    ['manual', ['c', 'a', 'b']],
    ['priority', ['c', 'b', 'a']],
    ['updatedAt', ['b', 'a', 'c']],
    ['createdAt', ['a', 'c', 'b']],
    ['dueDate', ['c', 'b', 'a']],
    ['title', ['b', 'a', 'c']],
  ];
  it.each(cases)('orders by %s', (orderBy, expected) => {
    expect(ids(sortIssues([a, b, c], orderBy))).toEqual(expected);
  });

  it('breaks ties: manual by newest first, priority and dueDate by sort order', () => {
    const old = issue({ id: 'old', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' });
    const young = issue({ id: 'young', sortOrder: 1, createdAt: '2026-02-01T00:00:00Z' });
    expect(ids(sortIssues([old, young], 'manual'))).toEqual(['young', 'old']);

    const x = issue({ id: 'x', priority: 2, sortOrder: 5, dueDate: '2026-11-01' });
    const y = issue({ id: 'y', priority: 2, sortOrder: 1, dueDate: '2026-11-01' });
    expect(ids(sortIssues([x, y], 'priority'))).toEqual(['y', 'x']);
    expect(ids(sortIssues([x, y], 'dueDate'))).toEqual(['y', 'x']);
  });

  it('does not reorder the input', () => {
    const list = [a, b, c];
    sortIssues(list, 'title');
    expect(ids(list)).toEqual(['a', 'b', 'c']);
  });
});

describe('visibleIssues', () => {
  const open = issue({ id: 'open', stateId: 'todo' });
  const done = issue({ id: 'done', stateId: 'done' });
  const canceled = issue({ id: 'canceled', stateId: 'canceled' });
  const sub = issue({ id: 'sub', parentId: 'open' });
  const all = [open, done, canceled, sub];

  it('shows everything by default', () => {
    expect(ids(visibleIssues(ws, all, display()))).toEqual(['open', 'done', 'canceled', 'sub']);
  });

  it('hides completed and canceled issues', () => {
    expect(ids(visibleIssues(ws, all, display({ showCompleted: false })))).toEqual(['open', 'sub']);
  });

  it('hides sub-issues', () => {
    expect(ids(visibleIssues(ws, all, display({ showSubIssues: false })))).toEqual([
      'open',
      'done',
      'canceled',
    ]);
  });

  it('combines both filters', () => {
    const d = display({ showCompleted: false, showSubIssues: false });
    expect(ids(visibleIssues(ws, all, d))).toEqual(['open']);
  });
});

describe('groupIssues', () => {
  describe('by state', () => {
    const list = [
      issue({ id: 'e1', stateId: 'doing' }),
      issue({ id: 'e2', stateId: 'todo' }),
      issue({ id: 'e3', stateId: 'done' }),
    ];

    it("follows a single team's workflow in type order, without triage when it's off", () => {
      const groups = group('state', list, { showEmptyGroups: true });
      expect(groups.map((g) => g.key)).toEqual(['backlog', 'todo', 'doing', 'done', 'canceled']);
      expect(groups[1]).toMatchObject({
        label: 'Todo',
        value: 'todo',
        color: '#todo',
        stateType: 'unstarted',
      });
    });

    it('keeps triage for a team that has it, and orders statuses of a type by position', () => {
      const groups = group('state', [], { showEmptyGroups: true }, 'ops');
      expect(groups.map((g) => g.key)).toEqual(['inbox', 'next', 'later', 'shipped']);
    });

    it('uses the teamId argument even when no issues are given', () => {
      expect(group('state', [], { showEmptyGroups: true }, 'eng')[0].key).toBe('backlog');
    });

    it('drops empty groups unless asked to show them', () => {
      expect(summary(group('state', list))).toEqual([
        ['todo', ['e2']],
        ['doing', ['e1']],
        ['done', ['e3']],
      ]);
    });

    it('collapses into status types across teams', () => {
      const mixed = [...list, issue({ id: 'o1', teamId: 'ops', stateId: 'next' })];
      const groups = group('state', mixed, { showEmptyGroups: true });
      expect(groups.map((g) => g.key)).toEqual([
        'triage',
        'backlog',
        'unstarted',
        'started',
        'completed',
        'canceled',
      ]);
      expect(groups[2]).toMatchObject({ label: 'Unstarted', value: 'unstarted' });
      expect(summary(groups.filter((g) => g.issues.length))).toEqual([
        ['unstarted', ['e2', 'o1']],
        ['started', ['e1']],
        ['completed', ['e3']],
      ]);
    });
  });

  it('groups by priority, urgent first and no priority last', () => {
    const list = [0, 4, 3, 2, 1].map((p) => issue({ id: `p${p}`, priority: p }));
    const groups = group('priority', list);
    expect(summary(groups)).toEqual([
      ['p1', ['p1']],
      ['p2', ['p2']],
      ['p3', ['p3']],
      ['p4', ['p4']],
      ['p0', ['p0']],
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Urgent', 'High', 'Medium', 'Low', 'No priority']);
    expect(groups.map((g) => g.value)).toEqual([1, 2, 3, 4, 0]);
  });

  describe('by assignee', () => {
    it('makes a group per member and one for unassigned issues', () => {
      const list = [
        issue({ id: 'x', assigneeId: 'bo' }),
        issue({ id: 'y' }),
        issue({ id: 'z', assigneeId: 'ada' }),
      ];
      const groups = group('assignee', list);
      expect(summary(groups)).toEqual([
        ['ada', ['z']],
        ['bo', ['x']],
        ['none', ['y']],
      ]);
      expect(groups[0]).toMatchObject({ label: 'Ada', value: 'ada', color: '#ada' });
      expect(groups[2]).toMatchObject({ label: 'No assignee', value: null });
    });

    // ENG-11: issues assigned to placeholders (imports) or people who left the workspace
    // matched no group and vanished. Flip to `it` when the ENG-11 fix lands.
    it.fails('puts issues of placeholders and removed members in a group too', () => {
      const list = [
        issue({ id: 'member', assigneeId: 'ada' }),
        issue({ id: 'placeholder', assigneeId: 'imp' }),
        issue({ id: 'removed', assigneeId: 'gone' }),
        issue({ id: 'unassigned' }),
      ];
      const groups = group('assignee', list);
      // Every issue lands in exactly one group.
      expect(groups.flatMap((g) => ids(g.issues)).sort()).toEqual(ids(list).sort());
      const of = (id: string) => groups.find((g) => g.issues.some((i) => i.id === id));
      expect(of('placeholder')?.value).toBe('imp');
      expect(of('placeholder')?.label).toContain('Imported Ivy');
      expect(of('removed')?.value).toBe('gone');
      expect(of('unassigned')?.key).toBe('none');
    });
  });

  it('groups by project, with a group for issues without one', () => {
    const list = [
      issue({ id: 'x', projectId: 'p2' }),
      issue({ id: 'y' }),
      issue({ id: 'z', projectId: 'p1' }),
    ];
    const groups = group('project', list);
    expect(summary(groups)).toEqual([
      ['p1', ['z']],
      ['p2', ['x']],
      ['none', ['y']],
    ]);
    expect(groups[0]).toMatchObject({ label: 'Alpha', value: 'p1', color: '#a' });
    expect(groups[2]).toMatchObject({ label: 'No project', value: null });
  });

  describe('by milestone', () => {
    it('lists only the milestones of the projects in view, named plainly for one project', () => {
      const list = [issue({ id: 'x', projectId: 'p1', milestoneId: 'm2' }), issue({ id: 'y' })];
      const groups = group('milestone', list, { showEmptyGroups: true });
      expect(groups.map((g) => [g.key, g.label])).toEqual([
        ['m1', 'Beta'],
        ['m2', 'GA'],
        ['none', 'No milestone'],
      ]);
      expect(groups[1]).toMatchObject({ value: 'm2', color: '#a', issues: [list[0]] });
      expect(groups[2].issues).toEqual([list[1]]);
    });

    it('prefixes the project name when several projects are in view', () => {
      const list = [
        issue({ projectId: 'p1', milestoneId: 'm1' }),
        issue({ projectId: 'p2', milestoneId: 'm3' }),
      ];
      expect(group('milestone', list).map((g) => g.label)).toEqual([
        'Alpha · Beta',
        'Bravo · Launch',
      ]);
    });
  });

  describe('by cycle', () => {
    it("shows a single team's cycles by name or number", () => {
      const list = [issue({ id: 'x', cycleId: 'c2' }), issue({ id: 'y' })];
      const groups = group('cycle', list, { showEmptyGroups: true });
      expect(groups.map((g) => [g.key, g.label, g.value])).toEqual([
        ['c1', 'Cycle 1', 'c1'],
        ['c2', 'Polish', 'c2'],
        ['none', 'No cycle', null],
      ]);
      expect(summary(groups.filter((g) => g.issues.length))).toEqual([
        ['c2', ['x']],
        ['none', ['y']],
      ]);
    });

    it('shows every team’s cycles, prefixed with the team key, across teams', () => {
      const list = [issue({ cycleId: 'c1' }), issue({ teamId: 'ops', cycleId: 'c3' })];
      expect(group('cycle', list).map((g) => g.label)).toEqual(['ENG · Cycle 1', 'OPS · Cycle 1']);
    });
  });

  it('groups by label, putting an issue in each of its labels', () => {
    const list = [
      issue({ id: 'both', labelIds: ['bug', 'feat'] }),
      issue({ id: 'bug', labelIds: ['bug'] }),
      issue({ id: 'none' }),
    ];
    const groups = group('label', list);
    expect(summary(groups)).toEqual([
      ['bug', ['both', 'bug']],
      ['feat', ['both']],
      ['none', ['none']],
    ]);
    expect(groups[0]).toMatchObject({ label: 'Bug', value: 'bug', color: '#f00' });
    expect(groups[2]).toMatchObject({ label: 'No labels', value: null });
  });

  it('puts everything in one group when not grouping, even when empty', () => {
    expect(group('none', [])).toEqual([
      { key: 'all', label: 'All issues', value: null, issues: [] },
    ]);
    const list = [issue({ id: 'x' }), issue({ id: 'y' })];
    expect(summary(group('none', list))).toEqual([['all', ['x', 'y']]]);
  });

  it('sorts the issues within each group', () => {
    const list = [
      issue({ id: 'b', title: 'b', priority: 1 }),
      issue({ id: 'a', title: 'a', priority: 1 }),
    ];
    expect(summary(group('priority', list, { orderBy: 'title' }))).toEqual([['p1', ['a', 'b']]]);
  });
});

describe('patchForGroup', () => {
  const at = (stateId: string, teamId = 'eng') => issue({ stateId, teamId });
  const g = (value: string | number | null) => ({
    key: String(value),
    label: '',
    value,
    issues: [],
  });

  it('moves to a status, or does nothing when already there', () => {
    expect(patchForGroup(ws, 'state', g('doing'), at('todo'))).toEqual({ stateId: 'doing' });
    expect(patchForGroup(ws, 'state', g('todo'), at('todo'))).toEqual({});
  });

  it("maps a status type to the issue's team's first status of that type", () => {
    expect(patchForGroup(ws, 'state', g('unstarted'), at('inbox', 'ops'))).toEqual({
      stateId: 'next',
    });
    expect(patchForGroup(ws, 'state', g('started'), at('todo'))).toEqual({ stateId: 'doing' });
    // Already of that type: leave the status alone, even if it's not the first one.
    expect(patchForGroup(ws, 'state', g('unstarted'), at('later', 'ops'))).toEqual({});
  });

  it("returns null when the issue's team has no status of that type", () => {
    expect(patchForGroup(ws, 'state', g('started'), at('next', 'ops'))).toBeNull();
    expect(patchForGroup(ws, 'state', g(null), at('todo'))).toBeNull();
  });

  it('sets the grouped property for the other fields', () => {
    const i = issue();
    expect(patchForGroup(ws, 'priority', g(0), i)).toEqual({ priority: 0 });
    expect(patchForGroup(ws, 'assignee', g('ada'), i)).toEqual({ assigneeId: 'ada' });
    expect(patchForGroup(ws, 'assignee', g(null), i)).toEqual({ assigneeId: null });
    expect(patchForGroup(ws, 'project', g('p1'), i)).toEqual({ projectId: 'p1' });
    expect(patchForGroup(ws, 'project', g(null), i)).toEqual({ projectId: null });
    expect(patchForGroup(ws, 'cycle', g('c1'), i)).toEqual({ cycleId: 'c1' });
    expect(patchForGroup(ws, 'milestone', g(null), i)).toEqual({ milestoneId: null });
  });

  it("can't drop onto label groups or the ungrouped list", () => {
    expect(patchForGroup(ws, 'label', g('bug'), issue())).toBeNull();
    expect(patchForGroup(ws, 'none', g(null), issue())).toBeNull();
  });
});
