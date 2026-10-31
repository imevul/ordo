import { describe, expect, it } from 'vitest';
import { issueFilterSchema } from './schemas.ts';
import { sortOrderBetween } from './sort.ts';

describe('sortOrderBetween', () => {
  it('returns 0 for an empty list', () => expect(sortOrderBetween()).toBe(0));
  it('places items after the last and before the first, leaving room on both sides', () => {
    const after = sortOrderBetween(10, null);
    const before = sortOrderBetween(null, 10);
    expect(after).toBeGreaterThan(10);
    expect(before).toBeLessThan(10);
    // Room for a midpoint without running into float precision.
    expect(sortOrderBetween(10, after)).not.toBe(10);
    expect(sortOrderBetween(before, 10)).not.toBe(10);
  });
  it('takes the midpoint between neighbours', () => expect(sortOrderBetween(1, 2)).toBe(1.5));
  it('keeps order across repeated inserts at the same spot', () => {
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = sortOrderBetween(0, hi);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(hi);
      hi = mid;
    }
  });
});

describe('schemas', () => {
  it('accepts me/none tokens in filters', () => {
    expect(issueFilterSchema.parse({ assigneeIds: ['me', 'none'] }).assigneeIds).toEqual([
      'me',
      'none',
    ]);
  });
});
