import { describe, expect, it } from 'vitest';
import { classifyFailure, parseLimitReset } from './agentFailures.ts';

const CLAUDE_SPEND =
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 1am (Europe/Oslo)\n(exit code 1)";

describe('classifyFailure', () => {
  it('recognises usage and spend limits', () => {
    expect(classifyFailure(CLAUDE_SPEND)).toBe('usage_limit');
    expect(classifyFailure("You've hit your session limit · resets 3pm (UTC)")).toBe('usage_limit');
    expect(classifyFailure('Claude AI usage limit reached|1793430000')).toBe('usage_limit');
    expect(classifyFailure('Error: 429 Too Many Requests')).toBe('usage_limit');
    expect(classifyFailure('{"type":"rate_limit_error","message":"…"}')).toBe('usage_limit');
    expect(classifyFailure('Your credit balance is too low to access the API')).toBe('usage_limit');
  });

  it('leaves other failures alone', () => {
    expect(classifyFailure('Please log in first\n(exit code 1)')).toBeNull();
    expect(classifyFailure('TypeError: x is undefined\n(exit code 1)')).toBeNull();
    expect(classifyFailure('Timed out after 30 minutes')).toBeNull();
    expect(classifyFailure(null)).toBeNull();
    expect(classifyFailure('')).toBeNull();
  });
});

describe('parseLimitReset', () => {
  // 22:10 in Oslo on 30 October 2026 (UTC+1 after the DST change on the 25th).
  const evening = new Date('2026-10-30T21:10:00Z');

  it('finds the next such time in the named zone, across midnight', () => {
    expect(parseLimitReset(CLAUDE_SPEND, evening)).toBe('2026-10-31T00:00:00.000Z');
  });

  it('takes today when the time is still ahead', () => {
    const morning = new Date('2026-10-30T05:00:00Z'); // 06:00 in Oslo
    expect(parseLimitReset('resets 1:30pm (Europe/Oslo)', morning)).toBe(
      '2026-10-30T12:30:00.000Z',
    );
  });

  it('reads 12am and 12pm, 24-hour times and "at"', () => {
    expect(parseLimitReset('resets 12am (UTC)', evening)).toBe('2026-10-31T00:00:00.000Z');
    expect(parseLimitReset('resets at 12pm (UTC)', evening)).toBe('2026-10-31T12:00:00.000Z');
    expect(parseLimitReset('resets 23:30 (UTC)', evening)).toBe('2026-10-30T23:30:00.000Z');
  });

  it('reads a date', () => {
    expect(parseLimitReset('limit resets Nov 3, 9am (Europe/Oslo)', evening)).toBe(
      '2026-11-03T08:00:00.000Z',
    );
  });

  it('reads relative times and epoch stamps', () => {
    expect(parseLimitReset('resets in 3 hours', evening)).toBe('2026-10-31T00:10:00.000Z');
    expect(parseLimitReset('resets in 45 minutes', evening)).toBe('2026-10-30T21:55:00.000Z');
    expect(parseLimitReset('Claude AI usage limit reached|1793430000', evening)).toBe(
      new Date(1793430000 * 1000).toISOString(),
    );
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(parseLimitReset('resets 1am (Mars/Olympus)', evening)).toBe('2026-10-31T01:00:00.000Z');
  });

  it("returns null when there's no reset time", () => {
    expect(parseLimitReset("You've hit your monthly spend limit", evening)).toBeNull();
    expect(parseLimitReset('the counter resets 3 times', evening)).toBeNull();
    expect(parseLimitReset('resets 25pm (UTC)', evening)).toBeNull();
  });
});
