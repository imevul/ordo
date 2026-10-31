import { describe, expect, it } from 'vitest';
import { dayInZone, isTimeZone, middayInZone } from './dates.ts';

describe('dayInZone', () => {
  const at = new Date('2026-11-08T23:30:00Z');
  it('is the calendar day in the zone', () => {
    expect(dayInZone('Europe/Stockholm', at)).toBe('2026-11-09');
    expect(dayInZone('America/New_York', at)).toBe('2026-11-08');
  });
  it('falls back to UTC without a known zone', () => {
    expect(dayInZone(null, at)).toBe('2026-11-08');
    expect(dayInZone('Mars/Olympus', at)).toBe('2026-11-08');
  });
  it('finds midday of a day in the zone', () => {
    expect(middayInZone('Pacific/Kiritimati', '2026-03-04')).toBe('2026-03-03T22:00:00.000Z');
    expect(
      dayInZone('Pacific/Kiritimati', new Date(middayInZone('Pacific/Kiritimati', '2026-03-04'))),
    ).toBe('2026-03-04');
    expect(middayInZone('Pacific/Auckland', '2026-01-10')).toBe('2026-01-09T23:00:00.000Z');
    expect(middayInZone('America/New_York', '2026-03-08')).toBe('2026-03-08T16:00:00.000Z');
    expect(middayInZone(null, '2026-03-04')).toBe('2026-03-04T12:00:00.000Z');
  });
  it('knows real zones only', () => {
    expect(isTimeZone('Europe/Oslo')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});
