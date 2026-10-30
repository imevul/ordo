import type { OAuthAuthorizeInfo } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { BadgeCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type ApiError, api } from '../../api/client.ts';
import { useMe } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { t, tx } from '../../i18n/index.ts';

import { AuthLayout, ErrorLine, message } from './ui.tsx';

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
