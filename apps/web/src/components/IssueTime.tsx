import {
  formatClock,
  formatDuration,
  type IssueDetail,
  parseDuration,
  type TimeEntry,
} from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { Clock, Pencil, Play, Plus, Square, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useIssueTime, useRunningTimer, useWsMutation } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { shortDate } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { confirmDialog } from './ui/Modal.tsx';
import { Popover } from './ui/Popover.tsx';

const timeKey = (slug: string) => ['ws', slug, 'time'] as const;

/** Seconds since `iso`, ticking every second while `on`. */
export function useElapsed(iso: string | undefined, on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return iso ? Math.max(0, (now - new Date(iso).getTime()) / 1000) : 0;
}

/** The local calendar day of a timestamp (now by default), as YYYY-MM-DD. */
const localDay = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Time logged on the issue, the timer, and logging time by hand. Only when the workspace has it on. */
export function IssueTime({ issue }: { issue: IssueDetail }) {
  const ws = useWorkspace();
  const on = ws.workspace.settings.timeTracking;
  const { data } = useIssueTime(ws.slug, issue.id, on);
  const { data: timer } = useRunningTimer(ws.slug, on);
  const runningHere = timer?.entry.issueId === issue.id ? timer.entry : null;
  const elapsed = useElapsed(runningHere?.startedAt, !!runningHere);
  const invalidate = [timeKey(ws.slug)];
  const start = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/issues/${issue.id}/timer`), {}),
    { invalidate },
  );
  const stop = useWsMutation(ws.slug, () => api.post(wsPath(ws.slug, '/timer/stop'), {}), {
    invalidate,
  });
  const log = useWsMutation(
    ws.slug,
    (body: object) => api.post(wsPath(ws.slug, `/issues/${issue.id}/time-entries`), body),
    { invalidate },
  );
  if (!on) return null;

  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="section-label">{t('timeTracking.issue.title')}</div>
        {!!data?.totalSeconds && (
          <span className="font-mono text-[11.5px] text-muted">
            {t('timeTracking.issue.total', { time: formatDuration(data.totalSeconds) })}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {runningHere ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={stop.isPending}
              onClick={() => stop.mutate(undefined)}
            >
              <Square size={11} /> <span className="font-mono">{formatClock(elapsed)}</span>
              <span className="sr-only">{t('timeTracking.issue.stop')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={start.isPending}
              onClick={() => start.mutate(undefined)}
            >
              <Play size={11} /> {t('timeTracking.issue.start')}
            </button>
          )}
          <Popover
            width={320}
            placement="bottom-end"
            trigger={
              <button type="button" className="btn btn-ghost btn-sm">
                <Plus size={12} /> {t('timeTracking.issue.log')}
              </button>
            }
          >
            {(close) => (
              <TimeEntryForm
                pending={log.isPending}
                onSubmit={(body) => log.mutate(body, { onSuccess: close })}
              />
            )}
          </Popover>
        </div>
      </div>
      {data?.entries.map((e) => (
        <TimeEntryRow key={e.id} entry={e} />
      ))}
      {data && data.entries.length === 0 && (
        <p className="px-2 font-mono text-[12px] text-index">{t('timeTracking.issue.empty')}</p>
      )}
    </section>
  );
}

/** The sidebar's reminder of a running timer, wherever you are: its issue, the clock and a stop button. */
export function RunningTimerItem() {
  const ws = useWorkspace();
  const { data: timer } = useRunningTimer(ws.slug, true);
  const elapsed = useElapsed(timer?.entry.startedAt, !!timer);
  const stop = useWsMutation(ws.slug, () => api.post(wsPath(ws.slug, '/timer/stop'), {}), {
    invalidate: [timeKey(ws.slug)],
  });
  if (!timer) return null;
  const label = t('timeTracking.timer.runningOn', { identifier: timer.issue.identifier });
  return (
    <div className="flex items-center">
      <Link
        to="/$slug/issue/$identifier"
        params={{ slug: ws.slug, identifier: timer.issue.identifier || timer.issue.id }}
        className="nav-item min-w-0 flex-1"
        title={`${label} — ${timer.issue.title}`}
      >
        <Clock size={15} className="text-primary" />
        <span className="truncate font-mono text-[12px]">{timer.issue.identifier}</span>
        <span className="ml-auto font-mono text-[12px] text-primary">{formatClock(elapsed)}</span>
      </Link>
      <button
        type="button"
        className="flex h-7 w-7 flex-none items-center justify-center text-muted hover:text-primary"
        aria-label={t('timeTracking.timer.stop')}
        title={t('timeTracking.timer.stop')}
        disabled={stop.isPending}
        onClick={() => stop.mutate(undefined)}
      >
        <Square size={12} />
      </button>
    </div>
  );
}

function TimeEntryRow({ entry }: { entry: TimeEntry }) {
  const ws = useWorkspace();
  const person = entry.userId ? ws.memberById.get(entry.userId) : undefined;
  const running = entry.durationSeconds === null;
  const elapsed = useElapsed(entry.startedAt, running);
  const mine = entry.userId === ws.me.id;
  const canChange = mine || ws.isAdmin;
  const invalidate = [timeKey(ws.slug)];
  const save = useWsMutation(
    ws.slug,
    (body: object) => api.patch(wsPath(ws.slug, `/time-entries/${entry.id}`), body),
    { invalidate },
  );
  const remove = useWsMutation(
    ws.slug,
    () => api.del(wsPath(ws.slug, `/time-entries/${entry.id}`)),
    { invalidate },
  );
  return (
    <div className="group flex items-center gap-2 border-b border-border-soft/60 px-2 py-2">
      {person && (
        <Avatar name={person.name} color={person.avatarColor} src={person.avatarUrl} size={16} />
      )}
      <span className="w-24 flex-none truncate text-[13px] text-muted">
        {person?.name.split(' ')[0] ?? t('timeTracking.report.formerMember')}
      </span>
      <span
        className={`w-20 flex-none font-mono text-[12.5px] ${running ? 'text-primary' : 'text-text'}`}
      >
        {running ? formatClock(elapsed) : formatDuration(entry.durationSeconds!)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{entry.note}</span>
      <span className="flex-none font-mono text-[11px] text-index">
        {shortDate(entry.startedAt)}
      </span>
      {/* Running timers are stopped, not edited; keep the dates lined up. */}
      {canChange && running && <span className="w-6 flex-none" />}
      {canChange && !running && (
        <Popover
          width={320}
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-index opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-text"
              aria-label={t('timeTracking.issue.edit')}
            >
              <Pencil size={12} />
            </button>
          }
        >
          {(close) => (
            <TimeEntryForm
              entry={entry}
              pending={save.isPending}
              onSubmit={(body) => save.mutate(body, { onSuccess: close })}
            />
          )}
        </Popover>
      )}
      {canChange && (
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-index opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-text"
          aria-label={t('timeTracking.issue.remove')}
          onClick={async () => {
            if (await confirmDialog({ title: t('timeTracking.issue.removeConfirm'), danger: true }))
              remove.mutate(undefined);
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** Time spent ("1h 30m"), the day and a note; for a new entry or changing one. */
function TimeEntryForm({
  entry,
  pending,
  onSubmit,
}: {
  entry?: TimeEntry;
  pending: boolean;
  onSubmit: (body: { durationSeconds: number; note: string; startedAt?: string }) => void;
}) {
  const [duration, setDuration] = useState(
    entry?.durationSeconds ? formatDuration(entry.durationSeconds) : '',
  );
  const initialDay = localDay(entry?.startedAt);
  const [day, setDay] = useState(initialDay);
  const [note, setNote] = useState(entry?.note ?? '');
  const [error, setError] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const seconds = parseDuration(duration);
    if (!seconds) {
      setError(true);
      return;
    }
    // A day other than the one it had (today, for new entries) is logged at midday there.
    const startedAt = day !== initialDay ? new Date(`${day}T12:00`).toISOString() : undefined;
    onSubmit({ durationSeconds: seconds, note, startedAt });
  };
  return (
    <form className="p-3" onSubmit={submit}>
      <label className="mb-1 block text-[12px] text-muted" htmlFor="time-duration">
        {t('timeTracking.form.duration')}
      </label>
      <input
        id="time-duration"
        className="input mb-1 font-mono"
        placeholder={t('timeTracking.form.durationPlaceholder')}
        value={duration}
        autoFocus
        aria-invalid={error}
        onChange={(e) => {
          setDuration(e.target.value);
          setError(false);
        }}
      />
      <p className={`mb-2 text-[11.5px] ${error ? 'text-error' : 'text-index'}`}>
        {error ? t('timeTracking.form.invalidDuration') : t('timeTracking.form.durationHint')}
      </p>
      <label className="mb-1 block text-[12px] text-muted" htmlFor="time-day">
        {t('timeTracking.form.date')}
      </label>
      <input
        id="time-day"
        type="date"
        className="input mb-2"
        value={day}
        max={localDay()}
        required
        onChange={(e) => setDay(e.target.value)}
      />
      <textarea
        className="input mb-3 min-h-16 resize-y py-2"
        placeholder={t('timeTracking.form.notePlaceholder')}
        aria-label={t('timeTracking.form.note')}
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
      />
      <button className="btn btn-primary btn-sm w-full" disabled={pending || !duration.trim()}>
        {entry ? t('timeTracking.form.save') : t('timeTracking.issue.log')}
      </button>
    </form>
  );
}
