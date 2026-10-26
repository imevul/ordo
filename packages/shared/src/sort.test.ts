import { describe, expect, it } from 'vitest';
import { estimateLabel, priorityLabel } from './constants.ts';
import { DEFAULT_ISSUE_DISPLAY, issueFilterSchema } from './schemas.ts';
import { SORT_GAP, sortOrderBetween } from './sort.ts';

describe('sortOrderBetween', () => {
  it('returns 0 for an empty list', () => expect(sortOrderBetween()).toBe(0));
  it('appends after the last item', () => expect(sortOrderBetween(10, null)).toBe(10 + SORT_GAP));
  it('prepends before the first item', () =>
    expect(sortOrderBetween(null, 10)).toBe(10 - SORT_GAP));
  it('takes the midpoint between neighbours', () => expect(sortOrderBetween(1, 2)).toBe(1.5));
});

describe('schemas', () => {
  it('accepts me/none tokens in filters', () => {
    expect(issueFilterSchema.parse({ assigneeIds: ['me', 'none'] }).assigneeIds).toEqual([
      'me',
      'none',
    ]);
  });
  it('has list layout grouped by state by default', () => {
    expect(DEFAULT_ISSUE_DISPLAY).toMatchObject({ layout: 'list', groupBy: 'state' });
  });
});

describe('labels', () => {
  it('formats priorities and estimates', () => {
    expect(priorityLabel(1)).toBe('Urgent');
    expect(estimateLabel('tshirt', 3)).toBe('M');
    expect(estimateLabel('fibonacci', 1)).toBe('1 point');
  });
});
