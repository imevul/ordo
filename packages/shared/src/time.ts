/** The longest one time entry may be: a timer left running over a long weekend still fits. */
export const MAX_TIME_ENTRY_SECONDS = 7 * 24 * 3600;

const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };
// Longest unit names first, so "45 min" isn't read as "45 m" followed by "in".
const PART = /(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/y;

/**
 * Seconds in what someone typed: "1h 30m", "1h30m", "1.5h", "90m", "1:30" (h:mm) or a bare number
 * of hours ("1.5"). Null when it isn't a duration or comes to nothing.
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const clock = /^(\d+):([0-5]\d)$/.exec(s);
  if (clock) return positive(Number(clock[1]) * 3600 + Number(clock[2]) * 60);
  if (/^\d+(?:[.,]\d+)?$/.test(s)) return positive(Number(s.replace(',', '.')) * 3600);
  let total = 0;
  let at = 0;
  while (at < s.length) {
    PART.lastIndex = at;
    const m = PART.exec(s);
    if (!m) return null;
    total += Number(m[1]!.replace(',', '.')) * UNIT_SECONDS[m[2]![0]!]!;
    at = PART.lastIndex;
    while (s[at] === ' ') at++;
  }
  return positive(total);
}

const positive = (seconds: number) => {
  const rounded = Math.round(seconds);
  return rounded > 0 ? rounded : null;
};

/** "1h 30m", "45m", "2h"; under a minute rounds to "0m". */
export function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** A running timer's clock: "0:04:09", "12:30:00". */
export function formatClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
