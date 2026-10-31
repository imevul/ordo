import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, parseDuration } from './time.ts';

describe('parseDuration', () => {
  it('reads hours and minutes', () => {
    expect(parseDuration('1h 30m')).toBe(5400);
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('  2H ')).toBe(7200);
    expect(parseDuration('90m')).toBe(5400);
    expect(parseDuration('45 min')).toBe(2700);
    expect(parseDuration('1 hour 5 minutes')).toBe(3900);
    expect(parseDuration('30s')).toBe(30);
  });
  it('reads decimals, clocks and bare hours', () => {
    expect(parseDuration('1.5h')).toBe(5400);
    expect(parseDuration('1,5h')).toBe(5400);
    expect(parseDuration('1:30')).toBe(5400);
    expect(parseDuration('1.5')).toBe(5400);
    expect(parseDuration('2')).toBe(7200);
  });
  it('rejects what is not a duration', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('1h tomorrow')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('1:75')).toBeNull();
    expect(parseDuration('h')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('shows hours and minutes', () => {
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(2700)).toBe('45m');
    expect(formatDuration(20)).toBe('0m');
    expect(formatDuration(89)).toBe('1m');
  });
  it('formats a running clock', () => {
    expect(formatClock(249)).toBe('0:04:09');
    expect(formatClock(45000)).toBe('12:30:00');
  });
});
