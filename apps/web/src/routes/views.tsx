import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Eye, Lock, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { IssuesView } from '../components/IssuesView.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { ConfirmModal } from '../components/ui/Modal.tsx';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

export function ViewsPage() {
  const ws = useWorkspace();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            views
          </>
        }
        title="Views"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ws.views.length === 0 ? (
          <EmptyState
            title="no saved views"
            body="Filter any issue list, then choose “Save view” to keep it here for the whole workspace — or just for you."
          />
        ) : (
          ws.views.map((v) => {
            const owner = v.ownerId ? ws.memberById.get(v.ownerId) : undefined;
            const team = v.teamId ? ws.teamById.get(v.teamId) : null;
            return (
              <Link
                key={v.id}
                to="/$slug/view/$viewId"
                params={{ slug: ws.slug, viewId: v.id }}
                className="row flex h-12 items-center gap-3 border-b border-border-soft/60 px-4"
              >
                <Eye size={15} className="text-muted" />
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{v.name}</span>
                {team && <span className="tag font-mono">{team.key}</span>}
                {!v.shared && (
                  <span className="tag">
                    <Lock size={11} /> private
                  </span>
                )}
                {owner && (
                  <Avatar
                    name={owner.name}
                    color={owner.avatarColor}
                    src={owner.avatarUrl}
                    size={16}
                  />
                )}
                <span className="hidden w-20 text-right font-mono text-[11px] text-index sm:block">
                  {relativeTime(v.updatedAt)}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}

export function ViewPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { viewId } = useParams({ from: '/$slug/view/$viewId' });
  const view = ws.viewById.get(viewId);
  const [confirm, setConfirm] = useState(false);
  const fav = ws.favorites.find((f) => f.kind === 'view' && f.targetId === viewId);
  const toggleFav = useWsMutation(ws.slug, () =>
    fav
      ? api.del(wsPath(ws.slug, `/favorites/${fav.id}`))
      : api.post(wsPath(ws.slug, '/favorites'), { kind: 'view', targetId: viewId }),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/views/${viewId}`)), {
    success: 'View deleted',
  });
  if (!view) return <EmptyState title="view not found" />;
  const canEdit = view.ownerId === ws.me.id || ws.isAdmin;
  return (
    <>
      <IssuesView
        key={view.id}
        view={view}
        kicker={
          <>
            views
            <Sep />
            {view.shared ? 'shared' : 'private'}
          </>
        }
        title={view.name}
        baseFilter={{}}
        teamId={view.teamId ?? undefined}
        storageKey={`view:${view.id}`}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => toggleFav.mutate(undefined)}
              aria-pressed={!!fav}
              aria-label="Favorite"
            >
              <Star size={13} className={fav ? 'fill-primary text-primary' : ''} />
            </button>
            {canEdit && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setConfirm(true)}
                aria-label="Delete view"
              >
                <Trash2 size={13} />
              </button>
            )}
          </>
        }
      />
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete “${view.name}”?`}
        body="Issues are not affected."
        confirmLabel="Delete view"
        danger
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => navigate({ to: '/$slug/views', params: { slug: ws.slug } }),
          })
        }
      />
    </>
  );
}
