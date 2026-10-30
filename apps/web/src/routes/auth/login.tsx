import type { SsoDiscovery } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { Fingerprint, KeyRound } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { keys, useConfig, useMe } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { t, tx } from '../../i18n/index.ts';
import {
  cancelPasskeyRequest,
  confirmWithPasskey,
  passkeyAutofillSupported,
  passkeyCancelled,
  passkeysHere,
  signInWithPasskey,
} from '../../lib/passkeys.ts';
import { forgetLastSso, lastSso, ssoStartUrl } from '../../lib/sso.ts';
import { SsoButtons, WorkspaceSso } from './sso.tsx';
import { AuthLayout, BackLink, ErrorLine, message, OrDivider, TextField } from './ui.tsx';

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
