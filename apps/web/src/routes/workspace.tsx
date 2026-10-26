import { Link, Navigate, useLocation, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ApiError } from '../api/client.ts';
import { useBootstrap, useMe } from '../api/queries.ts';
import { AppShell } from '../components/AppShell.tsx';
import { EmptyState, Spinner } from '../components/PageHeader.tsx';
import { WorkspaceProvider } from '../lib/workspace.tsx';

export function WorkspaceLayout() {
  const { slug } = useParams({ from: '/$slug' });
  const location = useLocation();
  const me = useMe();
  const boot = useBootstrap(slug);

  useEffect(() => {
    try {
      if (boot.data) localStorage.setItem('ordo:lastWorkspace', slug);
    } catch {}
  }, [boot.data, slug]);

  if (me.isLoading) return <Spinner label="booting" />;
  if (!me.data) return <Navigate to="/login" search={{ redirect: location.href }} />;
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
