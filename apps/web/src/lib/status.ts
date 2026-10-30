import {
  type NotifyPause,
  type StatusDuration,
  UNAVAILABLE_STATUSES,
  type UserStatus,
  type UserStatusKind,
} from '@ordo/shared';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';

export const statusKindLabel = (kind: UserStatusKind) => t(`shell.status.kind.${kind}`);

/** The status's own words: its text, or the preset's name. */
export const statusText = (s: UserStatus) => s.text || (s.kind ? statusKindLabel(s.kind) : '');

/** "Mon 3 Nov" for a time at midnight, "Mon 3 Nov 14:30" otherwise, in the reader's language. */
export function untilTime(iso: string) {
  const d = new Date(iso);
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(INTL_TAG[getLocale()], {
    ...(sameDay ? {} : { weekday: 'short', day: 'numeric', month: 'short' }),
    ...(midnight && !sameDay ? {} : { hour: '2-digit', minute: '2-digit' }),
  });
}

/** "🌴 On vacation · until Mon 3 Nov": a status as one line. */
export function statusLine(s: UserStatus) {
  const head = [s.emoji, statusText(s)].filter(Boolean).join(' ');
  return s.until ? t('shell.status.lineUntil', { status: head, time: untilTime(s.until) }) : head;
}

/** Whether to warn people who assign or mention this person. */
export const isUnavailable = (s: UserStatus | null | undefined) =>
  !!s?.kind && UNAVAILABLE_STATUSES.includes(s.kind);

/** The dot on an avatar: red for do not disturb, amber when busy, grey when away or for a custom status. */
export function statusDotColor(s: UserStatus) {
  if (s.kind === 'dnd') return 'var(--color-error)';
  if (s.kind === 'meeting' || s.kind === 'focus') return 'var(--color-warning)';
  return 'var(--color-index)';
}

/** When a status or pause chosen as "for 1 hour", "today" … ends, in local time. Null: never. */
export function untilFrom(duration: StatusDuration, now = new Date()): string | null {
  const ms = { '30m': 30, '1h': 60, '2h': 120, '4h': 240 } as Record<string, number>;
  if (duration in ms) return new Date(now.getTime() + ms[duration]! * 60_000).toISOString();
  if (duration === 'never') return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // Today: until midnight. This week: until the coming Monday starts.
  d.setDate(d.getDate() + (duration === 'today' ? 1 : (8 - d.getDay()) % 7 || 7));
  return d.toISOString();
}

export const durationLabel = (d: StatusDuration) => t(`shell.status.duration.${d}`);

/** "Only mentions until 15:00": a pause as one line. */
export function pauseLine(p: NotifyPause) {
  const mode = t(`shell.status.pause.${p.mode}`);
  return p.until ? t('shell.status.lineUntil', { status: mode, time: untilTime(p.until) }) : mode;
}

/** "🌴 until Mon 2 Nov": short enough to sit next to a name in a picker. */
export function statusHint(s: UserStatus) {
  if (!s.until) return [s.emoji, statusText(s)].filter(Boolean).join(' ');
  const d = new Date(s.until);
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = d.toLocaleString(
    INTL_TAG[getLocale()],
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', day: 'numeric', month: 'short' },
  );
  return [s.emoji, t('shell.status.until', { time: when })].filter(Boolean).join(' ');
}
