import type { SsoOption } from '@ordo/shared';
import { Link, Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { useBootstrap, useMe } from '../api/queries.ts';
import { AppShell } from '../components/AppShell.tsx';
import { EmptyState, Spinner } from '../components/PageHeader.tsx';
import { ssoStartUrl } from '../lib/sso.ts';
import { WorkspaceProvider } from '../lib/workspace.tsx';

export function WorkspaceLayout() {
  const { slug } = useParams({ from: '/$slug' });
  const navigate = useNavigate();
  // Captured once: during the redirect `useLocation()` already reports /login?redirect=…, and
  // re-deriving the target from it would nest redirects forever and hang the tab.
  const [returnTo] = useState(() => window.location.pathname + window.location.search);
  const me = useMe();
  const boot = useBootstrap(slug);
  const signedOut = !me.isLoading && !me.data;

  useEffect(() => {
    if (signedOut) navigate({ to: '/login', search: { redirect: returnTo }, replace: true });
  }, [signedOut, navigate, returnTo]);

  useEffect(() => {
    try {
      if (boot.data) localStorage.setItem('ordo:lastWorkspace', slug);
    } catch {}
  }, [boot.data, slug]);

  if (!me.data) return <Spinner label="booting" />;
  if (boot.error instanceof ApiError && boot.error.code === 'sso_required') {
    return <SsoRequired error={boot.error} returnTo={returnTo} />;
  }
  if (boot.error) {
    const notFound = boot.error instanceof ApiError && boot.error.status === 404;
    return (
      <div className="hud-ground flex h-full">
        <EmptyState
          title={notFound ? 'workspace not found' : 'could not load workspace'}
          body={notFound ? "It doesn't exist, or you're not a member." : boot.error.message}
          action={
            <Link to="/" className="btn btn-ghost">
              Back <span className="arrow">→</span>
            </Link>
          }
        />
      </div>
    );
  }
  if (!boot.data) return <Spinner label="loading workspace" />;
  return (
    <WorkspaceProvider data={boot.data} me={me.data} slug={slug}>
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
        title="sso required"
        body={
          options.length
            ? `${details?.workspace ?? 'This workspace'} asks you to sign in through your organisation's identity provider.`
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
                Continue with {o.name} <span className="arrow">→</span>
              </a>
            ))}
            <Link to="/" className="btn btn-ghost">
              Back
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
        body="Nothing lives at this address."
        action={
          <Link to="/" className="btn btn-ghost">
            Home <span className="arrow">→</span>
          </Link>
        }
      />
    </div>
  );
}
