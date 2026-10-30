import {
  type InboxFilter,
  NOTIFICATION_REASONS,
  NOTIFICATION_TYPES,
  type NotificationReason,
  type NotificationType,
} from '@ordo/shared';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.ts';
import { priorityOptions } from '../i18n/labels.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Modal } from './ui/Modal.tsx';

/** How many advanced filters are set, for the button's badge. */
export const advancedCount = (f: InboxFilter) =>
  (['types', 'teams', 'actors', 'priorities', 'reasons'] as const).filter((k) => f[k]?.length)
    .length + (f.from ? 1 : 0);

function toggle<T>(list: T[] | undefined, value: T, on: boolean): T[] | undefined {
  const next = on ? [...(list ?? []), value] : (list ?? []).filter((v) => v !== value);
  return next.length ? next : undefined;
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="mb-5">
      <legend className="section-label mb-2 w-full">{label}</legend>
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 py-1 text-[13px] text-muted">
      <input
        type="checkbox"
        className="accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="truncate">{children}</span>
    </label>
  );
}

/** The inbox's advanced filters. Changes apply as they're made. */
export function InboxFilterModal({
  open,
  onClose,
  filter,
  onChange,
  kindFromQuick,
}: {
  open: boolean;
  onClose: () => void;
  /** A quick filter other than All picks the kind, so the kinds here wait until All. */
  kindFromQuick: boolean;
  filter: InboxFilter;
  onChange: (f: InboxFilter) => void;
}) {
  const ws = useWorkspace();
  const set = <K extends keyof InboxFilter>(key: K, value: InboxFilter[K]) =>
    onChange({ ...filter, [key]: value });
  const people = ws.members
    .filter((m) => m.kind === 'human' && m.id !== ws.me.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal open={open} onClose={onClose} width={620} label={t('inbox.filter.title')}>
      <div className="flex min-h-0 flex-col">
        <div className="flex items-center border-b border-border-soft px-6 py-4">
          <div className="section-label flex-1">{t('inbox.filter.title')}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4">
          <Group label={t('inbox.filter.types')}>
            {kindFromQuick && (
              <p className="col-span-full mb-1 text-[12px] text-index">
                {t('inbox.filter.kindFromQuick')}
              </p>
            )}
            {NOTIFICATION_TYPES.map((type: NotificationType) => (
              <Check
                key={type}
                checked={!!filter.types?.includes(type)}
                onChange={(on) => set('types', toggle(filter.types, type, on))}
              >
                {t(`settings.notifications.types.${type}`)}
              </Check>
            ))}
          </Group>
          <Group label={t('inbox.filter.reasons')}>
            {NOTIFICATION_REASONS.map((r: NotificationReason) => (
              <Check
                key={r}
                checked={!!filter.reasons?.includes(r)}
                onChange={(on) => set('reasons', toggle(filter.reasons, r, on))}
              >
                {t(`inbox.filter.reason.${r}`)}
              </Check>
            ))}
          </Group>
          <Group label={t('inbox.filter.from')}>
            {(['people', 'bots'] as const).map((f) => (
              <Check
                key={f}
                checked={filter.from === f}
                onChange={(on) => set('from', on ? f : undefined)}
              >
                {t(`inbox.filter.fromKind.${f}`)}
              </Check>
            ))}
          </Group>
          {people.length > 0 && (
            <Group label={t('inbox.filter.actors')}>
              {people.map((m) => (
                <Check
                  key={m.id}
                  checked={!!filter.actors?.includes(m.id)}
                  onChange={(on) => set('actors', toggle(filter.actors, m.id, on))}
                >
                  {m.name}
                </Check>
              ))}
            </Group>
          )}
          {ws.teams.length > 1 && (
            <Group label={t('inbox.filter.teams')}>
              {ws.teams.map((team) => (
                <Check
                  key={team.id}
                  checked={!!filter.teams?.includes(team.id)}
                  onChange={(on) => set('teams', toggle(filter.teams, team.id, on))}
                >
                  {team.name}
                </Check>
              ))}
            </Group>
          )}
          <Group label={t('inbox.filter.priorities')}>
            {priorityOptions().map((p) => (
              <Check
                key={p.value}
                checked={!!filter.priorities?.includes(p.value)}
                onChange={(on) => set('priorities', toggle(filter.priorities, p.value, on))}
              >
                {p.label}
              </Check>
            ))}
          </Group>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-soft px-6 py-4">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={advancedCount(filter) === 0}
            onClick={() => onChange({})}
          >
            {t('inbox.filter.clear')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
