import {
  type EmailDigest,
  INBOX_ONLY_TYPES,
  NOTIFICATION_TYPES,
  type NotificationType,
} from '@ordo/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../api/client.ts';
import { useAccount, useConfig } from '../../../api/queries.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
import { t } from '../../../i18n/index.ts';
import { disablePush, enablePush, type PushState, pushState } from '../../../lib/push.ts';
import { FormRow, SettingsCard } from '../ui.tsx';

import { errMsg, useRefreshAccount } from './shared.ts';

const notificationLabel = (type: NotificationType) => t(`settings.notifications.types.${type}`);

/** Push notifications on this device (each browser or installed app subscribes on its own). */
export function PushCard() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushState().then(setState, () => setState('unsupported'));
  }, []);
  const toggle = async () => {
    setBusy(true);
    try {
      setState(await (state === 'on' ? disablePush() : enablePush()));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard title={t('settings.push.title')} description={t('settings.push.description')}>
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[13px] text-muted">
          {state === null
            ? t('settings.push.checking')
            : state === 'unsupported'
              ? t('settings.push.unsupported')
              : state === 'denied'
                ? t('settings.push.denied')
                : state === 'on'
                  ? t('settings.push.on')
                  : t('settings.push.off')}
        </span>
        {(state === 'on' || state === 'off') && (
          <button
            type="button"
            className={state === 'on' ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'}
            disabled={busy}
            onClick={toggle}
          >
            {state === 'on' ? t('settings.turnOff') : t('settings.turnOn')}
          </button>
        )}
      </div>
    </SettingsCard>
  );
}

const CHANNELS = ['inbox', 'push', 'email', 'chat'] as const;
type Channel = (typeof CHANNELS)[number];

export function NotificationsSection() {
  const { data: account } = useAccount();
  const config = useConfig();
  const refresh = useRefreshAccount();
  if (!account) return <Spinner />;
  const prefs = account.preferences.notifications;
  const save = async (
    patch: { emailDigest?: EmailDigest } & Partial<
      Record<Channel, Partial<Record<NotificationType, boolean>>>
    >,
  ) => {
    try {
      await api.patch('/me/preferences', { notifications: patch });
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const emailOff = !config.data?.emailEnabled || prefs.emailDigest === 'off';
  const usable = (type: NotificationType, channel: Channel) =>
    channel === 'inbox' ||
    (prefs.inbox[type] && !INBOX_ONLY_TYPES.includes(type) && !(channel === 'email' && emailOff));
  return (
    <SettingsCard
      title={t('settings.notifications.title')}
      description={t('settings.notifications.description')}
    >
      <FormRow label={t('settings.notifications.sendEmails')}>
        <select
          className="input w-64"
          value={prefs.emailDigest}
          disabled={!config.data?.emailEnabled}
          onChange={(e) => save({ emailDigest: e.target.value as EmailDigest })}
        >
          {(['instant', 'hourly', 'daily', 'off'] as const).map((d) => (
            <option key={d} value={d}>
              {t(`settings.notifications.digest.${d}`)}
            </option>
          ))}
        </select>
      </FormRow>
      {!config.data?.emailEnabled && (
        <p className="mb-2 text-[12.5px] text-index">
          {t('settings.notifications.descriptionNoEmail')}
        </p>
      )}
      <table className="w-full text-[13.5px]">
        <thead>
          <tr className="border-b border-border-soft">
            <th className="py-2 text-left font-normal" />
            {CHANNELS.map((c) => (
              <th
                key={c}
                scope="col"
                className="w-16 py-2 text-center font-mono text-[10.5px] font-normal tracking-[0.14em] text-index uppercase"
              >
                {t(`settings.notifications.channels.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_TYPES.map((type) => (
            <tr key={type} className="border-b border-border-soft">
              <th scope="row" className="py-2.5 text-left font-normal">
                {notificationLabel(type)}
              </th>
              {CHANNELS.map((c) => {
                const ok = usable(type, c);
                return (
                  <td key={c} className="text-center">
                    <input
                      type="checkbox"
                      className="accent-primary disabled:opacity-30"
                      aria-label={t('settings.notifications.cellLabel', {
                        type: notificationLabel(type),
                        channel: t(`settings.notifications.channels.${c}`),
                      })}
                      disabled={!ok}
                      checked={ok && prefs[c][type]}
                      onChange={(e) => save({ [c]: { [type]: e.target.checked } })}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[12.5px] text-index">{t('settings.notifications.channelsHint')}</p>
    </SettingsCard>
  );
}
