/** Today as a `YYYY-MM-DD` calendar date (UTC), the format cycle dates are compared in. */
export function todayDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether a cycle is running on `today`. `endsAt` is exclusive: on that day the next cycle has
 * started. Dates are compared as `YYYY-MM-DD`, so full ISO timestamps work too.
 */
export function isCycleCurrent(
  cycle: { startsAt: string; endsAt: string },
  today = todayDate(),
): boolean {
  const day = today.slice(0, 10);
  return cycle.startsAt.slice(0, 10) <= day && cycle.endsAt.slice(0, 10) > day;
}
