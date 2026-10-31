/** Whether `zone` is an IANA time zone this runtime knows ("Europe/Stockholm", "UTC"). */
export function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A zone's canonical IANA name ("Asia/Kolkata" → "Asia/Calcutta", "US/Pacific-New" →
 * "America/Los_Angeles"), or null for an unknown zone or a UTC offset. Postgres reads "+01:00"
 * the POSIX way (an hour behind UTC) where Intl reads it as ahead, and may lack names Intl
 * still maps, so filters only pass canonical names to it.
 */
export function canonicalTimeZone(zone: string): string | null {
  if (/^[+-]/.test(zone) || !isTimeZone(zone)) return null;
  const name = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  return /^[+-]/.test(name) ? null : name;
}

/**
 * The calendar day (YYYY-MM-DD) it is at `at` in `zone`; UTC when there's no zone or the runtime
 * doesn't know it. Workspaces use this as "today" for cycles.
 */
export function dayInZone(zone: string | null | undefined, at: Date = new Date()) {
  if (zone && isTimeZone(zone)) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }
  return at.toISOString().slice(0, 10);
}

/**
 * Midday of a calendar day (YYYY-MM-DD) in `zone`, as an ISO instant; UTC midday without a known
 * zone. Midday is the same day in the zone whatever its offset, unlike midday UTC east of +12.
 */
export function middayInZone(zone: string | null | undefined, day: string) {
  const noon = Date.parse(`${day}T12:00:00Z`);
  if (!zone || !isTimeZone(zone)) return new Date(noon).toISOString();
  const wall = (t: number) => {
    const p = Object.fromEntries(
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
        .formatToParts(new Date(t))
        .map((x) => [x.type, Number(x.value)]),
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  // The zone's offset at UTC noon, then again at the corrected instant in case DST moved it.
  let at = noon - (wall(noon) - noon);
  at = noon - (wall(at) - at);
  return new Date(at).toISOString();
}
