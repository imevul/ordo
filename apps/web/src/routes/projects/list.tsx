import { LABEL_COLORS, type Project } from '@ordo/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { ProjectIcon, ProjectStatusIcon, TeamIcon } from '../../components/icons.tsx';
import { EmptyState, PageHeader, Sep } from '../../components/PageHeader.tsx';
import { ProgressBar } from '../../components/Progress.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { Modal } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { projectStatusLabel } from '../../i18n/labels.ts';
import { shortDate } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { HealthChip } from './ui.tsx';

function ProjectModal({
  open,
  onClose,
  defaultTeamId,
}: {
  open: boolean;
  onClose: () => void;
  defaultTeamId?: string;
}) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [teamIds, setTeamIds] = useState<string[]>(
    defaultTeamId ? [defaultTeamId] : ws.myTeams.slice(0, 1).map((team) => team.id),
  );
  const [targetDate, setTargetDate] = useState('');
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<Project>(wsPath(ws.slug, '/projects'), body),
    { success: t('projects.create.created') },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || teamIds.length === 0) return;
    create.mutate(
      {
        name,
        teamIds,
        targetDate: targetDate || null,
        leadId: ws.me.id,
        status: 'planned',
        color: LABEL_COLORS[Math.floor(Math.random() * 6)],
      },
      {
        onSuccess: (p) => {
          onClose();
          navigate({
            to: '/$slug/project/$projectId',
            params: { slug: ws.slug, projectId: p.id },
            search: {},
          });
        },
      },
    );
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      label={t('projects.newProject')}
      align="center"
    >
      <form onSubmit={submit} className="p-6">
        <div className="section-label mb-4">{t('projects.newProject')}</div>
        <input
          autoFocus
          className="w-full bg-transparent text-[20px] font-semibold outline-none placeholder:text-index"
          placeholder={t('projects.create.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mt-4 text-[12px] text-muted">{t('projects.create.teams')}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {ws.teams.map((team) => {
            const on = teamIds.includes(team.id);
            return (
              <button
                type="button"
                key={team.id}
                onClick={() =>
                  setTeamIds(on ? teamIds.filter((x) => x !== team.id) : [...teamIds, team.id])
                }
                className={`prop ${on ? 'text-text shadow-[inset_0_0_0_1px_var(--color-primary)]' : ''}`}
                aria-pressed={on}
              >
                <TeamIcon color={team.color} label={team.key} size={14} /> {team.name}
              </button>
            );
          })}
        </div>
        <label className="mt-4 block text-[12px] text-muted">
          {t('projects.create.targetDate')}
          <input
            type="date"
            className="input mt-1"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!name.trim() || teamIds.length === 0 || create.isPending}
          >
            {t('projects.create.submit')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectsPage() {
  const ws = useWorkspace();
  const search = useSearch({ from: '/$slug/projects' });
  const navigate = useNavigate();
  const team = search.team ? ws.teamByKey.get(search.team) : undefined;
  const [open, setOpen] = useState(!!search.new);
  useEffect(() => {
    if (search.new) setOpen(true);
  }, [search.new]);
  const close = () => {
    setOpen(false);
    if (search.new)
      navigate({
        to: '/$slug/projects',
        params: { slug: ws.slug },
        search: { team: search.team },
        replace: true,
      });
  };
  const projects = ws.projects.filter((p) => !team || p.teamIds.includes(team.id));
  const STATUS_ORDER = ['started', 'planned', 'backlog', 'paused', 'completed', 'canceled'];
  const order = (p: Project) => STATUS_ORDER.indexOf(p.status);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {team ? team.key : ws.workspace.name}
            <Sep />
            {t('common.projects')}
          </>
        }
        title={team ? t('projects.list.teamTitle', { team: team.name }) : t('common.projects')}
        actions={
          !ws.isGuest && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
              <Plus size={13} /> {t('projects.newProject')}
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <EmptyState
            title={t('projects.list.emptyTitle')}
            body={t('projects.list.emptyBody')}
            action={
              !ws.isGuest && (
                <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
                  {t('projects.newProject')} <span className="arrow">→</span>
                </button>
              )
            }
          />
        ) : (
          <div className="min-w-[900px]">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem_7rem_6rem_10rem_9rem] items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              <span>{t('projects.list.columns.name')}</span>
              <span>{t('projects.list.columns.health')}</span>
              <span>{t('projects.list.columns.lead')}</span>
              <span>{t('projects.list.columns.target')}</span>
              <span>{t('projects.list.columns.status')}</span>
              <span>{t('projects.list.columns.progress')}</span>
            </div>
            {[...projects]
              .sort((a, b) => order(a) - order(b) || a.sortOrder - b.sortOrder)
              .map((p) => {
                const lead = p.leadId ? ws.memberById.get(p.leadId) : null;
                return (
                  <Link
                    key={p.id}
                    to="/$slug/project/$projectId"
                    params={{ slug: ws.slug, projectId: p.id }}
                    search={{}}
                    className="row grid h-11 grid-cols-[minmax(0,1fr)_8rem_7rem_6rem_10rem_9rem] items-center gap-3 border-b border-border-soft/60 px-4"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <ProjectIcon color={p.color} />
                      <span className="truncate text-[13.5px]">{p.name}</span>
                    </span>
                    <HealthChip health={p.health} />
                    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
                      {lead && (
                        <Avatar
                          name={lead.name}
                          color={lead.avatarColor}
                          src={lead.avatarUrl}
                          size={16}
                        />
                      )}
                      <span className="truncate">{lead?.name.split(' ')[0] ?? '—'}</span>
                    </span>
                    <span className="font-mono text-[11.5px] text-muted">
                      {p.targetDate ? shortDate(p.targetDate) : '—'}
                    </span>
                    <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                      <ProjectStatusIcon status={p.status} /> {projectStatusLabel(p.status)}
                    </span>
                    <ProgressBar progress={p.progress} />
                  </Link>
                );
              })}
          </div>
        )}
      </div>
      {open && <ProjectModal open onClose={close} defaultTeamId={team?.id} />}
    </div>
  );
}
