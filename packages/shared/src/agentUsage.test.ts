import { describe, expect, it } from 'vitest';
import { monthRange, parseUsage } from './agentUsage.ts';

describe('parseUsage', () => {
  it("reads Claude Code's JSON result", () => {
    expect(
      parseUsage({
        type: 'result',
        subtype: 'success',
        result: 'Done.',
        duration_ms: 123_456,
        total_cost_usd: 0.4213,
        usage: {
          input_tokens: 1200,
          output_tokens: 3400,
          cache_read_input_tokens: 250_000,
          cache_creation_input_tokens: 18_000,
        },
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 3400,
      cacheReadTokens: 250_000,
      cacheWriteTokens: 18_000,
      costUsd: 0.4213,
      durationMs: 123_456,
    });
  });

  it("reads Ordo's own shape, and keeps only what's there", () => {
    expect(parseUsage({ costUsd: 1.5, outputTokens: 10 })).toEqual({
      costUsd: 1.5,
      outputTokens: 10,
    });
  });

  it('ignores anything else', () => {
    expect(parseUsage({ result: 'hi' })).toBeNull();
    expect(parseUsage({ total_cost_usd: -1, usage: { input_tokens: 'x' } })).toBeNull();
    expect(parseUsage([1, 2])).toBeNull();
    expect(parseUsage('{"total_cost_usd":1}')).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });
});

describe('monthRange', () => {
  it('spans the month in UTC, across a year end', () => {
    expect(monthRange('2026-12')).toEqual({
      start: '2026-12-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });
  });
});
