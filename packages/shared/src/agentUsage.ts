import type { z } from 'zod';
import type { agentRunUsageSchema } from './schemas.ts';

/** What a runner reports about a pickup's usage (see `reportAgentRunSchema`). */
export type AgentRunUsageReport = z.infer<typeof agentRunUsageSchema>;

const count = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
const dollars = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * Usage from what a command printed: Claude Code's `--output-format json` result (or the last
 * `result` line of `stream-json`), with `total_cost_usd`, `duration_ms` and `usage.input_tokens`
 * and friends, or Ordo's own shape (`costUsd`, `inputTokens`, …). Null when it has neither.
 */
export function parseUsage(value: unknown): AgentRunUsageReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const u = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<string, unknown>;
  const report: AgentRunUsageReport = {
    inputTokens: count(o.inputTokens) ?? count(u.input_tokens),
    outputTokens: count(o.outputTokens) ?? count(u.output_tokens),
    cacheReadTokens: count(o.cacheReadTokens) ?? count(u.cache_read_input_tokens),
    cacheWriteTokens: count(o.cacheWriteTokens) ?? count(u.cache_creation_input_tokens),
    costUsd: dollars(o.costUsd) ?? dollars(o.total_cost_usd) ?? dollars(o.cost_usd),
    durationMs: count(o.durationMs) ?? count(o.duration_ms),
  };
  for (const k of Object.keys(report) as (keyof AgentRunUsageReport)[])
    if (report[k] === undefined) delete report[k];
  return Object.keys(report).length ? report : null;
}

/** The calendar month (UTC) of an ISO time, as YYYY-MM. */
export const monthOf = (iso: string) => iso.slice(0, 7);

/** The first instant of a YYYY-MM month (UTC), and of the month after it. */
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    end: new Date(Date.UTC(y, m, 1)).toISOString(),
  };
}
