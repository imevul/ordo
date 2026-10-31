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
