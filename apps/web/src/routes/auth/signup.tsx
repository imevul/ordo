import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client.ts';
import { keys, useConfig } from '../../api/queries.ts';
import { getLocale, t, tx } from '../../i18n/index.ts';

import { AuthLayout, ErrorLine, message, TextField } from './ui.tsx';

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
