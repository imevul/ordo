import { describe, expect, it } from 'vitest';
import { estimateLabel, priorityLabel } from './constants.ts';

describe('labels', () => {
  it('names priorities, falling back to no priority for unknown values', () => {
    expect(priorityLabel(1)).toBe('Urgent');
    expect(priorityLabel(4)).toBe('Low');
    expect(priorityLabel(9)).toBe('No priority');
  });

  it('formats estimates per scale', () => {
    expect(estimateLabel('tshirt', 3)).toBe('M');
    expect(estimateLabel('tshirt', 4)).toBe('4');
    expect(estimateLabel('fibonacci', 1)).toBe('1 point');
    expect(estimateLabel('fibonacci', 5)).toBe('5 points');
    expect(estimateLabel('linear', null)).toBe('No estimate');
  });
});
