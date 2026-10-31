import type { CycleWorkload, WorkloadEntry } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import { loadBar, loadLevel, moveIssue } from './workload.ts';

const entry = (userId: string | null, issues: WorkloadEntry['issues']): WorkloadEntry => ({
  userId,
  load: issues.reduce((n, i) => n + (i.estimate ?? 0), 0),
  completed: 0,
  issueCount: issues.length,
  unestimated: issues.filter((i) => i.estimate == null).length,
  capacity: 5,
  capacitySource: 'team',
  outsideTeam: false,
  issues,
});
const issue = (n: number, estimate: number | null, completed = false) => ({
  id: `i${n}`,
  identifier: `ENG-${n}`,
  title: `Issue ${n}`,
  estimate,
  stateId: 's',
  completed,
});

describe('moveIssue', () => {
  const w: CycleWorkload = {
    cycleId: 'c',
    unit: 'points',
    entries: [entry('ann', [issue(2, 3), issue(10, null)]), entry('bob', [issue(9, 2)])],
  };

  it('moves the issue and its points, keeping issues in order', () => {
    const next = moveIssue(w, 'i2', 'bob');
    expect(next.entries[0]).toMatchObject({ load: 0, issueCount: 1, unestimated: 1 });
    expect(next.entries[1]).toMatchObject({ load: 5, issueCount: 2 });
    expect(next.entries[1]!.issues.map((i) => i.identifier)).toEqual(['ENG-2', 'ENG-9']);
  });

  it('adds an unassigned entry when there was none', () => {
    const next = moveIssue(w, 'i10', null);
    expect(next.entries.at(-1)).toMatchObject({ userId: null, issueCount: 1, unestimated: 1 });
    expect(next.entries[0]).toMatchObject({ issueCount: 1, unestimated: 0 });
  });

  it('leaves the workload alone for the same person or an unknown issue', () => {
    expect(moveIssue(w, 'i2', 'ann')).toBe(w);
    expect(moveIssue(w, 'nope', 'bob')).toBe(w);
  });
});

describe('loadLevel', () => {
  it('compares load with capacity', () => {
    expect(loadLevel({ load: 3, capacity: null })).toBe('unknown');
    expect(loadLevel({ load: 3, capacity: 5 })).toBe('under');
    expect(loadLevel({ load: 5, capacity: 5 })).toBe('full');
    expect(loadLevel({ load: 6, capacity: 5 })).toBe('over');
    expect(loadLevel({ load: 0, capacity: 0 })).toBe('under');
    expect(loadLevel({ load: 1, capacity: 0 })).toBe('over'); // on vacation, still assigned
  });
});

describe('loadBar', () => {
  it('fills against capacity and stops at its end', () => {
    expect(loadBar({ load: 4, completed: 1, capacity: 8 }, 20)).toEqual({
      load: 50,
      completed: 13,
    });
    expect(loadBar({ load: 12, completed: 0, capacity: 8 }, 20)).toEqual({
      load: 100,
      completed: 0,
    });
  });

  it('is relative to the busiest person without a capacity', () => {
    expect(loadBar({ load: 5, completed: 5, capacity: null }, 10)).toEqual({
      load: 50,
      completed: 50,
    });
    expect(loadBar({ load: 0, completed: 0, capacity: null }, 0)).toEqual({
      load: 0,
      completed: 0,
    });
    expect(loadBar({ load: 2, completed: 0, capacity: 0 }, 2)).toEqual({ load: 100, completed: 0 });
  });
});
