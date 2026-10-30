import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { keys } from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';

import { AuthLayout, ErrorLine, message } from './ui.tsx';

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
