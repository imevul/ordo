import {
  type NotifyPauseMode,
  STATUS_DURATIONS,
  type StatusDuration,
  USER_STATUS_PRESETS,
  USER_STATUSES,
  type UserStatusKind,
} from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bell, BellOff, Check, Keyboard, LogOut, Settings, Smile, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { signOut } from '../lib/signOut.ts';
import {
  durationLabel,
  pauseLine,
  statusKindLabel,
  statusLine,
  untilFrom,
  untilTime,
} from '../lib/status.ts';
import { ui } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { Modal } from './ui/Modal.tsx';
import { Popover } from './ui/Popover.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

/** Statuses offered right in the menu; the dialog has them all. */
const QUICK_STATUSES: UserStatusKind[] = ['away', 'focus', 'dnd', 'vacation'];

/** How long a pause lasts, from the menu. `morning` is tomorrow at 09:00. */
const PAUSE_FOR = ['30m', '1h', '2h', 'morning', 'never'] as const;
type PauseFor = (typeof PAUSE_FOR)[number];

function pauseUntil(d: PauseFor): string | null {
  if (d !== 'morning') return untilFrom(d);
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at.toISOString();
}

function useRefreshMe() {
  const qc = useQueryClient();
  const ws = useWorkspace();
  return () => {
    qc.invalidateQueries({ queryKey: keys.me });
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
  };
}

/** Your name, status and notification pause, at the bottom of the sidebar; account links live here too. */
export function ProfileMenu() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const refresh = useRefreshMe();
  const [dialog, setDialog] = useState(false);
  const me = ws.me;
  const p = { slug: ws.slug };

  const run = async (call: Promise<unknown>) => {
    try {
      await call;
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const quickStatus = (kind: UserStatusKind) => {
    const preset = USER_STATUS_PRESETS[kind];
    const until = untilFrom(preset.clearAfter);
    return run(api.put('/me/status', { kind, emoji: preset.emoji, until, pause: preset.pause }));
  };
  const pause = (mode: NotifyPauseMode | null, d: PauseFor = 'never') =>
    run(api.put('/me/notify-pause', { mode, until: mode ? pauseUntil(d) : null }));

  return (
    <>
      <Popover
        width={280}
        placement="top-start"
        trigger={
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left hover:bg-raised"
            aria-label={t('shell.status.menu')}
          >
            <Avatar
              name={me.name}
              color={me.avatarColor}
              src={me.avatarUrl}
              size={24}
              status={me.status}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-text">{me.name}</span>
              <span className="block truncate text-[11.5px] text-index">
                {me.status ? statusLine(me.status) : `@${me.username}`}
              </span>
            </span>
            {me.notifyPause && (
              <span title={pauseLine(me.notifyPause)} className="flex-none text-primary">
                <BellOff size={14} />
                <span className="sr-only">{pauseLine(me.notifyPause)}</span>
              </span>
            )}
          </button>
        }
      >
        {(close) => (
          <div className="py-1">
            <div className="px-3 pt-2 pb-1">
              <div className="truncate text-[13px] text-text">{me.name}</div>
              <div className="truncate font-mono text-[11px] text-index">{me.email}</div>
            </div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close();
                setDialog(true);
              }}
            >
              <Smile size={14} />
              {me.status ? statusLine(me.status) : t('shell.status.set')}
            </button>
            {me.status && (
              <button
                type="button"
                className="menu-item"
                onClick={() => run(api.del('/me/status'))}
              >
                <X size={14} /> {t('shell.status.clear')}
              </button>
            )}
            <div className="flex flex-wrap gap-1 px-3 py-1.5">
              {QUICK_STATUSES.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`tag hover:text-text ${me.status?.kind === kind ? 'text-primary' : ''}`}
                  aria-pressed={me.status?.kind === kind}
                  onClick={() => quickStatus(kind)}
                >
                  {USER_STATUS_PRESETS[kind].emoji} {statusKindLabel(kind)}
                </button>
              ))}
            </div>
            <div className="my-1 h-px bg-border-soft" />
            <div className="px-3 pt-1 pb-0.5 font-mono text-[10.5px] tracking-[0.14em] text-index uppercase">
              {t('shell.status.notifications')}
            </div>
            <button type="button" className="menu-item" onClick={() => pause(null)}>
              <Bell size={14} />
              {t('shell.status.pause.off')}
              {!me.notifyPause && <Check size={13} className="ml-auto text-primary" />}
            </button>
            {(['mentions', 'all'] as const).map((mode) => (
              <div key={mode} className="px-3 py-1">
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  <BellOff size={14} />
                  {t(`shell.status.pause.${mode}`)}
                  {me.notifyPause?.mode === mode && (
                    <span className="ml-auto truncate font-mono text-[10.5px] text-primary">
                      {me.notifyPause.until
                        ? t('shell.status.until', { time: untilTime(me.notifyPause.until) })
                        : t('shell.status.on')}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-1 pl-[22px]">
                  {PAUSE_FOR.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="tag hover:text-text"
                      onClick={() => pause(mode, d)}
                    >
                      {t(`shell.status.pauseFor.${d}`)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="my-1 h-px bg-border-soft" />
            <div onClick={close}>
              <Link
                to="/$slug/settings/$section"
                params={{ ...p, section: 'account' }}
                className="menu-item"
              >
                <Settings size={14} /> {t('shell.status.accountSettings')}
              </Link>
              <Link
                to="/$slug/settings/$section"
                params={{ ...p, section: 'notifications' }}
                className="menu-item"
              >
                <Bell size={14} /> {t('shell.status.notificationSettings')}
              </Link>
              <button
                type="button"
                className="menu-item"
                onClick={() => ui.set({ shortcuts: true })}
              >
                <Keyboard size={14} /> {t('shell.shortcuts.title')}
              </button>
              <button type="button" className="menu-item" onClick={() => signOut(qc)}>
                <LogOut size={14} /> {t('common.logOut')}
              </button>
            </div>
          </div>
        )}
      </Popover>
      {dialog && <StatusDialog onClose={() => setDialog(false)} />}
    </>
  );
}

type ClearAfter = StatusDuration | 'date' | 'keep';

/** Tomorrow as YYYY-MM-DD in local time, for the date picker. */
function tomorrow() {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Pick a status (or write one), how long it lasts, and whether it pauses your notifications. */
function StatusDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const refresh = useRefreshMe();
  const current = ws.me.status;
  const [kind, setKind] = useState<UserStatusKind | null>(current?.kind ?? null);
  const [emoji, setEmoji] = useState(current?.emoji ?? '');
  const [text, setText] = useState(current?.text ?? '');
  const [clearAfter, setClearAfter] = useState<ClearAfter>(
    current ? (current.until ? 'keep' : 'never') : 'today',
  );
  const [date, setDate] = useState(tomorrow);
  const [pause, setPause] = useState<NotifyPauseMode | null>(ws.me.notifyPause?.mode ?? null);
  const [busy, setBusy] = useState(false);

  const pick = (k: UserStatusKind) => {
    const preset = USER_STATUS_PRESETS[k];
    setKind(k);
    setEmoji(preset.emoji);
    setText('');
    setClearAfter(preset.clearAfter);
    setPause(preset.pause);
  };
  const until = () =>
    clearAfter === 'keep'
      ? (current?.until ?? null)
      : clearAfter === 'date'
        ? new Date(`${date}T00:00:00`).toISOString()
        : untilFrom(clearAfter);
  // A chosen date clears the status as that day starts, so it has to be a later day.
  const valid =
    !!(kind || emoji.trim() || text.trim()) &&
    (clearAfter !== 'date' || (!!date && new Date(`${date}T00:00:00`).getTime() > Date.now()));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await api.put('/me/status', {
        kind,
        emoji: emoji.trim() || null,
        text: text.trim() || null,
        until: until(),
        pause,
      });
      refresh();
      onClose();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} width={480} label={t('shell.status.dialogTitle')} align="center">
      <form onSubmit={save} className="overflow-y-auto p-6">
        <div className="section-label mb-4">{t('shell.status.dialogTitle')}</div>
        <div className="flex gap-2">
          <input
            className="input w-14 text-center"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="🙂"
            aria-label={t('shell.status.emoji')}
            maxLength={16}
          />
          <input
            className="input flex-1"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind ? statusKindLabel(kind) : t('shell.status.textPlaceholder')}
            aria-label={t('shell.status.text')}
            maxLength={100}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1">
          {USER_STATUSES.map((k) => (
            <button
              key={k}
              type="button"
              className="menu-item"
              data-active={kind === k}
              aria-pressed={kind === k}
              onClick={() => pick(k)}
            >
              <span className="w-5 text-center">{USER_STATUS_PRESETS[k].emoji}</span>
              {statusKindLabel(k)}
            </button>
          ))}
        </div>
        <label className="mt-4 block text-[12px] text-muted">
          {t('shell.status.clearAfter')}
          <div className="mt-1 flex gap-2">
            <select
              className="input flex-1"
              value={clearAfter}
              onChange={(e) => setClearAfter(e.target.value as ClearAfter)}
            >
              {current?.until && (
                <option value="keep">
                  {t('shell.status.keepUntil', { time: untilTime(current.until) })}
                </option>
              )}
              {STATUS_DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {durationLabel(d)}
                </option>
              ))}
              <option value="date">{t('shell.status.duration.date')}</option>
            </select>
            {clearAfter === 'date' && (
              <input
                type="date"
                className="input w-40"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label={t('shell.status.duration.date')}
              />
            )}
          </div>
        </label>
        <label className="mt-4 block text-[12px] text-muted">
          {t('shell.status.notifications')}
          <select
            className="input mt-1"
            value={pause ?? ''}
            onChange={(e) => setPause((e.target.value || null) as NotifyPauseMode | null)}
          >
            <option value="">{t('shell.status.pause.off')}</option>
            <option value="mentions">{t('shell.status.pause.mentions')}</option>
            <option value="all">{t('shell.status.pause.all')}</option>
          </select>
          <span className="mt-1 block text-index">{t('shell.status.pauseHint')}</span>
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!valid || busy}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
