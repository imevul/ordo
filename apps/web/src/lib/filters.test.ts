import type { IssueConditions } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import {
  activeKeys,
  canToggleNegation,
  hasConditions,
  setCondition,
  setExcluded,
  setGroup,
  toggleNegation,
  withClock,
} from './filters.ts';

describe('filter editing', () => {
  it('lists set conditions and drops emptied ones', () => {
    const f = setCondition({ labelIds: ['l1'] }, 'blocked', true);
    expect(activeKeys(f)).toEqual(['labelIds', 'blocked']);
    expect(setCondition(f, 'labelIds', [])).toEqual({ blocked: true });
    expect(activeKeys({ stateIds: [] })).toEqual([]);
  });

  it('moves a condition between "is" and "is not"', () => {
    const negated = toggleNegation({ assigneeIds: ['me'], priorities: [1] }, 'assigneeIds', false);
    expect(negated).toEqual({ priorities: [1], exclude: { assigneeIds: ['me'] } });
    expect(toggleNegation(negated, 'assigneeIds', true)).toEqual({
      priorities: [1],
      assigneeIds: ['me'],
    });
    // Flags flip in place; one found in `exclude` comes back flipped.
    expect(toggleNegation({ blocked: true }, 'blocked', false)).toEqual({ blocked: false });
    expect(toggleNegation({ exclude: { blocked: true } }, 'blocked', true)).toEqual({
      blocked: true,
    });
    expect(setExcluded({ exclude: { labelIds: ['x'] } }, 'labelIds', undefined)).toEqual({});
  });

  it('joins lists on the other side and keeps dates that would clash', () => {
    const both = { assigneeIds: ['me'], exclude: { assigneeIds: ['u1'] } };
    expect(toggleNegation(both, 'assigneeIds', false)).toEqual({
      exclude: { assigneeIds: ['u1', 'me'] },
    });
    const dates = {
      dueDate: { range: 'thisWeek' as const },
      exclude: { dueDate: { range: 'today' as const } },
    };
    expect(canToggleNegation(dates, 'dueDate', false)).toBe(false);
    expect(toggleNegation(dates, 'dueDate', false)).toBe(dates);
    expect(canToggleNegation({ dueDate: { range: 'today' } }, 'dueDate', false)).toBe(true);
  });

  it('keeps custom fields in customFields, one condition per field', () => {
    let f: IssueConditions = setCondition({}, 'field:f1', ['o1']);
    f = setCondition(f, 'field:f2', ['none']);
    expect(f).toEqual({ customFields: { f1: ['o1'], f2: ['none'] } });
    expect(activeKeys(f)).toEqual(['field:f1', 'field:f2']);
    f = toggleNegation(f, 'field:f1', false);
    expect(f).toEqual({
      customFields: { f2: ['none'] },
      exclude: { customFields: { f1: ['o1'] } },
    });
    expect(setCondition(f, 'field:f2', [])).toEqual({ exclude: { customFields: { f1: ['o1'] } } });
    expect(hasConditions({ exclude: { customFields: { f1: [] } } })).toBe(false);
  });

  it('adds, edits and drops "or" groups', () => {
    let f: IssueConditions = setGroup({}, 0, { hasPullRequest: true });
    f = setGroup(f, 5, { isSubIssue: true });
    expect(f.or).toEqual([{ hasPullRequest: true }, { isSubIssue: true }]);
    f = setGroup(f, 0, {});
    expect(f).toEqual({ or: [{ isSubIssue: true }] });
    expect(setGroup(f, 0, {})).toEqual({});
    expect(hasConditions({ or: [{ exclude: { blocked: true } }] })).toBe(true);
    expect(hasConditions({ or: [{}], exclude: {} })).toBe(false);
  });

  it('adds the clock only for relative dates', () => {
    const plain = { dueDate: { from: '2026-01-01' } };
    expect(withClock(plain, 'Europe/Oslo', 0)).toBe(plain);
    expect(withClock({ or: [{ createdAt: { range: 'today' } }] }, 'Europe/Oslo', 0)).toMatchObject({
      tz: 'Europe/Oslo',
      weekStartsOn: 0,
    });
    expect(withClock({ dueDate: { range: 'none' } }, 'Europe/Oslo', 0)).not.toHaveProperty('tz');
  });
});
