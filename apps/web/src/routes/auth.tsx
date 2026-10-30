import {
  type InvitePreview,
  type JoinableWorkspace,
  type OAuthAuthorizeInfo,
  SLUG_PATTERN,
  type SsoDiscovery,
  type SsoOption,
  TEAM_KEY_PATTERN,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { BadgeCheck, Fingerprint, KeyRound, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.ts';
import { keys, useConfig, useMe } from '../api/queries.ts';
import { OrdoMark } from '../components/icons.tsx';
import { Spinner } from '../components/PageHeader.tsx';
import { getLocale, t, tx } from '../i18n/index.ts';
import {
  cancelPasskeyRequest,
  confirmWithPasskey,
  passkeyAutofillSupported,
  passkeyCancelled,
  passkeysHere,
  signInWithPasskey,
} from '../lib/passkeys.ts';
import { forgetLastSso, lastSso, ssoStartUrl } from '../lib/sso.ts';

function AuthLayout({
  kicker,
  title,
  children,
  footer,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="hud-ground flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <OrdoMark className="mb-8" />
        <div className="brackets">
          <div className="panel panel-raised p-7">
            <div className="kicker">
              <span className="text-muted">// </span>
              {kicker}
            </div>
            <h1 className="mt-2 text-[28px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
            <div className="mt-6">{children}</div>
          </div>
        </div>
        {footer && <div className="mt-6 text-center text-[13px] text-muted">{footer}</div>}
        <p className="mt-10 text-center font-mono text-[10.5px] tracking-[0.12em] text-index uppercase">
          {t('auth.tagline')}
        </p>
      </div>
    </div>
  );
}

function TextField({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
        {label}
      </span>
      <input className="input" {...props} />
    </label>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p
      className="mb-4 border border-error/40 bg-error/[0.06] px-3 py-2 text-[13px] text-error"
      role="alert"
    >
      {error}
    </p>
  );
}

const message = (err: unknown) =>
  err instanceof ApiError || err instanceof Error ? err.message : t('common.error');

export function IndexRedirect() {
  const me = useMe();
  const config = useConfig();
  if (me.isLoading || config.isLoading) return <Spinner label={t('auth.booting')} />;
  if (!me.data)
    return (
      <Navigate to={config.data?.hasUsers === false ? '/signup' : '/login'} search={{} as never} />
    );
  const first = me.data.workspaces[0];
  if (!first) return <Navigate to="/onboarding" />;
  let last: string | null = null;
  try {
    last = localStorage.getItem('ordo:lastWorkspace');
  } catch {}
  const target = me.data.workspaces.find((w) => w.slug === last) ?? first;
  return <Navigate to="/$slug" params={{ slug: target.slug }} />;
}

type LoginStep = 'email' | 'password' | 'workspace';

/**
 * Email first: the domain decides what to offer — single sign-on buttons for workspaces that
 * verified it, the password, or both (the password tucked away when SSO is required). "Sign in
 * with SSO" asks for the workspace instead, for people whose address isn't on a verified domain.
 */
export function LoginPage() {
  const search = useSearch({ from: '/login' });
  const { redirect } = search;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config = useConfig();
  const [step, setStep] = useState<LoginStep>(search.workspace ? 'workspace' : 'email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [discovery, setDiscovery] = useState<SsoDiscovery>({ options: [], ssoRequired: false });
  const [showPassword, setShowPassword] = useState(false);
  // Set after a correct password when the account has two-factor authentication.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  // What the account can answer that step with: 'totp', 'passkey', 'recovery'.
  const [factors, setFactors] = useState<string[]>([]);
  const [code, setCode] = useState('');
  // An SSO callback that failed sends people back here with ?error=.
  const [error, setError] = useState<string | null>(search.error ?? null);
  const [busy, setBusy] = useState(false);
  const [remembered, setRemembered] = useState(lastSso);
  const after = redirect?.startsWith('/') ? redirect : undefined;

  const done = () => {
    qc.removeQueries({ queryKey: keys.me });
    // href, not to: the way back may carry a query string (the OAuth consent screen's).
    navigate({ href: after ?? '/' });
  };

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const passkeys = passkeysHere(config.data?.passkeyOrigin);
  // Bumped to ask the browser again: a passkey request's challenge lasts five minutes.
  const [passkeyRound, setPasskeyRound] = useState(0);

  // Offers passkeys in the email field's autofill, where the browser supports it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `done` changes every render
  useEffect(() => {
    if (step !== 'email' || !passkeys) return;
    let live = true;
    passkeyAutofillSupported().then((ok) => {
      if (!ok || !live) return;
      // Quietly: nobody asked for this one, so a failure isn't theirs to read.
      signInWithPasskey(true)
        .then(() => live && done())
        .catch((err) => {
          if (live && !passkeyCancelled(err)) console.warn('Passkey autofill:', err);
        });
    });
    const renew = setTimeout(() => setPasskeyRound((n) => n + 1), 4 * 60_000);
    return () => {
      live = false;
      clearTimeout(renew);
      cancelPasskeyRequest();
    };
  }, [step, passkeys, passkeyRound]);

  const passkeySignIn = async () => {
    cancelPasskeyRequest();
    setBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      done();
    } catch (err) {
      if (!passkeyCancelled(err)) setError(message(err));
      setPasskeyRound((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const continueWithEmail = run(async () => {
    const found = await api.get<SsoDiscovery>(`/auth/discover?email=${encodeURIComponent(email)}`);
    setDiscovery(found);
    setShowPassword(!found.ssoRequired);
    setStep('password');
  });

  const signIn = run(async () => {
    if (mfaToken) {
      await api.post('/auth/mfa', { mfaToken, code });
      return done();
    }
    const res = await api.post<{
      ok: boolean;
      mfaRequired?: boolean;
      mfaToken?: string;
      factors?: string[];
    }>('/auth/login', { email, password });
    if (res.mfaRequired && res.mfaToken) {
      setFactors(res.factors ?? ['totp']);
      setMfaToken(res.mfaToken);
    } else done();
  });

  const mfaWithPasskey = async () => {
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await confirmWithPasskey(mfaToken);
      done();
    } catch (err) {
      if (!passkeyCancelled(err)) setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    const totp = factors.includes('totp');
    const passkey = passkeys && factors.includes('passkey');
    // Without an authenticator app, the code field only takes recovery codes.
    const help = totp
      ? t('auth.mfa.help')
      : passkey
        ? t('auth.mfa.helpPasskey')
        : t('auth.mfa.helpRecovery');
    return (
      <AuthLayout
        kicker={t('auth.mfa.kicker')}
        title={totp || !passkey ? t('auth.mfa.title') : t('auth.mfa.titlePasskey')}
      >
        <form onSubmit={signIn}>
          <ErrorLine error={error} />
          <p className="mb-5 text-[13px] text-muted">{help}</p>
          {passkey && !totp && (
            <>
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={busy}
                onClick={mfaWithPasskey}
              >
                <Fingerprint size={13} /> {t('auth.mfa.usePasskey')}
              </button>
              <OrDivider className="my-5" />
            </>
          )}
          <TextField
            label={totp ? t('auth.mfa.code') : t('auth.mfa.recoveryCode')}
            autoComplete="one-time-code"
            inputMode="text"
            required
            autoFocus={totp || !passkey}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn btn-primary mt-2 w-full" disabled={busy}>
            {t('auth.mfa.verify')} <span className="arrow">→</span>
          </button>
          {passkey && totp && (
            <button
              type="button"
              className="btn btn-ghost mt-2 w-full"
              disabled={busy}
              onClick={mfaWithPasskey}
            >
              <Fingerprint size={13} /> {t('auth.mfa.usePasskey')}
            </button>
          )}
          <BackLink
            onClick={() => {
              setMfaToken(null);
              setCode('');
              setError(null);
            }}
          >
            {t('auth.mfa.back')}
          </BackLink>
        </form>
      </AuthLayout>
    );
  }

  const footer =
    config.data?.signupMode === 'open' || config.data?.hasUsers === false
      ? tx('auth.login.newHere', {
          link: (c) => (
            <Link to="/signup" search={{}} className="text-highlight hover:text-text">
              {c}
            </Link>
          ),
        })
      : t('auth.login.needAccount');

  if (step === 'workspace') {
    return (
      <AuthLayout
        kicker={t('auth.workspaceSso.kicker')}
        title={t('auth.workspaceSso.title')}
        footer={footer}
      >
        <ErrorLine error={error} />
        <WorkspaceSso
          initial={search.workspace ?? ''}
          redirect={after}
          onBack={() => {
            setError(null);
            setStep('email');
          }}
        />
      </AuthLayout>
    );
  }

  if (step === 'password') {
    const sso = discovery.options;
    return (
      <AuthLayout kicker={t('auth.login.kicker')} title={t('auth.login.title')} footer={footer}>
        <ErrorLine error={error} />
        <div className="mb-5 flex items-center gap-2 border border-border-soft bg-bg px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px]">{email}</span>
          <button
            type="button"
            className="font-mono text-[10.5px] tracking-[0.12em] text-index uppercase hover:text-text"
            onClick={() => {
              setStep('email');
              setPassword('');
              setError(null);
            }}
          >
            {t('auth.login.change')}
          </button>
        </div>
        {sso.length > 0 && (
          <div className="mb-5">
            <SsoButtons options={sso} redirect={after} />
            {discovery.ssoRequired && (
              <p className="mt-1 text-[12px] text-index">{t('auth.login.ssoRequired')}</p>
            )}
          </div>
        )}
        {showPassword ? (
          <form onSubmit={signIn}>
            {/* Lets password managers pair the password with the address. */}
            <input type="email" autoComplete="username" value={email} readOnly hidden />
            <TextField
              label={t('auth.password')}
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              className={`btn mt-2 w-full ${sso.length ? 'btn-ghost' : 'btn-primary'}`}
              disabled={busy}
            >
              {t('auth.login.signInWithPassword')} <span className="arrow">→</span>
            </button>
            <Link
              to="/forgot-password"
              className="mt-4 block text-center font-mono text-[11px] tracking-[0.1em] text-index uppercase hover:text-text"
            >
              {t('auth.login.forgotPassword')}
            </Link>
          </form>
        ) : (
          <BackLink onClick={() => setShowPassword(true)}>{t('auth.login.usePassword')}</BackLink>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout kicker={t('auth.login.kicker')} title={t('auth.login.title')} footer={footer}>
      {remembered && (
        <div className="mb-5">
          <a
            href={ssoStartUrl(remembered.providerId, { redirect: after })}
            className="btn btn-primary w-full"
          >
            {t('auth.login.continueWith', { name: remembered.name })}
            {remembered.workspace && (
              <span className="text-[11px] opacity-70">· {remembered.workspace}</span>
            )}
            <span className="arrow">→</span>
          </a>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] tracking-[0.12em] text-index uppercase">
            <span>{t('auth.login.lastUsed')}</span>
            <button
              type="button"
              className="uppercase hover:text-text"
              onClick={() => {
                forgetLastSso();
                setRemembered(null);
              }}
            >
              {t('auth.login.forget')}
            </button>
          </div>
          <OrDivider className="mt-5" />
        </div>
      )}
      <form onSubmit={continueWithEmail}>
        <ErrorLine error={error} />
        <TextField
          label={t('auth.email')}
          type="email"
          autoComplete={passkeys ? 'username webauthn' : 'username'}
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button
          className={`btn mt-2 w-full ${remembered ? 'btn-ghost' : 'btn-primary'}`}
          disabled={busy}
        >
          {t('common.continue')} <span className="arrow">→</span>
        </button>
      </form>
      <OrDivider className="my-5" />
      <button
        type="button"
        className="btn btn-ghost w-full"
        onClick={() => {
          setError(null);
          setStep('workspace');
        }}
      >
        <KeyRound size={13} /> {t('auth.login.signInWithSso')}
      </button>
      {passkeys && (
        <button
          type="button"
          className="btn btn-ghost mt-2 w-full"
          disabled={busy}
          onClick={passkeySignIn}
        >
          <Fingerprint size={13} /> {t('auth.login.signInWithPasskey')}
        </button>
      )}
    </AuthLayout>
  );
}

function OrDivider({ className }: { className: string }) {
  return (
    <div
      className={`${className} flex items-center gap-3 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase`}
    >
      <span className="h-px flex-1 bg-border-soft" />
      {t('auth.or')}
      <span className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

function BackLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="mt-4 w-full text-center font-mono text-[11px] tracking-[0.1em] text-index uppercase hover:text-text"
      onClick={onClick}
    >
      ← {children}
    </button>
  );
}

function SsoButtons({ options, redirect }: { options: SsoOption[]; redirect?: string }) {
  // Several workspaces may share a domain; say which one each button is for.
  const many = new Set(options.map((o) => o.workspace)).size > 1;
  return options.map((o) => (
    <a
      key={o.providerId}
      href={ssoStartUrl(o.providerId, { redirect })}
      className="btn btn-primary mb-2 w-full"
    >
      {t('auth.login.continueWith', { name: o.name })}
      {many && <span className="text-[11px] opacity-70">· {o.workspace}</span>}
      <span className="arrow">→</span>
    </a>
  ));
}

/** "Sign in with SSO": the workspace's URL name → its providers. */
function WorkspaceSso({
  initial,
  redirect,
  onBack,
}: {
  initial: string;
  redirect?: string;
  onBack: () => void;
}) {
  const [slug, setSlug] = useState(initial);
  const [found, setFound] = useState<SsoDiscovery | null>(null);
  const [busy, setBusy] = useState(false);
  const lookUp = async (value: string) => {
    // Accept a pasted URL ("https://ordo.example.com/acme/") as well as the bare name.
    const clean = value.trim().toLowerCase().replace(/\/+$/, '').replace(/^.*\//, '');
    if (!clean) return;
    setBusy(true);
    try {
      setFound(
        await api.get<SsoDiscovery>(`/auth/providers?workspace=${encodeURIComponent(clean)}`),
      );
    } finally {
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: look up a workspace from the link once
  useEffect(() => {
    if (initial) lookUp(initial);
  }, []);
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookUp(slug);
        }}
      >
        <label className="mb-4 block">
          <span className="mb-1 block font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
            {t('auth.workspaceSso.workspaceUrl')}
          </span>
          <div className="input flex items-center gap-0 p-0">
            <span className="pl-3 font-mono text-[12.5px] text-index">{location.host}/</span>
            <input
              className="min-w-0 flex-1 bg-transparent py-2 pr-3 font-mono text-[12.5px] outline-none"
              required
              autoFocus={!initial}
              placeholder="acme"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setFound(null);
              }}
              aria-label={t('auth.workspaceSso.workspaceUrl')}
            />
          </div>
        </label>
        {!found?.options.length && (
          <button className="btn btn-primary w-full" disabled={busy}>
            {t('common.continue')} <span className="arrow">→</span>
          </button>
        )}
      </form>
      {found && found.options.length === 0 && (
        <p className="mt-4 text-[13px] text-muted">{t('auth.workspaceSso.noSso')}</p>
      )}
      {found && found.options.length > 0 && (
        <SsoButtons options={found.options} redirect={redirect} />
      )}
      <BackLink onClick={onBack}>{t('auth.workspaceSso.backToEmail')}</BackLink>
    </>
  );
}

export function ForgotPasswordPage() {
  const config = useConfig();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/auth/forgot', { email });
      setSent(true);
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <AuthLayout
      kicker={t('auth.forgot.kicker')}
      title={t('auth.forgot.title')}
      footer={
        <Link to="/login" search={{}} className="text-highlight hover:text-text">
          {t('auth.forgot.backToSignIn')}
        </Link>
      }
    >
      {config.data && !config.data.emailEnabled ? (
        <p className="text-[13.5px] text-muted">{t('auth.forgot.noEmail')}</p>
      ) : sent ? (
        <p className="text-[13.5px] text-muted">
          {tx('auth.forgot.sent', {
            email,
            b: (c) => <span className="text-text">{c}</span>,
          })}
        </p>
      ) : (
        <form onSubmit={submit}>
          <ErrorLine error={error} />
          <TextField
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn btn-primary mt-2 w-full">
            {t('auth.forgot.send')} <span className="arrow">→</span>
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { token } = useParams({ from: '/reset-password/$token' });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post<{ signedIn: boolean }>('/auth/reset', { token, password });
      qc.removeQueries({ queryKey: keys.me });
      navigate({ to: res.signedIn ? '/' : '/login', search: {} as never });
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <AuthLayout kicker={t('auth.forgot.kicker')} title={t('auth.reset.title')}>
      <form onSubmit={submit}>
        <ErrorLine error={error} />
        <TextField
          label={t('auth.reset.newPassword')}
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="-mt-2 mb-4 text-[12px] text-index">{t('auth.reset.signsOut')}</p>
        <button className="btn btn-primary w-full">
          {t('auth.reset.save')} <span className="arrow">→</span>
        </button>
      </form>
    </AuthLayout>
  );
}

/** Landing page for links in verification emails (sign-up verification and email changes). */
export function EmailLinkPage({ kind }: { kind: 'verify' | 'change' }) {
  const { token } = useParams({ strict: false }) as { token: string };
  const qc = useQueryClient();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .post(kind === 'verify' ? '/auth/verify-email' : '/auth/confirm-email-change', { token })
      .then(() => {
        setState('done');
        qc.removeQueries({ queryKey: keys.me });
      })
      .catch((err) => {
        setState('failed');
        setError(message(err));
      });
  }, [kind, token, qc]);
  return (
    <AuthLayout
      kicker={
        kind === 'verify' ? t('auth.emailLink.kickerVerify') : t('auth.emailLink.kickerChange')
      }
      title={
        state === 'done'
          ? t('auth.emailLink.confirmed')
          : state === 'failed'
            ? t('auth.emailLink.failed')
            : t('auth.emailLink.confirming')
      }
      footer={
        <Link to="/" className="text-highlight hover:text-text">
          {t('auth.emailLink.continue')}
        </Link>
      }
    >
      {state === 'done' && (
        <p className="text-[13.5px] text-muted">
          {kind === 'verify' ? t('auth.emailLink.verified') : t('auth.emailLink.changed')}
        </p>
      )}
      <ErrorLine error={error} />
    </AuthLayout>
  );
}

export function SignupPage() {
  const { invite } = useSearch({ from: '/signup' });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config = useConfig();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = config.data?.hasUsers === false;
  const closed = config.data?.signupMode === 'invite' && !first && !invite;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ workspaceSlug: string | null }>('/auth/signup', {
        ...form,
        inviteToken: invite,
        locale: getLocale(),
      });
      qc.removeQueries({ queryKey: keys.me });
      qc.removeQueries({ queryKey: keys.config });
      if (res.workspaceSlug) navigate({ to: '/$slug', params: { slug: res.workspaceSlug } });
      else navigate({ to: '/onboarding' });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      kicker={
        first
          ? t('auth.signup.kickerFirst')
          : invite
            ? t('auth.signup.kickerInvited')
            : t('auth.signup.kicker')
      }
      title={first ? t('auth.signup.titleFirst') : t('auth.signup.title')}
      footer={tx('auth.signup.haveAccount', {
        link: (c) => (
          <Link
            to="/login"
            search={{ redirect: invite ? `/invite/${invite}` : undefined }}
            className="text-highlight hover:text-text"
          >
            {c}
          </Link>
        ),
      })}
    >
      {first && <p className="mb-5 text-[13px] text-muted">{t('auth.signup.firstUser')}</p>}
      {closed ? (
        <p className="text-[13.5px] text-muted">{t('auth.signup.closed')}</p>
      ) : (
        <form onSubmit={submit}>
          <ErrorLine error={error} />
          <TextField
            label={t('auth.signup.name')}
            required
            autoFocus
            autoComplete="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            label={t('auth.email')}
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <TextField
            label={t('auth.password')}
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <button className="btn btn-primary mt-2 w-full" disabled={busy}>
            {t('auth.signup.submit')} <span className="arrow">→</span>
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

export function InvitePage() {
  const { token } = useParams({ from: '/invite/$token' });
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<InvitePreview>(`/invites/${token}`)
      .then(setInfo)
      .catch((err) => setError(message(err)));
  }, [token]);

  const accept = async () => {
    try {
      const res = await api.post<{ workspaceSlug: string }>(`/invites/${token}/accept`);
      qc.removeQueries({ queryKey: keys.me });
      navigate({ to: '/$slug', params: { slug: res.workspaceSlug } });
    } catch (err) {
      setError(message(err));
    }
  };

  if (me.isLoading) return <Spinner />;
  // An invite to the instance only: it makes a new account and joins no workspace.
  if (info?.kind === 'site') {
    return (
      <AuthLayout kicker={t('auth.invite.kicker')} title={t('auth.invite.titleSite')}>
        <ErrorLine error={error} />
        {me.data ? (
          <>
            <p className="mb-5 text-[13.5px] text-muted">
              {tx('auth.invite.alreadySignedUp', {
                email: me.data.email,
                b: (c) => <span className="text-text">{c}</span>,
              })}
            </p>
            <Link to="/" className="btn btn-primary w-full">
              {t('auth.invite.continue')} <span className="arrow">→</span>
            </Link>
          </>
        ) : (
          <>
            <p className="mb-5 text-[13.5px] text-muted">
              {info.canCreateWorkspaces ? t('auth.invite.siteCanCreate') : t('auth.invite.site')}
            </p>
            <Link to="/signup" search={{ invite: token }} className="btn btn-primary w-full">
              {t('auth.invite.createAccount')} <span className="arrow">→</span>
            </Link>
          </>
        )}
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      kicker={t('auth.invite.kicker')}
      title={
        info?.workspace
          ? t('auth.invite.title', { workspace: info.workspace.name })
          : t('auth.invite.titleLoading')
      }
    >
      <ErrorLine error={error} />
      {info?.role && (
        <p className="mb-4 text-[13px] text-muted">
          {tx(info.teams.length > 0 ? 'auth.invite.invitedAsTo' : 'auth.invite.invitedAs', {
            role: inviteRole(info.role),
            teams: info.teams.join(', '),
            b: (c) => <span className="text-text">{c}</span>,
          })}
        </p>
      )}
      {info && me.data && (
        <>
          <p className="mb-5 text-[13.5px] text-muted">
            {tx('auth.invite.signedInAs', {
              email: me.data.email,
              b: (c) => <span className="text-text">{c}</span>,
            })}
          </p>
          <button className="btn btn-primary w-full" onClick={accept}>
            {t('auth.invite.join')} <span className="arrow">→</span>
          </button>
        </>
      )}
      {info && !me.data && (
        <div className="flex flex-col gap-2">
          <Link to="/signup" search={{ invite: token }} className="btn btn-primary w-full">
            {t('auth.invite.createAccount')} <span className="arrow">→</span>
          </Link>
          <Link
            to="/login"
            search={{ redirect: `/invite/${token}` }}
            className="btn btn-ghost w-full"
          >
            {t('auth.invite.haveAccount')}
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}

const INVITE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
const inviteRole = (role: string) =>
  (INVITE_ROLES as readonly string[]).includes(role)
    ? t(`auth.invite.role.${role as (typeof INVITE_ROLES)[number]}`)
    : role;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
const keyify = (s: string) => {
  const words = s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const k = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  return k.replace(/^[0-9]+/, '').slice(0, 5);
};

export function OnboardingPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [teamName, setTeamName] = useState(() => t('auth.onboarding.defaultTeam'));
  const [teamKey, setTeamKey] = useState(() => keyify(t('auth.onboarding.defaultTeam')) || 'ENG');
  const [keyTouched, setKeyTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Workspaces this person may join through their verified email domain.
  const joinable = useQuery({
    queryKey: ['joinable'],
    queryFn: () => api.get<JoinableWorkspace[]>('/workspaces/joinable'),
    enabled: !!me.data,
  });

  if (me.isLoading) return <Spinner />;
  if (!me.data) return <Navigate to="/login" search={{ redirect: '/onboarding' }} />;

  const join = async (id: string) => {
    try {
      const res = await api.post<{ workspaceSlug: string }>(`/workspaces/${id}/join`);
      qc.removeQueries({ queryKey: keys.me });
      navigate({ to: '/$slug', params: { slug: res.workspaceSlug } });
    } catch (err) {
      setError(message(err));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!SLUG_PATTERN.test(slug)) return setError(t('auth.onboarding.slugInvalid'));
    if (!TEAM_KEY_PATTERN.test(teamKey)) return setError(t('auth.onboarding.teamKeyInvalid'));
    try {
      const res = await api.post<{ slug: string }>('/workspaces', {
        name,
        slug,
        teamName,
        teamKey,
      });
      qc.removeQueries({ queryKey: keys.me });
      navigate({ to: '/$slug', params: { slug: res.slug } });
    } catch (err) {
      setError(message(err));
    }
  };

  const joinList = joinable.data && joinable.data.length > 0 && (
    <div className="mb-6">
      <div className="mb-2 font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
        {t('auth.onboarding.orJoin')}
      </div>
      {joinable.data.map((w) => (
        <button
          type="button"
          key={w.id}
          onClick={() => join(w.id)}
          className="panel panel-sm panel-interactive mb-2 flex w-full items-center gap-3 p-3 text-left"
        >
          {w.logoUrl && <img src={w.logoUrl} alt="" className="h-6 w-6 object-cover" />}
          <span className="min-w-0 flex-1 truncate">{w.name}</span>
          <span className="font-mono text-[11px] whitespace-nowrap text-index">
            {t('auth.onboarding.members', { count: w.memberCount })}
          </span>
          <span className="arrow text-primary">→</span>
        </button>
      ))}
    </div>
  );

  // Not allowed to make one (e.g. site-invited without the grant): wait to be added instead.
  if (!me.data.canCreateWorkspace) {
    if (me.data.workspaces[0])
      return <Navigate to="/$slug" params={{ slug: me.data.workspaces[0].slug }} />;
    return (
      <AuthLayout kicker={t('auth.onboarding.waitKicker')} title={t('auth.onboarding.waitTitle')}>
        <ErrorLine error={error} />
        {joinList}
        <p className="mb-5 text-[13.5px] text-muted">{t('auth.onboarding.waitBody')}</p>
        <button
          type="button"
          className="btn btn-ghost w-full"
          onClick={() => {
            me.refetch();
            joinable.refetch();
          }}
        >
          {t('auth.onboarding.checkAgain')}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout kicker={t('auth.onboarding.kicker')} title={t('auth.onboarding.title')}>
      {joinList}
      <form onSubmit={submit}>
        <ErrorLine error={error} />
        <TextField
          label={t('auth.onboarding.workspaceName')}
          required
          autoFocus
          value={name}
          placeholder="Acme Inc."
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
        <label className="mb-4 block">
          <span className="mb-1 block font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
            {t('auth.onboarding.workspaceUrl')}
          </span>
          <div className="flex items-center border border-border bg-bg focus-within:border-primary">
            <span className="pl-3 font-mono text-[12px] text-index">{location.host}/</span>
            <input
              className="h-9 min-w-0 flex-1 bg-transparent pr-3 outline-none"
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
          </div>
        </label>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <TextField
            label={t('auth.onboarding.firstTeam')}
            required
            value={teamName}
            onChange={(e) => {
              setTeamName(e.target.value);
              if (!keyTouched) setTeamKey(keyify(e.target.value));
            }}
          />
          <TextField
            label={t('auth.onboarding.key')}
            required
            value={teamKey}
            maxLength={7}
            onChange={(e) => {
              setKeyTouched(true);
              setTeamKey(e.target.value.toUpperCase());
            }}
          />
        </div>
        <p className="-mt-2 mb-5 text-[12px] text-index">
          {tx('auth.onboarding.identifiers', {
            id: `${teamKey || 'KEY'}-1`,
            code: (c) => <span className="font-mono text-muted">{c}</span>,
          })}
        </p>
        <button className="btn btn-primary w-full">
          {t('auth.onboarding.submit')} <span className="arrow">→</span>
        </button>
      </form>
    </AuthLayout>
  );
}

/**
 * The OAuth consent screen: an app (an MCP client) asks to use a workspace's MCP server as the
 * signed-in person. The request's parameters are passed to the API untouched.
 */
export function OAuthAuthorizePage() {
  const me = useMe();
  const query = window.location.search;
  const info = useQuery({
    queryKey: ['oauthAuthorize', query],
    queryFn: () => api.get<OAuthAuthorizeInfo>(`/oauth/authorize${query}`),
    enabled: !!me.data,
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const back = (info.error as ApiError | null)?.details as { redirect?: string } | undefined;

  // Errors the app should hear about go straight back to it.
  useEffect(() => {
    if (back?.redirect) window.location.replace(back.redirect);
  }, [back?.redirect]);

  if (me.isLoading || (me.data && info.isLoading) || back?.redirect) return <Spinner />;
  if (!me.data) return <Navigate to="/login" search={{ redirect: `/oauth/authorize${query}` }} />;
  if (info.error || !info.data)
    return (
      <AuthLayout kicker={t('auth.oauth.kicker')} title={t('auth.oauth.cantConnect')}>
        <ErrorLine error={message(info.error)} />
        <Link to="/" className="btn btn-ghost w-full">
          {t('auth.oauth.goToOrdo')}
        </Link>
      </AuthLayout>
    );

  const { client, workspace, redirectUri } = info.data;
  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const params = Object.fromEntries(new URLSearchParams(query));
      const res = await api.post<{ redirect: string }>('/oauth/authorize', { ...params, approve });
      setSent(true);
      window.location.assign(res.redirect);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  if (sent)
    return (
      <AuthLayout kicker={t('auth.oauth.kicker')} title={t('auth.oauth.done')}>
        <p className="text-[13.5px] text-muted">
          {tx('auth.oauth.sentBack', {
            app: client.name,
            b: (c) => <span className="text-text">{c}</span>,
          })}
        </p>
      </AuthLayout>
    );

  return (
    <AuthLayout
      kicker={t('auth.oauth.kicker')}
      title={t('auth.oauth.title', { app: client.name })}
      footer={t('auth.oauth.footer', { email: me.data.email })}
    >
      <ErrorLine error={error} />
      <p className="text-[13.5px] text-muted">
        {tx('auth.oauth.wants', {
          app: client.name,
          workspace: workspace.name,
          b: (c) => <span className="text-text">{c}</span>,
        })}
      </p>
      <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
        <li>— {t('auth.oauth.canRead')}</li>
        <li>— {t('auth.oauth.canWrite')}</li>
      </ul>
      <div className="mt-5 border-t border-border-soft pt-4 text-[12.5px]">
        {client.verified ? (
          <div className="flex items-center gap-1.5 text-muted">
            <BadgeCheck size={13} className="flex-none" />
            <span>
              {tx('auth.oauth.publishedBy', {
                host: client.host,
                code: (c) => <span className="font-mono text-text">{c}</span>,
              })}
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-1.5 text-warning">
            <TriangleAlert size={13} className="mt-0.5 flex-none" />
            <span>{t('auth.oauth.selfNamed')}</span>
          </div>
        )}
        <div className="mt-2 font-mono text-[11px] break-all text-index">
          {t('auth.oauth.returnsTo', { url: redirectUri.split('?')[0]! })}
        </div>
      </div>
      <div className="mt-6 flex gap-2">
        <button
          type="button"
          className="btn btn-ghost flex-1"
          disabled={busy}
          onClick={() => answer(false)}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={busy}
          onClick={() => answer(true)}
        >
          {t('auth.oauth.allow')} <span className="arrow">→</span>
        </button>
      </div>
    </AuthLayout>
  );
}
