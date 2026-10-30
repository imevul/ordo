import type { Account } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../api/client.ts';
import { keys, useAccount, useSessions } from '../../../api/queries.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
import { t } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { FormRow, SettingsCard } from '../ui.tsx';
import { PasskeysCard } from './passkeys.tsx';
import { errMsg } from './shared.ts';
import { TwoFactorCard } from './two-factor.tsx';

export function SecuritySection() {
  const { data: account } = useAccount();
  if (!account) return <Spinner />;
  return (
    <>
      <PasswordCard account={account} />
      <PasskeysCard account={account} />
      <TwoFactorCard account={account} />
      <SessionsCard />
    </>
  );
}

function PasswordCard({ account }: { account: Account }) {
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  if (!account.hasPassword) {
    return (
      <SettingsCard title={t('settings.password.title')}>
        <p className="text-[13px] text-muted">{t('settings.password.ssoOnly')}</p>
      </SettingsCard>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/me/password', pw);
      setPw({ currentPassword: '', newPassword: '' });
      toast.success(t('settings.password.changed'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard title={t('settings.password.title')}>
      <form onSubmit={submit}>
        <FormRow label={t('settings.currentPassword')}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={pw.currentPassword}
            onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
            required
          />
        </FormRow>
        <FormRow label={t('settings.password.newPassword')} hint={t('settings.password.newHint')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={pw.newPassword}
            onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
            required
          />
        </FormRow>
        <button className="btn btn-ghost">{t('settings.password.change')}</button>
      </form>
    </SettingsCard>
  );
}

/** A short, human description of a browser from its user agent. */
function describeAgent(ua: string | null) {
  if (!ua) return t('settings.sessions.unknownDevice');
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /curl|node|undici/i.test(ua)
            ? t('settings.sessions.script')
            : t('settings.sessions.browser');
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? t('settings.sessions.browserOn', { browser, os }) : browser;
}

function SessionsCard() {
  const qc = useQueryClient();
  const { data: sessions = [] } = useSessions();
  const reload = () => qc.invalidateQueries({ queryKey: keys.sessions });
  return (
    <SettingsCard
      title={t('settings.sessions.title')}
      description={t('settings.sessions.description')}
    >
      {sessions.map((s) => (
        <div key={s.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px]">
              {describeAgent(s.userAgent)}
              {s.current && (
                <span className="chip ml-3 [--chip:var(--color-success)]">
                  {t('settings.sessions.thisDevice')}
                </span>
              )}
              {s.sso && <span className="tag ml-2 font-mono">sso</span>}
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {s.lastSeenAt
                ? t('settings.sessions.metaActive', {
                    ip: s.ip ?? t('settings.sessions.unknownIp'),
                    time: relativeTime(s.createdAt),
                    active: relativeTime(s.lastSeenAt),
                  })
                : t('settings.sessions.meta', {
                    ip: s.ip ?? t('settings.sessions.unknownIp'),
                    time: relativeTime(s.createdAt),
                  })}
            </div>
          </div>
          {!s.current && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                await api.del(`/me/sessions/${s.id}`);
                reload();
              }}
              aria-label={t('settings.sessions.revoke')}
            >
              <LogOut size={12} />
            </button>
          )}
        </div>
      ))}
      {sessions.filter((s) => !s.current).length > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-4"
          onClick={async () => {
            await api.post('/me/sessions/revoke-others');
            reload();
            toast.success(t('settings.sessions.signedOutOthers'));
          }}
        >
          {t('settings.sessions.signOutOthers')}
        </button>
      )}
    </SettingsCard>
  );
}
