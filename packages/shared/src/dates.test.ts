import { describe, expect, it } from 'vitest';
import { dayInZone, isTimeZone } from './dates.ts';

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
  it('knows real zones only', () => {
    expect(isTimeZone('Europe/Oslo')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});
