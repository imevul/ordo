import type { Locale } from '@ordo/shared';
import {
  type Locale as DateLocale,
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isThisYear,
  parseISO,
} from 'date-fns';
import { enUS, nb, sv } from 'date-fns/locale';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';

const DATE_LOCALES: Record<Locale, DateLocale> = { en: enUS, sv, nb };

// Intl formatters are slow to build and dates are formatted per row; keep one per language.
const cache = new Map<string, Intl.DateTimeFormat>();
function dateFormat(options: Intl.DateTimeFormatOptions) {
  const key = `${getLocale()}:${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_TAG[getLocale()], options);
    cache.set(key, f);
  }
  return f;
}

export function relativeTime(iso: string) {
  const d = parseISO(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 45_000) return t('time.justNow');
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: DATE_LOCALES[getLocale()] });
}

/** "Oct 26" this year, "Oct 26, 2025" otherwise, in the reader's language's order. */
export function shortDate(iso: string) {
  const d = parseISO(iso);
  return dateFormat(
    isThisYear(d)
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  ).format(d);
}

export function longDate(iso: string) {
  const d = parseISO(iso);
  const date = dateFormat({ month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  const time = dateFormat({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${date} · ${time}`;
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
): { state: 'ok' | 'risk' | 'breached'; label: string; span: string } | null {
  if (!issue.slaBreachesAt || done) return null;
  const end = Date.parse(issue.slaBreachesAt);
  const left = end - now;
  const span = (ms: number) => {
    const h = Math.abs(ms) / 3_600_000;
    return h < 1
      ? t('time.minutesShort', { count: Math.max(1, Math.round(h * 60)) })
      : h < 48
        ? t('time.hoursShort', { count: Math.round(h) })
        : t('time.daysShort', { count: Math.round(h / 24) });
  };
  if (left <= 0)
    return {
      state: 'breached',
      label: t('time.slaBreached', { span: span(left) }),
      span: span(left),
    };
  const window = end - Date.parse(issue.createdAt);
  return {
    state: left < window / 4 ? 'risk' : 'ok',
    label: t('time.slaLeft', { span: span(left) }),
    span: span(left),
  };
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
