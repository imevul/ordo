import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { IssuesView } from '../../components/IssuesView.tsx';
import { ProjectStatusIcon } from '../../components/icons.tsx';
import { EmptyState, PageHeader, Sep } from '../../components/PageHeader.tsx';
import { ProjectDocs } from '../../components/ProjectDocs.tsx';
import { ConfirmModal } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { projectStatusLabel } from '../../i18n/labels.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { ProjectOverview } from './overview.tsx';

export function ProjectDetailPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { projectId } = useParams({ from: '/$slug/project/$projectId' });
  const { tab, doc } = useSearch({ from: '/$slug/project/$projectId' });
  const project = ws.projectById.get(projectId);
  const [confirm, setConfirm] = useState(false);
  const fav = ws.favorites.find((f) => f.kind === 'project' && f.targetId === projectId);
  const toggleFav = useWsMutation(ws.slug, () =>
    fav
      ? api.del(wsPath(ws.slug, `/favorites/${fav.id}`))
      : api.post(wsPath(ws.slug, '/favorites'), { kind: 'project', targetId: projectId }),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/projects/${projectId}`)), {
    success: t('projects.detail.deleted'),
  });
  if (!project) return <EmptyState title={t('projects.detail.notFound')} />;

  const tabs = (
    <div className="flex gap-1 px-4 pb-2">
      {(['overview', 'issues', 'docs'] as const).map((name) => (
        <Link
          key={name}
          to="/$slug/project/$projectId"
          params={{ slug: ws.slug, projectId }}
          search={name === 'overview' ? {} : { tab: name }}
          className={`h-6 px-2.5 font-mono text-[11px] leading-6 tracking-[0.1em] uppercase ${(tab ?? 'overview') === name ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
        >
          {t(`projects.detail.tabs.${name}`)}
        </Link>
      ))}
    </div>
  );
  const actions = (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => toggleFav.mutate(undefined)}
        aria-pressed={!!fav}
        aria-label={t('projects.detail.favorite')}
      >
        <Star size={13} className={fav ? 'fill-primary text-primary' : ''} />
      </button>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => setConfirm(true)}
        aria-label={t('projects.detail.delete')}
      >
        <Trash2 size={13} />
      </button>
    </>
  );
  const kicker = (
    <>
      {t('common.projects')}
      <Sep />
      <span className="inline-flex items-center gap-1.5 align-[-2px]">
        <ProjectStatusIcon status={project.status} size={11} />{' '}
        {projectStatusLabel(project.status).toLowerCase()}
      </span>
    </>
  );

  return (
    <>
      {tab === 'issues' ? (
        <IssuesView
          key={project.id}
          kicker={kicker}
          title={project.name}
          baseFilter={{ projectIds: [project.id] }}
          storageKey="project"
          createDefaults={{ projectId: project.id, teamId: project.teamIds[0] }}
          tabs={tabs}
          actions={actions}
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <PageHeader kicker={kicker} title={project.name} actions={actions}>
            {tabs}
          </PageHeader>
          {tab === 'docs' ? (
            <div className="min-h-0 flex-1">
              <ProjectDocs project={project} docId={doc} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ProjectOverview project={project} />
            </div>
          )}
        </div>
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('projects.detail.confirmDeleteTitle', { name: project.name })}
        body={t('projects.detail.confirmDeleteBody')}
        confirmLabel={t('projects.detail.delete')}
        danger
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () =>
              navigate({ to: '/$slug/projects', params: { slug: ws.slug }, search: {} }),
          })
        }
      />
    </>
  );
}
