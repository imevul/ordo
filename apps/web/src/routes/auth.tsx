import { type JoinableWorkspace, SLUG_PATTERN, TEAM_KEY_PATTERN } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.ts';
import { keys, useConfig, useMe } from '../api/queries.ts';
import { OrdoMark } from '../components/icons.tsx';
import { Spinner } from '../components/PageHeader.tsx';

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
          self-hosted · no trackers · your data stays here
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
  err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';

export function IndexRedirect() {
  const me = useMe();
  const config = useConfig();
  if (me.isLoading || config.isLoading) return <Spinner label="booting" />;
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

export function LoginPage() {
  const { redirect } = useSearch({ from: '/login' });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config = useConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Set after a correct password when the account has two-factor authentication.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = () => {
    qc.removeQueries({ queryKey: keys.me });
    if (redirect?.startsWith('/')) navigate({ to: redirect });
    else navigate({ to: '/' });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await api.post('/auth/mfa', { mfaToken, code });
        return done();
      }
      const res = await api.post<{ ok: boolean; mfaRequired?: boolean; mfaToken?: string }>(
        '/auth/login',
        {
          email,
          password,
        },
      );
      if (res.mfaRequired && res.mfaToken) setMfaToken(res.mfaToken);
      else done();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <AuthLayout kicker="two-factor" title="Enter your code.">
        <form onSubmit={submit}>
          <ErrorLine error={error} />
          <p className="mb-5 text-[13px] text-muted">
            Open your authenticator app and enter the 6-digit code for Ordo. Lost your device? Use
            one of your recovery codes instead.
          </p>
          <TextField
            label="Code"
            autoComplete="one-time-code"
            inputMode="text"
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn btn-primary mt-2 w-full" disabled={busy}>
            Verify <span className="arrow">→</span>
          </button>
          <button
            type="button"
            className="mt-4 w-full text-center font-mono text-[11px] tracking-[0.1em] text-index uppercase hover:text-text"
            onClick={() => {
              setMfaToken(null);
              setCode('');
              setError(null);
            }}
          >
            ← back
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      kicker="sign in"
      title="Welcome back."
      footer={
        config.data?.signupMode === 'open' || config.data?.hasUsers === false ? (
          <>
            New here?{' '}
            <Link to="/signup" search={{}} className="text-highlight hover:text-text">
              Create an account
            </Link>
          </>
        ) : (
          <>Need an account? Ask a workspace admin for an invite link.</>
        )
      }
    >
      <form onSubmit={submit}>
        <ErrorLine error={error} />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn btn-primary mt-2 w-full" disabled={busy}>
          Sign in <span className="arrow">→</span>
        </button>
        <Link
          to="/forgot-password"
          className="mt-4 block text-center font-mono text-[11px] tracking-[0.1em] text-index uppercase hover:text-text"
        >
          Forgot password?
        </Link>
      </form>
    </AuthLayout>
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
      kicker="password reset"
      title="Forgot your password?"
      footer={
        <Link to="/login" search={{}} className="text-highlight hover:text-text">
          Back to sign in
        </Link>
      }
    >
      {config.data && !config.data.emailEnabled ? (
        <p className="text-[13.5px] text-muted">
          Email isn't set up on this instance, so reset links can't be sent. Ask an administrator to
          reset your password.
        </p>
      ) : sent ? (
        <p className="text-[13.5px] text-muted">
          If an account uses <span className="text-text">{email}</span>, a reset link is on its way.
          It works for one hour.
        </p>
      ) : (
        <form onSubmit={submit}>
          <ErrorLine error={error} />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn btn-primary mt-2 w-full">
            Send reset link <span className="arrow">→</span>
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
    <AuthLayout kicker="password reset" title="Choose a new password.">
      <form onSubmit={submit}>
        <ErrorLine error={error} />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="-mt-2 mb-4 text-[12px] text-index">This signs you out everywhere else.</p>
        <button className="btn btn-primary w-full">
          Save password <span className="arrow">→</span>
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
      kicker={kind === 'verify' ? 'verify email' : 'email change'}
      title={
        state === 'done' ? 'Confirmed.' : state === 'failed' ? "That didn't work." : 'Confirming…'
      }
      footer={
        <Link to="/" className="text-highlight hover:text-text">
          Continue to Ordo
        </Link>
      }
    >
      {state === 'done' && (
        <p className="text-[13.5px] text-muted">
          {kind === 'verify'
            ? 'Your email address is verified.'
            : 'Your account now uses the new address.'}
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
      kicker={first ? 'first boot' : invite ? 'you were invited' : 'sign up'}
      title={first ? 'Set up Ordo.' : 'Create your account.'}
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/login"
            search={{ redirect: invite ? `/invite/${invite}` : undefined }}
            className="text-highlight hover:text-text"
          >
            Sign in
          </Link>
        </>
      }
    >
      {first && (
        <p className="mb-5 text-[13px] text-muted">
          You're the first user on this instance, so you'll be its admin.
        </p>
      )}
      {closed ? (
        <p className="text-[13.5px] text-muted">
          Sign-ups on this instance are invite-only. Ask a workspace admin for an invite link.
        </p>
      ) : (
        <form onSubmit={submit}>
          <ErrorLine error={error} />
          <TextField
            label="Name"
            required
            autoFocus
            autoComplete="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <TextField
            label="Password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <button className="btn btn-primary mt-2 w-full" disabled={busy}>
            Create account <span className="arrow">→</span>
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
  const [info, setInfo] = useState<{
    workspace: { name: string; slug: string };
    email: string | null;
    role: string;
    teams: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{
        workspace: { name: string; slug: string };
        email: string | null;
        role: string;
        teams: string[];
      }>(`/invites/${token}`)
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
  return (
    <AuthLayout kicker="invite" title={info ? `Join ${info.workspace.name}.` : 'Invitation'}>
      <ErrorLine error={error} />
      {info && (
        <p className="mb-4 text-[13px] text-muted">
          You're invited as <span className="text-text">{info.role}</span>
          {info.teams.length > 0 && (
            <>
              {' '}
              to <span className="text-text">{info.teams.join(', ')}</span>
            </>
          )}
          .
        </p>
      )}
      {info && me.data && (
        <>
          <p className="mb-5 text-[13.5px] text-muted">
            You're signed in as <span className="text-text">{me.data.email}</span>.
          </p>
          <button className="btn btn-primary w-full" onClick={accept}>
            Join workspace <span className="arrow">→</span>
          </button>
        </>
      )}
      {info && !me.data && (
        <div className="flex flex-col gap-2">
          <Link to="/signup" search={{ invite: token }} className="btn btn-primary w-full">
            Create account <span className="arrow">→</span>
          </Link>
          <Link
            to="/login"
            search={{ redirect: `/invite/${token}` }}
            className="btn btn-ghost w-full"
          >
            I already have an account
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}

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
  const [teamName, setTeamName] = useState('Engineering');
  const [teamKey, setTeamKey] = useState('ENG');
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
    if (!SLUG_PATTERN.test(slug))
      return setError('The URL may only contain lowercase letters, digits and dashes.');
    if (!TEAM_KEY_PATTERN.test(teamKey))
      return setError('Team key: 1–7 uppercase letters or digits, starting with a letter.');
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

  return (
    <AuthLayout kicker="new workspace" title="Create a workspace.">
      {joinable.data && joinable.data.length > 0 && (
        <div className="mb-6">
          <div className="mb-2 font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
            Or join your team
          </div>
          {joinable.data.map((w) => (
            <button
              type="button"
              key={w.id}
              onClick={() => join(w.id)}
              className="panel panel-sm panel-interactive mb-2 flex w-full items-center gap-3 p-3 text-left"
            >
              {w.logoUrl && <img src={w.logoUrl} alt="" className="h-6 w-6 object-cover" />}
              <span className="flex-1">{w.name}</span>
              <span className="font-mono text-[11px] text-index">{w.memberCount} members</span>
              <span className="arrow text-primary">→</span>
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit}>
        <ErrorLine error={error} />
        <TextField
          label="Workspace name"
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
            Workspace URL
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
            label="First team"
            required
            value={teamName}
            onChange={(e) => {
              setTeamName(e.target.value);
              if (!keyTouched) setTeamKey(keyify(e.target.value));
            }}
          />
          <TextField
            label="Key"
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
          Issues get identifiers like{' '}
          <span className="font-mono text-muted">{teamKey || 'KEY'}-1</span>.
        </p>
        <button className="btn btn-primary w-full">
          Create workspace <span className="arrow">→</span>
        </button>
      </form>
    </AuthLayout>
  );
}
