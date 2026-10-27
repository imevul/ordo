import {
  type Account,
  AVATAR_COLORS,
  type EmailDigest,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  NOTIFICATION_TYPES,
  type NotificationType,
  type Passkey,
  type UserPreferences,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Download,
  Fingerprint,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, upload } from '../../api/client.ts';
import { keys, useAccount, useApiKeys, useConfig, useSessions } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { switchLocale, t, tx } from '../../i18n/index.ts';
import { relativeTime } from '../../lib/format.ts';
import { addPasskey, deviceName, passkeyCancelled, passkeysHere } from '../../lib/passkeys.ts';
import { disablePush, enablePush, type PushState, pushState } from '../../lib/push.ts';
import { setThemePref, THEME_PREFS, useTheme } from '../../lib/theme.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

/** Refreshes everything that shows the current user after an account change. */
function useRefreshAccount() {
  const qc = useQueryClient();
  const ws = useWorkspace();
  return () => {
    qc.invalidateQueries({ queryKey: keys.account });
    qc.invalidateQueries({ queryKey: keys.me });
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
  };
}

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
    </>
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
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t('settings.profile.initialsColour')}
          >
            {AVATAR_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setColor(c)}
                className={`h-5 w-5 ${color === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
                style={{ background: c }}
                aria-label={t('settings.profile.colour', { color: c })}
              />
            ))}
          </div>
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

/**
 * Adding or removing a passkey, or new recovery codes for an account whose only second factor is
 * passkeys: the password (when the account has one), and a name for new passkeys.
 */
type PasskeyStep =
  | { kind: 'add' }
  | { kind: 'remove'; id: string; name: string }
  | { kind: 'codes' }
  | null;

function PasskeysCard({ account }: { account: Account }) {
  const config = useConfig();
  const qc = useQueryClient();
  const queryKey = ['me', 'passkeys'];
  const { data: list = [] } = useQuery({
    queryKey,
    queryFn: () => api.get<Passkey[]>('/me/passkeys'),
  });
  const [step, setStep] = useState<PasskeyStep>(null);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refreshAccount = useRefreshAccount();
  const refresh = () => {
    qc.invalidateQueries({ queryKey });
    refreshAccount();
  };

  const origin = config.data?.passkeyOrigin;
  if (!passkeysHere(origin)) {
    return (
      <SettingsCard title={t('settings.passkeys.title')}>
        <p className="text-[13px] text-muted">
          {!origin
            ? t('settings.passkeys.needsHttps')
            : origin !== window.location.origin
              ? t('settings.passkeys.otherOrigin', { origin })
              : t('settings.passkeys.unsupported')}
        </p>
      </SettingsCard>
    );
  }

  const start = (next: PasskeyStep) => {
    setPassword('');
    setName(deviceName());
    setStep(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!step) return;
    setBusy(true);
    try {
      const pw = account.hasPassword ? password : undefined;
      if (step.kind === 'add') {
        const added = await addPasskey(pw, name.trim() || deviceName());
        if (added.recoveryCodes) setCodes(added.recoveryCodes);
        toast.success(t('settings.passkeys.added'));
      } else if (step.kind === 'codes') {
        const res = await api.post<{ recoveryCodes: string[] }>('/me/2fa/recovery-codes', {
          password: pw,
        });
        setCodes(res.recoveryCodes);
      } else {
        await api.del(`/me/passkeys/${step.id}`, account.hasPassword ? { password } : {});
        toast.success(t('settings.passkeys.removed'));
        // The last second factor took its recovery codes with it.
        if (list.length === 1 && !account.totpEnabled) setCodes(null);
      }
      setStep(null);
      refresh();
    } catch (err) {
      if (!passkeyCancelled(err)) toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Passkey) => {
    if (account.hasPassword) return start({ kind: 'remove', id: p.id, name: p.name });
    const ok = await confirmDialog({
      title: t('settings.passkeys.removeTitle', { name: p.name }),
      body: t('settings.passkeys.removeBody'),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/me/passkeys/${p.id}`, {});
      if (list.length === 1 && !account.totpEnabled) setCodes(null);
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const rename = async (p: Passkey, next: string) => {
    setRenaming(null);
    if (!next.trim() || next.trim() === p.name) return;
    try {
      await api.patch(`/me/passkeys/${p.id}`, { name: next.trim() });
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard
      title={t('settings.passkeys.title')}
      description={t('settings.passkeys.description')}
    >
      {codes && (
        <div className="mb-4">
          <RecoveryCodes codes={codes} />
        </div>
      )}
      {list.map((p) => (
        <div
          key={p.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft py-2.5 text-[13px]"
        >
          <Fingerprint size={14} className="flex-none text-index" />
          {renaming === p.id ? (
            <input
              className="input h-7 min-w-0 flex-1 py-0 text-[13px]"
              defaultValue={p.name}
              aria-label={t('settings.passkeys.name')}
              autoFocus
              onBlur={(e) => rename(p, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename(p, e.currentTarget.value);
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left hover:text-highlight"
              title={t('settings.passkeys.rename')}
              onClick={() => setRenaming(p.id)}
            >
              {p.name}
            </button>
          )}
          {p.backedUp && <span className="tag">{t('settings.passkeys.synced')}</span>}
          <span className="font-mono text-[11px] text-index">
            {p.lastUsedAt
              ? t('settings.passkeys.used', { time: relativeTime(p.lastUsedAt) })
              : t('settings.passkeys.addedAgo', { time: relativeTime(p.createdAt) })}
          </span>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-index hover:text-error"
            aria-label={t('settings.passkeys.removeNamed', { name: p.name })}
            onClick={() => remove(p)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {list.length === 0 && (
        <p className="mb-3 font-mono text-[12px] text-index">{t('settings.passkeys.empty')}</p>
      )}
      {step ? (
        <form onSubmit={submit} className="mt-4">
          {step.kind === 'add' && (
            <FormRow label={t('settings.passkeys.name')}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </FormRow>
          )}
          {step.kind === 'remove' && (
            <p className="mb-3 text-[13px] text-muted">
              {t('settings.passkeys.removeTitle', { name: step.name })}{' '}
              {t('settings.passkeys.removeBody')}
            </p>
          )}
          {step.kind === 'codes' && (
            <p className="mb-3 text-[13px] text-muted">{t('settings.passkeys.newCodesBody')}</p>
          )}
          {account.hasPassword && (
            <FormRow label={t('settings.passkeys.confirmPassword')}>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormRow>
          )}
          <div className="flex gap-2">
            <button
              className={`btn ${step.kind === 'remove' ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy}
            >
              {step.kind === 'remove'
                ? t('common.remove')
                : step.kind === 'codes'
                  ? t('settings.passkeys.newCodes')
                  : t('common.continue')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost" onClick={() => start({ kind: 'add' })}>
            <Fingerprint size={12} /> {t('settings.passkeys.add')}
          </button>
          {/* With an authenticator app, its card hands out recovery codes instead. */}
          {list.length > 0 && !account.totpEnabled && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => start({ kind: 'codes' })}
            >
              {t('settings.twoFactor.newRecoveryCodes')}
            </button>
          )}
        </div>
      )}
    </SettingsCard>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  return (
    <div className="panel panel-sm p-4 [--panel-border:var(--color-primary)]">
      <div className="kicker mb-3">{t('settings.twoFactor.recoveryKicker')}</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[13px]">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(text);
            toast.success(t('common.copied'));
          }}
        >
          <Copy size={12} /> {t('common.copy')}
        </button>
        <a
          className="btn btn-ghost btn-sm"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${t('settings.twoFactor.recoveryFileTitle')}\n\n${text}\n`)}`}
          download="ordo-recovery-codes.txt"
        >
          <Download size={12} /> {t('settings.download')}
        </a>
      </div>
    </div>
  );
}

function TwoFactorCard({ account }: { account: Account }) {
  const refresh = useRefreshAccount();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ secret: string; uri: string }>('/me/2fa/setup', {
        password: password || undefined,
      });
      const qr = await QRCode.toDataURL(res.uri, {
        margin: 1,
        width: 200,
        color: { dark: '#09090b', light: '#fff4fa' },
      });
      setSetup({ ...res, qr });
      setPassword('');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/me/2fa/enable', { code });
      setCodes(res.recoveryCodes);
      setSetup(null);
      setCode('');
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/me/2fa/disable', { password: password || undefined, code });
      setDisabling(false);
      setPassword('');
      setCode('');
      setCodes(null);
      refresh();
      toast.success(t('settings.twoFactor.turnedOff'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const regenerate = async () => {
    const c = prompt(t('settings.twoFactor.regeneratePrompt'));
    if (!c) return;
    try {
      setCodes(
        (await api.post<{ recoveryCodes: string[] }>('/me/2fa/recovery-codes', { code: c }))
          .recoveryCodes,
      );
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard
      title={t('settings.twoFactor.title')}
      description={t('settings.twoFactor.description')}
    >
      {codes && (
        <div className="mb-4">
          <RecoveryCodes codes={codes} />
        </div>
      )}
      {account.totpEnabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip mr-2 [--chip:var(--color-success)]">
            {t('settings.twoFactor.on')}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={regenerate}>
            {t('settings.twoFactor.newRecoveryCodes')}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => setDisabling(true)}
          >
            {t('settings.turnOff')}
          </button>
        </div>
      ) : (
        <form onSubmit={start} className="flex flex-wrap gap-2">
          {account.hasPassword && (
            <input
              className="input w-64"
              type="password"
              placeholder={t('settings.currentPassword')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
          <button className="btn btn-primary">
            <ShieldCheck size={13} /> {t('settings.twoFactor.setUp')}
          </button>
        </form>
      )}

      <Modal
        open={!!setup}
        onClose={() => setSetup(null)}
        width={460}
        label={t('settings.twoFactor.setupLabel')}
        align="center"
      >
        {setup && (
          <form onSubmit={enable} className="p-6">
            <div className="section-label mb-4">{t('settings.twoFactor.scanTitle')}</div>
            <div className="flex gap-5">
              <img
                src={setup.qr}
                alt={t('settings.twoFactor.qrAlt')}
                width={160}
                height={160}
                className="flex-none"
              />
              <div className="min-w-0 text-[13px] text-muted">
                {t('settings.twoFactor.scanHelp')}
                <code className="mt-2 block break-all font-mono text-[12px] text-text">
                  {setup.secret}
                </code>
              </div>
            </div>
            <div className="mt-6" />
            <FormRow label={t('settings.twoFactor.codeFromApp')}>
              <input
                className="input font-mono tracking-[0.3em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                required
              />
            </FormRow>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setSetup(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" disabled={code.length !== 6}>
                {t('settings.turnOn')} <span className="arrow">→</span>
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={disabling}
        onClose={() => setDisabling(false)}
        width={420}
        label={t('settings.twoFactor.disableLabel')}
        align="center"
      >
        <form onSubmit={disable} className="p-6">
          <div className="section-label mb-4">{t('settings.twoFactor.disableTitle')}</div>
          {account.hasPassword && (
            <FormRow label={t('settings.currentPassword')}>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </FormRow>
          )}
          <FormRow label={t('settings.twoFactor.disableCode')}>
            <input
              className="input font-mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </FormRow>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setDisabling(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger">{t('settings.turnOff')}</button>
          </div>
        </form>
      </Modal>
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

export function NotificationsSection() {
  const { data: account } = useAccount();
  const config = useConfig();
  const refresh = useRefreshAccount();
  if (!account) return <Spinner />;
  const prefs = account.preferences.notifications;
  const save = async (patch: {
    emailDigest?: EmailDigest;
    email?: Partial<Record<NotificationType, boolean>>;
  }) => {
    try {
      await api.patch('/me/preferences', { notifications: patch });
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard
      title={t('settings.notifications.title')}
      description={
        config.data?.emailEnabled
          ? t('settings.notifications.description')
          : t('settings.notifications.descriptionNoEmail')
      }
    >
      <FormRow label={t('settings.notifications.sendEmails')}>
        <select
          className="input w-64"
          value={prefs.emailDigest}
          onChange={(e) => save({ emailDigest: e.target.value as EmailDigest })}
        >
          {(['instant', 'hourly', 'daily', 'off'] as const).map((d) => (
            <option key={d} value={d}>
              {t(`settings.notifications.digest.${d}`)}
            </option>
          ))}
        </select>
      </FormRow>
      <div className={prefs.emailDigest === 'off' ? 'pointer-events-none opacity-50' : ''}>
        {NOTIFICATION_TYPES.map((type) => (
          <label
            key={type}
            className="flex items-center justify-between gap-3 border-b border-border-soft py-2.5 text-[13.5px]"
          >
            {notificationLabel(type)}
            <input
              type="checkbox"
              className="accent-primary"
              checked={prefs.email[type]}
              onChange={(e) => save({ email: { [type]: e.target.checked } })}
            />
          </label>
        ))}
      </div>
    </SettingsCard>
  );
}

export function ApiKeysSection() {
  const qc = useQueryClient();
  const { data: list = [] } = useApiKeys();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ token: string }>('/me/api-keys', { name });
      setCreated(res.token);
      setName('');
      qc.invalidateQueries({ queryKey: keys.apiKeys });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const revoke = async (id: string) => {
    if (
      !(await confirmDialog({
        title: t('settings.apiKeys.revokeTitle'),
        body: t('settings.apiKeys.revokeBody'),
        confirmLabel: t('settings.apiKeys.revokeConfirm'),
        danger: true,
      }))
    )
      return;
    await api.del(`/me/api-keys/${id}`);
    qc.invalidateQueries({ queryKey: keys.apiKeys });
  };

  return (
    <SettingsCard
      title={t('settings.apiKeys.title')}
      description={tx('settings.apiKeys.description', {
        header: <code className="font-mono text-highlight">Authorization: Bearer ordo_…</code>,
        doc: <span className="font-mono">docs/api.md</span>,
      })}
    >
      <form onSubmit={create} className="mb-5 flex gap-2">
        <input
          className="input"
          placeholder={t('settings.apiKeys.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="btn btn-primary">
          <KeyRound size={13} /> {t('common.create')}
        </button>
      </form>
      {created && (
        <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-primary)]">
          <div className="kicker mb-2">{t('settings.apiKeys.copyNow')}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{created}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(created);
                toast.success(t('common.copied'));
              }}
            >
              <Copy size={12} /> {t('common.copy')}
            </button>
          </div>
        </div>
      )}
      {list.map((k) => (
        <div key={k.id} className="flex h-11 items-center gap-3 border-b border-border-soft">
          <KeyRound size={14} className="text-muted" />
          <span className="min-w-0 flex-1 truncate">{k.name}</span>
          <span className="font-mono text-[11.5px] text-index">{k.prefix}…</span>
          <span className="hidden min-w-32 flex-none text-right font-mono text-[11px] text-index sm:block">
            {k.lastUsedAt
              ? t('settings.apiKeys.used', { time: relativeTime(k.lastUsedAt) })
              : t('settings.apiKeys.neverUsed')}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => revoke(k.id)}
            aria-label={t('settings.apiKeys.revokeKey', { name: k.name })}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {list.length === 0 && !created && (
        <p className="font-mono text-[12px] text-index">{t('settings.apiKeys.empty')}</p>
      )}
    </SettingsCard>
  );
}

/** The ordo CLI, served by this instance; it signs in with a personal key. */
export function CliCard() {
  const origin = window.location.origin;
  const install = `curl -fsSL ${origin}/cli/ordo.mjs -o ~/.local/bin/ordo && chmod +x ~/.local/bin/ordo\nordo login ${origin}`;
  return (
    <SettingsCard
      title={t('settings.cli.title')}
      description={tx('settings.cli.description', {
        command: <span className="font-mono text-text">ordo</span>,
        doc: <span className="font-mono">docs/cli.md</span>,
      })}
    >
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto border border-border-soft bg-bg p-3 font-mono text-[11.5px] leading-relaxed">
          {install}
        </pre>
        <button
          type="button"
          className="btn btn-ghost btn-sm flex-none"
          onClick={() => {
            navigator.clipboard?.writeText(install);
            toast.success(t('common.copied'));
          }}
        >
          <Copy size={12} /> {t('common.copy')}
        </button>
      </div>
    </SettingsCard>
  );
}
