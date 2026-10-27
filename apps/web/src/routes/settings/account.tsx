import {
  type Account,
  AVATAR_COLORS,
  type EmailDigest,
  NOTIFICATION_TYPES,
  type NotificationType,
  type UserPreferences,
} from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Download,
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
import { relativeTime } from '../../lib/format.ts';
import { disablePush, enablePush, type PushState, pushState } from '../../lib/push.ts';
import { setThemePref, THEME_PREFS, useTheme } from '../../lib/theme.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

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
      (b) => (b ? resolve(b) : reject(new Error('Could not process image'))),
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
      <AppearanceCard />
    </>
  );
}

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

function AppearanceCard() {
  const { pref } = useTheme();
  return (
    <SettingsCard
      title="Appearance"
      description="Saved in this browser. System follows your device's light or dark setting."
    >
      <div className="flex flex-wrap gap-2" role="group" aria-label="Theme">
        {THEME_PREFS.map(({ value, label }) => {
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
              {label}
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
      toast.success('Profile saved');
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
      toast.success('Picture updated');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title="Profile">
      <div className="mb-6 flex items-center gap-4">
        <Avatar name={name || '?'} color={color} src={account.avatarUrl} size={56} />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={12} /> Upload picture
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
                Remove
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
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Initials colour">
            {AVATAR_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setColor(c)}
                className={`h-5 w-5 ${color === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
              />
            ))}
          </div>
        </div>
      </div>
      <form onSubmit={saveProfile}>
        <FormRow label="Full name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </FormRow>
        <FormRow label="Username" hint="Used for @mentions.">
          <input
            className="input font-mono"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            required
          />
        </FormRow>
        <button className="btn btn-primary">Save profile</button>
      </form>
      <div className="mt-6 grid grid-cols-2 gap-3">
        <FormRow label="Time zone">
          <select
            className="input"
            value={account.preferences.timezone ?? ''}
            onChange={(e) => savePrefs({ timezone: e.target.value || null })}
          >
            <option value="">Follow my browser</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Weeks start on">
          <select
            className="input"
            value={account.preferences.weekStartsOn}
            onChange={(e) => savePrefs({ weekStartsOn: Number(e.target.value) as 0 | 1 })}
          >
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
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
      if (res.pending) toast.success(`Check ${email} for a confirmation link`);
      else toast.success('Email changed');
      setEmail('');
      setPassword('');
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title="Email">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[14px]">{account.email}</span>
        {account.emailVerified ? (
          <span className="chip [--chip:var(--color-success)]">verified</span>
        ) : (
          <>
            <span className="chip [--chip:var(--color-warning)]">unverified</span>
            {emailEnabled && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await api.post('/me/email/verify');
                  toast.success('Verification email sent');
                }}
              >
                Resend link
              </button>
            )}
          </>
        )}
      </div>
      <form onSubmit={change} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          className="input"
          type="email"
          placeholder="New email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {account.hasPassword && (
          <input
            className="input"
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        )}
        <button className="btn btn-ghost">Change email</button>
      </form>
      <p className="mt-2 text-[12px] text-index">
        {emailEnabled
          ? "We'll send a link to the new address; the change applies once you open it."
          : "Email isn't set up on this instance, so the new address can't be verified."}
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
      <TwoFactorCard account={account} />
      <SessionsCard />
    </>
  );
}

function PasswordCard({ account }: { account: Account }) {
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  if (!account.hasPassword) {
    return (
      <SettingsCard title="Password">
        <p className="text-[13px] text-muted">
          This account signs in through single sign-on and has no password.
        </p>
      </SettingsCard>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/me/password', pw);
      setPw({ currentPassword: '', newPassword: '' });
      toast.success('Password changed. Other sessions were signed out.');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard title="Password">
      <form onSubmit={submit}>
        <FormRow label="Current password">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={pw.currentPassword}
            onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
            required
          />
        </FormRow>
        <FormRow
          label="New password"
          hint="At least 8 characters. Changing it signs out your other sessions."
        >
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
        <button className="btn btn-ghost">Change password</button>
      </form>
    </SettingsCard>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  return (
    <div className="panel panel-sm p-4 [--panel-border:var(--color-primary)]">
      <div className="kicker mb-3">
        // save these now — each works once, and they won't be shown again
      </div>
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
            toast.success('Copied');
          }}
        >
          <Copy size={12} /> Copy
        </button>
        <a
          className="btn btn-ghost btn-sm"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Ordo recovery codes\n\n${text}\n`)}`}
          download="ordo-recovery-codes.txt"
        >
          <Download size={12} /> Download
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
      toast.success('Two-factor authentication is off');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const regenerate = async () => {
    const c = prompt('Enter a current 6-digit code from your authenticator app');
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
      title="Two-factor authentication"
      description="Require a code from an authenticator app (1Password, Bitwarden, Aegis, Google Authenticator…) when signing in."
    >
      {codes && (
        <div className="mb-4">
          <RecoveryCodes codes={codes} />
        </div>
      )}
      {account.twoFactorEnabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip mr-2 [--chip:var(--color-success)]">on</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={regenerate}>
            New recovery codes
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => setDisabling(true)}
          >
            Turn off
          </button>
        </div>
      ) : (
        <form onSubmit={start} className="flex flex-wrap gap-2">
          {account.hasPassword && (
            <input
              className="input w-64"
              type="password"
              placeholder="Current password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
          <button className="btn btn-primary">
            <ShieldCheck size={13} /> Set up
          </button>
        </form>
      )}

      <Modal
        open={!!setup}
        onClose={() => setSetup(null)}
        width={460}
        label="Set up two-factor authentication"
        align="center"
      >
        {setup && (
          <form onSubmit={enable} className="p-6">
            <div className="section-label mb-4">Scan the code</div>
            <div className="flex gap-5">
              <img
                src={setup.qr}
                alt="QR code for your authenticator app"
                width={160}
                height={160}
                className="flex-none"
              />
              <div className="min-w-0 text-[13px] text-muted">
                Scan it with your authenticator app, or enter this key:
                <code className="mt-2 block break-all font-mono text-[12px] text-text">
                  {setup.secret}
                </code>
              </div>
            </div>
            <div className="mt-6" />
            <FormRow label="6-digit code from the app">
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
                Cancel
              </button>
              <button className="btn btn-primary" disabled={code.length !== 6}>
                Turn on <span className="arrow">→</span>
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={disabling}
        onClose={() => setDisabling(false)}
        width={420}
        label="Turn off two-factor authentication"
        align="center"
      >
        <form onSubmit={disable} className="p-6">
          <div className="section-label mb-4">Turn off two-factor</div>
          {account.hasPassword && (
            <FormRow label="Current password">
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
          <FormRow label="Code from your app, or a recovery code">
            <input
              className="input font-mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </FormRow>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setDisabling(false)}>
              Cancel
            </button>
            <button className="btn btn-danger">Turn off</button>
          </div>
        </form>
      </Modal>
    </SettingsCard>
  );
}

/** A short, human description of a browser from its user agent. */
function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /curl|node|undici/i.test(ua)
            ? 'Script'
            : 'Browser';
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
  return os ? `${browser} on ${os}` : browser;
}

function SessionsCard() {
  const qc = useQueryClient();
  const { data: sessions = [] } = useSessions();
  const reload = () => qc.invalidateQueries({ queryKey: keys.sessions });
  return (
    <SettingsCard
      title="Sessions"
      description="Where you're signed in. Revoke anything you don't recognise."
    >
      {sessions.map((s) => (
        <div key={s.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px]">
              {describeAgent(s.userAgent)}
              {s.current && (
                <span className="chip ml-3 [--chip:var(--color-success)]">this device</span>
              )}
              {s.sso && <span className="tag ml-2 font-mono">sso</span>}
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {s.ip ?? 'unknown ip'} · signed in {relativeTime(s.createdAt)}
              {s.lastSeenAt && ` · active ${relativeTime(s.lastSeenAt)}`}
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
              aria-label="Revoke session"
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
            toast.success('Signed out everywhere else');
          }}
        >
          Sign out other sessions
        </button>
      )}
    </SettingsCard>
  );
}

const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  issue_assigned: 'Assigned to me',
  issue_unassigned: 'Unassigned from me',
  issue_comment: 'Comments on issues I follow',
  issue_mention: 'Mentions',
  issue_status_changed: 'Status changes on issues I follow',
  issue_priority_urgent: 'My issues marked urgent',
  comment_reaction: 'Reactions to my comments',
  issue_sla_breached: 'Issues I follow that miss their SLA',
};

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
    <SettingsCard
      title="Push notifications"
      description="Get your notifications on this device even when Ordo isn't open — on desktop, or on your phone after adding Ordo to the home screen. Reactions aren't pushed."
    >
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[13px] text-muted">
          {state === null
            ? 'Checking…'
            : state === 'unsupported'
              ? 'This browser can’t receive push notifications.'
              : state === 'denied'
                ? 'Notifications are blocked for Ordo in this browser’s site settings.'
                : state === 'on'
                  ? 'On for this device.'
                  : 'Off for this device.'}
        </span>
        {(state === 'on' || state === 'off') && (
          <button
            type="button"
            className={state === 'on' ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'}
            disabled={busy}
            onClick={toggle}
          >
            {state === 'on' ? 'Turn off' : 'Turn on'}
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
      title="Email notifications"
      description={
        config.data?.emailEnabled
          ? 'Everything always shows up in your Inbox. Choose what is also emailed, and how often. Anything you read in the app first is not emailed.'
          : "Email isn't set up on this instance, so these settings have no effect yet."
      }
    >
      <FormRow label="Send emails">
        <select
          className="input w-64"
          value={prefs.emailDigest}
          onChange={(e) => save({ emailDigest: e.target.value as EmailDigest })}
        >
          <option value="instant">Within a few minutes</option>
          <option value="hourly">At most hourly</option>
          <option value="daily">Once a day</option>
          <option value="off">Never</option>
        </select>
      </FormRow>
      <div className={prefs.emailDigest === 'off' ? 'pointer-events-none opacity-50' : ''}>
        {NOTIFICATION_TYPES.map((t) => (
          <label
            key={t}
            className="flex items-center justify-between border-b border-border-soft py-2.5 text-[13.5px]"
          >
            {NOTIFICATION_LABELS[t]}
            <input
              type="checkbox"
              className="accent-primary"
              checked={prefs.email[t]}
              onChange={(e) => save({ email: { [t]: e.target.checked } })}
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
        title: 'Revoke this key?',
        body: 'Anything using it stops working.',
        confirmLabel: 'Revoke',
        danger: true,
      }))
    )
      return;
    await api.del(`/me/api-keys/${id}`);
    qc.invalidateQueries({ queryKey: keys.apiKeys });
  };

  return (
    <SettingsCard
      title="Personal API keys"
      description={
        <>
          Keys act as you against the REST API. Send them as{' '}
          <code className="font-mono text-highlight">Authorization: Bearer ordo_…</code>. See{' '}
          <span className="font-mono">docs/api.md</span>.
        </>
      }
    >
      <form onSubmit={create} className="mb-5 flex gap-2">
        <input
          className="input"
          placeholder="Key name, e.g. CI bot"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="btn btn-primary">
          <KeyRound size={13} /> Create
        </button>
      </form>
      {created && (
        <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-primary)]">
          <div className="kicker mb-2">// copy it now — it won't be shown again</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{created}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(created);
                toast.success('Copied');
              }}
            >
              <Copy size={12} /> Copy
            </button>
          </div>
        </div>
      )}
      {list.map((k) => (
        <div key={k.id} className="flex h-11 items-center gap-3 border-b border-border-soft">
          <KeyRound size={14} className="text-muted" />
          <span className="min-w-0 flex-1 truncate">{k.name}</span>
          <span className="font-mono text-[11.5px] text-index">{k.prefix}…</span>
          <span className="hidden w-32 text-right font-mono text-[11px] text-index sm:block">
            {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : 'never used'}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => revoke(k.id)}
            aria-label={`Revoke ${k.name}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {list.length === 0 && !created && (
        <p className="font-mono text-[12px] text-index">// no keys yet</p>
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
      title="Command line"
      description={
        <>
          The <span className="font-mono text-text">ordo</span> command lists, creates and updates
          issues from a terminal, with one of these keys. It needs Node.js 22 or newer. See{' '}
          <span className="font-mono">docs/cli.md</span>.
        </>
      }
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
            toast.success('Copied');
          }}
        >
          <Copy size={12} /> Copy
        </button>
      </div>
    </SettingsCard>
  );
}
