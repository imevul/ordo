import { dayInZone } from './dates.ts';

/**
 * Pieces of the issue filter that the server (`filterConditions`) and sync clients (`matchIssue`)
 * must read the same way.
 */

/**
 * Relative date ranges. "overdue" is before today on an open issue; "none" and "any" are about
 * whether the date is set at all.
 */
export const DATE_RANGES = [
  'overdue',
  'today',
  'thisWeek',
  'last7Days',
  'last30Days',
  'next14Days',
  'none',
  'any',
] as const;
export type DateRange = (typeof DATE_RANGES)[number];

export const DATE_FILTER_FIELDS = ['dueDate', 'createdAt', 'updatedAt', 'completedAt'] as const;
export type DateFilterField = (typeof DATE_FILTER_FIELDS)[number];

/** Filters that read relations and links, which the local copy doesn't keep. */
export const SERVER_ONLY_FILTERS = ['blocked', 'blocking', 'hasPullRequest'] as const;

/** Where "today" is: the zone decides when days start, `weekStartsOn` what "this week" is. */
export interface FilterClock {
  today: string;
  weekStartsOn: 0 | 1;
}

export function filterClock(
  tz: string | null | undefined,
  weekStartsOn: 0 | 1 | undefined,
  at: Date = new Date(),
): FilterClock {
  return { today: dayInZone(tz, at), weekStartsOn: weekStartsOn ?? 1 };
}

/** `day` (YYYY-MM-DD) moved by `n` days. */
export function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The inclusive days a relative range covers; open ends are undefined. */
export function rangeDays(
  range: Exclude<DateRange, 'none' | 'any'>,
  clock: FilterClock,
): { from?: string; to?: string } {
  const { today } = clock;
  switch (range) {
    case 'overdue':
      return { to: addDays(today, -1) };
    case 'today':
      return { from: today, to: today };
    case 'thisWeek': {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      const start = addDays(today, -((weekday - clock.weekStartsOn + 7) % 7));
      return { from: start, to: addDays(start, 6) };
    }
    case 'last7Days':
      return { from: addDays(today, -6), to: today };
    case 'last30Days':
      return { from: addDays(today, -29), to: today };
    case 'next14Days':
      return { from: today, to: addDays(today, 13) };
  }
}

/** Every value of `key` anywhere in a filter, its `exclude` and `or` groups included. */
export function filterValues<T = unknown>(f: object, key: string): T[] {
  const out: T[] = [];
  const walk = (c: Record<string, unknown> | undefined) => {
    if (!c) return;
    if (c[key] !== undefined) out.push(c[key] as T);
    walk(c.exclude as Record<string, unknown> | undefined);
    for (const g of (c.or as Record<string, unknown>[] | undefined) ?? []) walk(g);
  };
  walk(f as Record<string, unknown>);
  return out;
}

/** How deeply `exclude` and `or` nest in a filter (0 for none). */
export function filterDepth(f: object): number {
  const c = f as { exclude?: object; or?: object[] };
  const inner = [...(c.exclude ? [c.exclude] : []), ...(c.or ?? [])];
  return inner.length ? 1 + Math.max(...inner.map(filterDepth)) : 0;
}
