import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isThisYear,
  parseISO,
} from 'date-fns';

export function relativeTime(iso: string) {
  const d = parseISO(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 45_000) return 'just now';
  return `${formatDistanceToNowStrict(d)} ago`;
}

export function shortDate(iso: string) {
  const d = parseISO(iso);
  return format(d, isThisYear(d) ? 'MMM d' : 'MMM d, yyyy');
}

export function longDate(iso: string) {
  return format(parseISO(iso), 'MMM d, yyyy · HH:mm');
}

export function dueState(
  dueDate: string | null,
  done: boolean,
): 'overdue' | 'soon' | 'later' | null {
  if (!dueDate || done) return null;
  const days = differenceInCalendarDays(parseISO(dueDate), new Date());
  if (days < 0) return 'overdue';
  if (days <= 2) return 'soon';
  return 'later';
}

/**
 * Where an issue stands against its SLA: time left, or how long ago it ran out. At risk in the
 * last quarter of its window.
 */
export function slaState(
  issue: { slaBreachesAt: string | null; createdAt: string },
  done: boolean,
  now = Date.now(),
): { state: 'ok' | 'risk' | 'breached'; label: string } | null {
  if (!issue.slaBreachesAt || done) return null;
  const end = Date.parse(issue.slaBreachesAt);
  const left = end - now;
  const span = (ms: number) => {
    const h = Math.abs(ms) / 3_600_000;
    return h < 1
      ? `${Math.max(1, Math.round(h * 60))}m`
      : h < 48
        ? `${Math.round(h)}h`
        : `${Math.round(h / 24)}d`;
  };
  if (left <= 0) return { state: 'breached', label: `SLA −${span(left)}` };
  const window = end - Date.parse(issue.createdAt);
  return { state: left < window / 4 ? 'risk' : 'ok', label: `SLA ${span(left)}` };
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const today = () => new Date().toISOString().slice(0, 10);

export function addDays(isoDate: string, days: number) {
  const d = parseISO(isoDate);
  d.setDate(d.getDate() + days);
  return format(d, 'yyyy-MM-dd');
}

export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
