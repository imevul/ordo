import { describe, expect, it } from 'vitest';
import { isCycleCurrent } from './cycles.ts';

describe('isCycleCurrent', () => {
  const cycle = { startsAt: '2026-10-19', endsAt: '2026-11-02' };
  it('is not current before the start day', () =>
    expect(isCycleCurrent(cycle, '2026-10-18')).toBe(false));
  it('is current on the start day', () => expect(isCycleCurrent(cycle, '2026-10-19')).toBe(true));
  it('is current on the last day before endsAt', () =>
    expect(isCycleCurrent(cycle, '2026-11-01')).toBe(true));
  it('is not current on the endsAt day', () =>
    expect(isCycleCurrent(cycle, '2026-11-02')).toBe(false));
  it('compares ISO timestamps by date', () => {
    const iso = { startsAt: '2026-10-19T00:00:00.000Z', endsAt: '2026-11-02T00:00:00.000Z' };
    expect(isCycleCurrent(iso, '2026-11-01T23:59:59.000Z')).toBe(true);
    expect(isCycleCurrent(iso, '2026-11-02T00:00:00.000Z')).toBe(false);
  });
});
