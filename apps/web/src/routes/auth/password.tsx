import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client.ts';
import { keys, useConfig } from '../../api/queries.ts';
import { t, tx } from '../../i18n/index.ts';

import { AuthLayout, ErrorLine, message, TextField } from './ui.tsx';

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
