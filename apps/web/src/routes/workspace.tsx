import type { Me, SsoOption } from '@ordo/shared';
import { Link, Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { useBootstrap, useConfig, useMe } from '../api/queries.ts';
import { AppShell } from '../components/AppShell.tsx';
import { EmptyState, Spinner } from '../components/PageHeader.tsx';
import { switchLocale, t } from '../i18n/index.ts';
import { ssoStartUrl } from '../lib/sso.ts';
import { WorkspaceProvider } from '../lib/workspace.tsx';
import { SyncProvider, useSyncState } from '../sync/context.tsx';

export function WorkspaceLayout() {
  const { slug } = useParams({ from: '/$slug' });
  const navigate = useNavigate();
  // Captured once: during the redirect `useLocation()` already reports /login?redirect=…, and
  // re-deriving the target from it would nest redirects forever and hang the tab.
  const [returnTo] = useState(() => window.location.pathname + window.location.search);
  const me = useMe();
  const config = useConfig();
  const signedOut = !me.isLoading && !me.data;

  useEffect(() => {
    if (signedOut) navigate({ to: '/login', search: { redirect: returnTo }, replace: true });
  }, [signedOut, navigate, returnTo]);

  const locale = me.data?.locale;
  useEffect(() => {
    if (locale) switchLocale(locale);
  }, [locale]);

  if (!me.data) return <Spinner label={t('shell.workspace.booting')} />;
  return (
    <SyncProvider slug={slug} userId={me.data.id} mode={config.data?.offlineSync}>
      <WorkspaceBody slug={slug} me={me.data} returnTo={returnTo} />
    </SyncProvider>
  );
}

/**
 * The workspace's bootstrap: the server's, or (while it loads, or when it can't be reached) the
 * one in the local copy.
 */
function WorkspaceBody({ slug, me, returnTo }: { slug: string; me: Me; returnTo: string }) {
  const boot = useBootstrap(slug);
  const local = useSyncState();
  const unreachable =
    !boot.error ||
    (boot.error instanceof ApiError && (boot.error.status === 0 || boot.error.status >= 502));
  const data = boot.data ?? (unreachable && local?.ready ? local.bootstrap : undefined);

  useEffect(() => {
    try {
      if (data) localStorage.setItem('ordo:lastWorkspace', slug);
    } catch {}
  }, [data, slug]);

  if (!data && boot.error instanceof ApiError && boot.error.code === 'sso_required') {
    return <SsoRequired error={boot.error} returnTo={returnTo} />;
  }
  if (!data && boot.error) {
    const notFound = boot.error instanceof ApiError && boot.error.status === 404;
    return (
      <div className="hud-ground flex h-full">
        <EmptyState
          title={notFound ? t('shell.workspace.notFound') : t('shell.workspace.loadFailed')}
          body={notFound ? t('shell.workspace.notFoundBody') : boot.error.message}
          action={
            <Link to="/" className="btn btn-ghost">
              {t('common.back')} <span className="arrow">→</span>
            </Link>
          }
        />
      </div>
    );
  }
  if (!data) return <Spinner label={t('shell.workspace.loading')} />;
  return (
    <WorkspaceProvider data={data} me={me} slug={slug}>
      <AppShell />
    </WorkspaceProvider>
  );
}

/** The workspace requires SSO and this session came from a password (or another provider). */
function SsoRequired({ error, returnTo }: { error: ApiError; returnTo: string }) {
  const details = error.details as { workspace?: string; options?: SsoOption[] } | undefined;
  const options = details?.options ?? [];
  return (
    <div className="hud-ground flex h-full">
      <EmptyState
        title={t('shell.workspace.ssoRequired')}
        body={
          options.length
            ? details?.workspace
              ? t('shell.workspace.ssoBody', { workspace: details.workspace })
              : t('shell.workspace.ssoBodyThisWorkspace')
            : error.message
        }
        action={
          <div className="flex flex-col items-center gap-2">
            {options.map((o) => (
              <a
                key={o.providerId}
                href={ssoStartUrl(o.providerId, { redirect: returnTo })}
                className="btn btn-primary"
              >
                {t('shell.workspace.continueWith', { name: o.name })}{' '}
                <span className="arrow">→</span>
              </a>
            ))}
            <Link to="/" className="btn btn-ghost">
              {t('common.back')}
            </Link>
          </div>
        }
      />
    </div>
  );
}

export function WorkspaceIndex() {
  const { slug } = useParams({ from: '/$slug/' });
  return <Navigate to="/$slug/my-issues/$tab" params={{ slug, tab: 'assigned' }} replace />;
}

export function NotFound() {
  return (
    <div className="hud-ground flex h-full">
      <EmptyState
        title="404"
        body={t('shell.workspace.pageNotFound')}
        action={
          <Link to="/" className="btn btn-ghost">
            {t('common.home')} <span className="arrow">→</span>
          </Link>
        }
      />
    </div>
  );
}
