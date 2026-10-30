import {
  type Account,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  type UserPreferences,
} from '@ordo/shared';
import { Monitor, Moon, Sun, Upload } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, upload } from '../../../api/client.ts';
import { useAccount, useConfig } from '../../../api/queries.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
import { Avatar } from '../../../components/ui/Avatar.tsx';
import { AvatarColorPicker } from '../../../components/ui/AvatarColorPicker.tsx';
import { switchLocale, t } from '../../../i18n/index.ts';
import { setThemePref, THEME_PREFS, useTheme } from '../../../lib/theme.ts';
import { setKeepsCopy, useKeepsCopy } from '../../../sync/device.ts';
import { FormRow, SettingsCard } from '../ui.tsx';

import { errMsg, useRefreshAccount } from './shared.ts';

/** Center-crops and scales an image to a 256px square WebP in the browser (no server-side image code). */
async function toAvatar(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas
    .getContext('2d')!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(t('settings.profile.imageError')))),
      'image/webp',
      0.9,
    ),
  );
}

export function AccountSection() {
  const { data: account } = useAccount();
  if (!account) return <Spinner />;
  return (
    <>
      <ProfileCard account={account} />
      <EmailCard account={account} />
      <LanguageCard account={account} />
      <AppearanceCard />
      <OfflineCard />
    </>
  );
}

/** Whether this browser keeps a copy of workspaces (when the instance allows one). */
function OfflineCard() {
  const config = useConfig();
  const mode = config.data?.offlineSync;
  const keeps = useKeepsCopy(mode);
  if (!mode || mode === 'off') return null;
  return (
    <SettingsCard
      title={t('settings.offline.title')}
      description={t('settings.offline.description')}
    >
      <label className="flex items-center justify-between gap-4 text-[13.5px]">
        <span>
          {t('settings.offline.keep')}
          <span className="block text-[12px] text-index">{t('settings.offline.keepHint')}</span>
        </span>
        <input
          type="checkbox"
          className="accent-primary"
          checked={keeps}
          onChange={(e) => setKeepsCopy(e.target.checked)}
        />
      </label>
    </SettingsCard>
  );
}

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

function LanguageCard({ account }: { account: Account }) {
  const choose = async (locale: Locale) => {
    try {
      await api.patch('/me/preferences', { locale });
      switchLocale(locale);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard
      title={t('settings.language.title')}
      description={t('settings.language.description')}
    >
      <select
        className="input max-w-64"
        value={account.preferences.locale}
        onChange={(e) => choose(e.target.value as Locale)}
        aria-label={t('settings.language.title')}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </SettingsCard>
  );
}

function AppearanceCard() {
  const { pref } = useTheme();
  return (
    <SettingsCard
      title={t('settings.appearance.title')}
      description={t('settings.appearance.description')}
    >
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t('settings.appearance.theme')}
      >
        {THEME_PREFS.map(({ value }) => {
          const Icon = THEME_ICONS[value];
          return (
            <button
              key={value}
              type="button"
              onClick={() => setThemePref(value)}
              aria-pressed={pref === value}
              className={`flex items-center gap-2 border px-3 py-1.5 text-[13px] ${pref === value ? 'border-primary text-text' : 'border-border-soft text-muted hover:text-text'}`}
            >
              <Icon size={14} className={pref === value ? 'text-primary' : ''} />
              {t(`settings.appearance.${value}`)}
            </button>
          );
        })}
      </div>
    </SettingsCard>
  );
}

function ProfileCard({ account }: { account: Account }) {
  const refresh = useRefreshAccount();
  const [name, setName] = useState(account.name);
  const [username, setUsername] = useState(account.username);
  const [color, setColor] = useState(account.avatarColor);
  const fileRef = useRef<HTMLInputElement>(null);
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch('/me', { name, username, avatarColor: color });
      refresh();
      toast.success(t('settings.profile.saved'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const savePrefs = async (patch: Partial<UserPreferences>) => {
    try {
      await api.patch('/me/preferences', patch);
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await upload('/me/avatar', await toAvatar(file), 'avatar.webp');
      refresh();
      toast.success(t('settings.profile.pictureUpdated'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title={t('settings.profile.title')}>
      <div className="mb-6 flex items-center gap-4">
        <Avatar name={name || '?'} color={color} src={account.avatarUrl} size={56} />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={12} /> {t('settings.profile.uploadPicture')}
            </button>
            {account.avatarUrl && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  await api.del('/me/avatar');
                  refresh();
                }}
              >
                {t('common.remove')}
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <AvatarColorPicker
            value={color}
            onChange={setColor}
            label={t('settings.profile.initialsColour')}
          />
        </div>
      </div>
      <form onSubmit={saveProfile}>
        <FormRow label={t('settings.profile.fullName')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </FormRow>
        <FormRow label={t('settings.profile.username')} hint={t('settings.profile.usernameHint')}>
          <input
            className="input font-mono"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            required
          />
        </FormRow>
        <button className="btn btn-primary">{t('settings.profile.save')}</button>
      </form>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <FormRow label={t('settings.profile.timeZone')}>
          <select
            className="input"
            value={account.preferences.timezone ?? ''}
            onChange={(e) => savePrefs({ timezone: e.target.value || null })}
          >
            <option value="">{t('settings.profile.followBrowser')}</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label={t('settings.profile.weekStart')}>
          <select
            className="input"
            value={account.preferences.weekStartsOn}
            onChange={(e) => savePrefs({ weekStartsOn: Number(e.target.value) as 0 | 1 })}
          >
            <option value={1}>{t('settings.profile.monday')}</option>
            <option value={0}>{t('settings.profile.sunday')}</option>
          </select>
        </FormRow>
      </div>
    </SettingsCard>
  );
}

function EmailCard({ account }: { account: Account }) {
  const refresh = useRefreshAccount();
  const config = useConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const emailEnabled = config.data?.emailEnabled;

  const change = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ pending: boolean }>('/me/email', {
        email,
        password: password || undefined,
      });
      if (res.pending) toast.success(t('settings.email.checkInbox', { email }));
      else toast.success(t('settings.email.changed'));
      setEmail('');
      setPassword('');
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title={t('settings.email.title')}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-[14px]">{account.email}</span>
        {account.emailVerified ? (
          <span className="chip [--chip:var(--color-success)]">{t('settings.email.verified')}</span>
        ) : (
          <>
            <span className="chip [--chip:var(--color-warning)]">
              {t('settings.email.unverified')}
            </span>
            {emailEnabled && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await api.post('/me/email/verify');
                  toast.success(t('settings.email.verificationSent'));
                }}
              >
                {t('settings.email.resend')}
              </button>
            )}
          </>
        )}
      </div>
      <form onSubmit={change} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          className="input"
          type="email"
          placeholder={t('settings.email.newAddress')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {account.hasPassword && (
          <input
            className="input"
            type="password"
            placeholder={t('settings.currentPassword')}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        )}
        <button className="btn btn-ghost">{t('settings.email.change')}</button>
      </form>
      <p className="mt-2 text-[12px] text-index">
        {emailEnabled ? t('settings.email.hintEnabled') : t('settings.email.hintDisabled')}
      </p>
    </SettingsCard>
  );
}
