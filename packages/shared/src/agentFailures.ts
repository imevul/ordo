import type { AgentRunFailureReason } from './constants.ts';
import { isTimeZone } from './dates.ts';

/**
 * Reading a failed run's output: did the agent's account hit a usage limit, and when does it
 * reset? Only ever applied to runs that failed, so an agent's summary that merely talks about
 * limits is never mistaken for one.
 */

const LIMIT_PATTERNS = [
  // Claude Code: "You've hit your monthly spend limit", "You've hit your session limit"
  /\bhit (?:your|the) [\w -]{0,30}limit\b/i,
  /\b(?:usage|spend|spending|session|weekly|monthly|daily) limit\b/i,
  /\brate[_ ]limit(?:_error|ed)?\b/i,
  /\b429\b[^\n]{0,40}\b(?:too many requests|rate)/i,
  /\bcredit balance is too low\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
];

/** `usage_limit` when the text says the agent's account ran out, else null. */
export function classifyFailure(text: string | null | undefined): AgentRunFailureReason | null {
  if (!text) return null;
  return LIMIT_PATTERNS.some((re) => re.test(text)) ? 'usage_limit' : null;
}

/** When a usage limit isn't said to reset at any particular time: try again in an hour. */
export const DEFAULT_LIMIT_PAUSE_MS = 60 * 60_000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * When the limit in `text` resets, as an ISO time after `now`, or null when it doesn't say.
 * Understands "resets 1am (Europe/Oslo)", "resets at 1:30pm (UTC)", "resets 13:00 (UTC)",
 * "resets Nov 1, 1am (Europe/Oslo)", "resets in 3 hours" and "usage limit reached|<epoch>".
 */
export function parseLimitReset(text: string, now: Date = new Date()): string | null {
  const epoch = /limit reached\|(\d{10})\b/i.exec(text);
  if (epoch) {
    const at = new Date(Number(epoch[1]) * 1000);
    return at > now ? at.toISOString() : null;
  }

  const rel = /\bresets?\s+in\s+(\d+)\s*(h(?:ours?|rs?)?|m(?:inutes?|ins?)?)\b/i.exec(text);
  if (rel) {
    const unit = rel[2]!.toLowerCase().startsWith('h') ? 3_600_000 : 60_000;
    return new Date(now.getTime() + Number(rel[1]) * unit).toISOString();
  }

  const at =
    /\bresets?\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!at) return null;
  const [, monthName, dayOfMonth, h, m, meridiem, zoneText] = at;
  // A bare number with neither minutes nor am/pm ("resets 3 times") isn't a time.
  if (m === undefined && !meridiem) return null;
  let hour = Number(h);
  const minute = m ? Number(m) : 0;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const zone = zoneText && isTimeZone(zoneText.trim()) ? zoneText.trim() : 'UTC';
  const today = wallClock(now, zone);

  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return null;
    for (const year of [today.year, today.year + 1]) {
      const when = zonedTime(year, month, Number(dayOfMonth), hour, minute, zone);
      if (when > now) return when.toISOString();
    }
    return null;
  }
  // The next time the clock in `zone` shows hour:minute: today, or else tomorrow.
  for (const plus of [0, 1]) {
    const when = zonedTime(today.year, today.month, today.day + plus, hour, minute, zone);
    if (when > now) return when.toISOString();
  }
  return null;
}

function wallClock(at: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return { ...parts, month: parts.month - 1 };
}

/** The instant the clock in `zone` reads the given wall time (month 0-based; day may overflow). */
function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
) {
  const wanted = Date.UTC(year, month, day, hour, minute);
  let guess = wanted;
  // Twice, so a DST change between the guess and the answer settles.
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(guess), zone);
    const shown = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second);
    guess += wanted - shown;
  }
  return new Date(guess);
}
