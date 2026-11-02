import { DEFAULT_ISSUE_DISPLAY, type View } from '@ordo/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Bot, Eye, Lock, Save, Star, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import {
  AgentRunsControls,
  AgentRunsList,
  type AgentRunsScope,
} from '../components/AgentRunsView.tsx';
import { IssuesView } from '../components/IssuesView.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { ConfirmModal } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { SubscribeViewButton } from './settings/account/calendar.tsx';

export function ViewsPage() {
  const ws = useWorkspace();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('views.list.kicker')}
          </>
        }
        title={t('views.list.title')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ws.views.length === 0 ? (
          <EmptyState title={t('views.list.emptyTitle')} body={t('views.list.emptyBody')} />
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
                {v.kind === 'agentRuns' ? (
                  <Bot size={15} className="text-muted" />
                ) : (
                  <Eye size={15} className="text-muted" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{v.name}</span>
                {team && <span className="tag font-mono">{team.key}</span>}
                {!v.shared && (
                  <span className="tag">
                    <Lock size={11} /> {t('views.list.private')}
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

const scopeOf = (view: View): AgentRunsScope => ({
  filter: view.filters,
  group: view.display.agentRunGroup ?? 'open',
  teamId: view.teamId ?? undefined,
});

/** A saved view of agent runs: the runs list, with what the view chose. */
function AgentRunsViewPage({
  view,
  kicker,
  actions,
  canEdit,
}: {
  view: View;
  kicker: ReactNode;
  actions: ReactNode;
  canEdit: boolean;
}) {
  const ws = useWorkspace();
  const [scope, setScope] = useState(() => scopeOf(view));
  useEffect(() => setScope(scopeOf(view)), [view]);
  const save = useWsMutation(
    ws.slug,
    () =>
      api.patch(wsPath(ws.slug, `/views/${view.id}`), {
        filters: scope.filter,
        teamId: scope.teamId ?? null,
        display: { ...DEFAULT_ISSUE_DISPLAY, agentRunGroup: scope.group },
      }),
    { success: t('issues.view.viewSaved') },
  );
  const dirty = JSON.stringify(scope) !== JSON.stringify(scopeOf(view));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={kicker}
        title={view.name}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {actions}
            {canEdit && dirty && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => save.mutate(undefined)}
              >
                <Save size={13} /> {t('common.save')}
              </button>
            )}
          </div>
        }
      />
      <AgentRunsControls scope={scope} onChange={setScope} />
      <AgentRunsList scope={scope} onChange={setScope} />
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
    success: t('views.view.deleted'),
  });
  if (!view) return <EmptyState title={t('views.view.notFound')} />;
  const canEdit = view.ownerId === ws.me.id || ws.isAdmin;
  const kicker = (
    <>
      {t('views.view.kicker')}
      <Sep />
      {view.shared ? t('views.view.shared') : t('views.view.private')}
    </>
  );
  const favorite = (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => toggleFav.mutate(undefined)}
      aria-pressed={!!fav}
      aria-label={t('views.view.favorite')}
    >
      <Star size={13} className={fav ? 'fill-primary text-primary' : ''} />
    </button>
  );
  const deleteButton = canEdit && (
    <button
      type="button"
      className="btn btn-danger btn-sm"
      onClick={() => setConfirm(true)}
      aria-label={t('views.view.delete')}
    >
      <Trash2 size={13} />
    </button>
  );
  return (
    <>
      {view.kind === 'agentRuns' ? (
        <AgentRunsViewPage
          key={view.id}
          view={view}
          kicker={kicker}
          canEdit={canEdit}
          actions={
            <>
              {favorite}
              {deleteButton}
            </>
          }
        />
      ) : (
        <IssuesView
          key={view.id}
          view={view}
          kicker={kicker}
          title={view.name}
          baseFilter={{}}
          teamId={view.teamId ?? undefined}
          storageKey={`view:${view.id}`}
          actions={
            <>
              {favorite}
              <SubscribeViewButton viewId={view.id} />
              {deleteButton}
            </>
          }
        />
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('views.view.confirmDeleteTitle', { name: view.name })}
        body={t('views.view.confirmDeleteBody')}
        confirmLabel={t('views.view.delete')}
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
