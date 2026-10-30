import {
  LABEL_COLORS,
  type Milestone,
  PROJECT_HEALTH,
  PROJECT_STATUSES,
  type Project,
  type ProjectHealth,
} from '@ordo/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Milestone as MilestoneIcon, Plus, Star, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { keys, useIssues, useProjectUpdates, useWsMutation } from '../api/queries.ts';
import { LineChart } from '../components/Charts.tsx';
import { IssuesView } from '../components/IssuesView.tsx';
import { ProjectIcon, ProjectStatusIcon, TeamIcon } from '../components/icons.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { MarkdownEditor } from '../components/MarkdownEditor.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { ProgressBar, ProgressStats } from '../components/Progress.tsx';
import { ProjectDocs } from '../components/ProjectDocs.tsx';
import { assigneeOptions, Picker } from '../components/properties.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { ConfirmModal, confirmDialog, Modal } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { healthLabel, projectStatusLabel } from '../i18n/labels.ts';
import { relativeTime, shortDate } from '../lib/format.ts';
import { burnUp, isoDay } from '../lib/insights.ts';
import { memberChoices, useWorkspace } from '../lib/workspace.tsx';

const HEALTH_COLOR: Record<ProjectHealth, string> = {
  on_track: 'var(--color-success)',
  at_risk: 'var(--color-warning)',
  off_track: 'var(--color-error)',
};

export function HealthChip({ health }: { health: ProjectHealth | null }) {
  if (!health)
    return <span className="chip [--chip:var(--color-index)]">{t('projects.noUpdate')}</span>;
  return (
    <span className="chip" style={{ ['--chip' as string]: HEALTH_COLOR[health] }}>
      {healthLabel(health)}
    </span>
  );
}

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

function MilestoneRow({ milestone }: { milestone: Milestone }) {
  const ws = useWorkspace();
  const [name, setName] = useState(milestone.name);
  useEffect(() => setName(milestone.name), [milestone.name]);
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/milestones/${milestone.id}`), body),
  );
  const remove = useWsMutation(ws.slug, () =>
    api.del(wsPath(ws.slug, `/milestones/${milestone.id}`)),
  );
  const p = milestone.progress;
  return (
    <div className="grid grid-cols-[auto_1fr_8.5rem_7rem_auto] items-center gap-3 border-b border-border-soft py-2">
      <MilestoneIcon size={14} className="text-muted" />
      <input
        value={name}
        disabled={ws.isGuest}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== milestone.name && save.mutate({ name })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="min-w-0 bg-transparent text-[13.5px] outline-none focus:shadow-[inset_0_-1px_0_var(--color-primary)]"
        aria-label={t('projects.milestones.nameLabel')}
      />
      <input
        type="date"
        value={milestone.targetDate ?? ''}
        disabled={ws.isGuest}
        onChange={(e) => save.mutate({ targetDate: e.target.value || null })}
        className="input h-7 px-1.5 font-mono text-[11.5px]"
        aria-label={t('projects.milestones.targetDate')}
      />
      <span
        className="font-mono text-[11px] text-index"
        title={t('projects.milestones.progressTitle')}
      >
        {p.completed}/{p.total} · {p.total ? Math.round((p.completed / p.total) * 100) : 0}%
      </span>
      {!ws.isGuest ? (
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-index hover:text-error"
          onClick={async () => {
            if (
              await confirmDialog({
                title: t('projects.milestones.confirmDeleteTitle', { name: milestone.name }),
                body: t('projects.milestones.confirmDeleteBody'),
                danger: true,
              })
            )
              remove.mutate(undefined);
          }}
          aria-label={t('projects.milestones.deleteLabel', { name: milestone.name })}
        >
          <Trash2 size={13} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** Scope and completed work since the project started (or its first issue), day by day. */
function ProjectProgressChart({ project }: { project: Project }) {
  const ws = useWorkspace();
  const filter = useMemo(() => ({ projectIds: [project.id] }), [project.id]);
  const { data: issues = [] } = useIssues(ws.slug, filter);
  const points = useMemo(() => {
    if (issues.length === 0) return [];
    const first = issues.map((i) => i.createdAt).sort()[0]!;
    const from =
      project.startDate && project.startDate < first ? project.startDate : first.slice(0, 10);
    return burnUp(issues, 'count', from, isoDay(Date.now()));
  }, [issues, project.startDate]);
  if (points.length < 2) return null;
  return (
    <div className="mt-8">
      <div className="section-label mb-3">{t('projects.chart.title')}</div>
      <LineChart
        label={t('projects.chart.label', { name: project.name })}
        x={points.map((p) => p.day)}
        height={160}
        series={[
          {
            key: 'scope',
            label: t('projects.chart.scope'),
            color: 'var(--color-chart-2)',
            dashed: true,
            values: points.map((p) => p.scope),
          },
          {
            key: 'completed',
            label: t('projects.chart.completed'),
            color: 'var(--color-primary)',
            values: points.map((p) => p.completed),
          },
        ]}
      />
    </div>
  );
}

/** Stages of the project, each with a target date and its own progress. */
function ProjectMilestones({ project }: { project: Project }) {
  const ws = useWorkspace();
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const create = useWsMutation(ws.slug, (body: object) =>
    api.post(wsPath(ws.slug, `/projects/${project.id}/milestones`), body),
  );
  if (ws.isGuest && project.milestones.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="section-label mb-2">{t('projects.milestones.title')}</div>
      {project.milestones.map((m) => (
        <MilestoneRow key={m.id} milestone={m} />
      ))}
      {!ws.isGuest && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate(
              { name, targetDate: targetDate || null },
              {
                onSuccess: () => {
                  setName('');
                  setTargetDate('');
                },
              },
            );
          }}
        >
          <input
            className="input min-w-0 flex-1"
            placeholder={t('projects.milestones.newPlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="date"
            className="input w-36 font-mono text-[12px]"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            aria-label={t('projects.milestones.targetDate')}
          />
          <button className="btn btn-ghost btn-sm" disabled={!name.trim()}>
            <Plus size={13} /> {t('common.add')}
          </button>
        </form>
      )}
    </div>
  );
}

function ProjectOverview({ project }: { project: Project }) {
  const ws = useWorkspace();
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/projects/${project.id}`), body),
  );
  const { data: updates = [] } = useProjectUpdates(ws.slug, project.id);
  const postUpdate = useWsMutation(
    ws.slug,
    (body: object) => api.post(wsPath(ws.slug, `/projects/${project.id}/updates`), body),
    {
      invalidate: [keys.projectUpdates(ws.slug, project.id) as unknown as unknown[]],
    },
  );
  const [name, setName] = useState(project.name);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState(project.description ?? '');
  const [update, setUpdate] = useState('');
  const [health, setHealth] = useState<ProjectHealth>(project.health ?? 'on_track');
  useEffect(() => setName(project.name), [project.name]);
  const lead = project.leadId ? ws.memberById.get(project.leadId) : null;

  return (
    <div className="mx-auto grid max-w-5xl gap-10 px-6 py-8 lg:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== project.name && save.mutate({ name })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="w-full bg-transparent text-[28px] font-bold tracking-[-0.02em] outline-none"
          aria-label={t('projects.overview.nameLabel')}
        />
        <div className="mt-4">
          {editingDesc ? (
            <>
              <MarkdownEditor
                value={desc}
                onChange={setDesc}
                autoFocus
                minRows={5}
                onSubmit={() => {
                  save.mutate({ description: desc });
                  setEditingDesc(false);
                }}
                onCancel={() => setEditingDesc(false)}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEditingDesc(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    save.mutate({ description: desc });
                    setEditingDesc(false);
                  }}
                >
                  {t('common.save')}
                </button>
              </div>
            </>
          ) : (
            <div className="min-h-10 cursor-text" onClick={() => setEditingDesc(true)}>
              {project.description?.trim() ? (
                <Markdown source={project.description} />
              ) : (
                <p className="text-index">{t('projects.overview.addBrief')}</p>
              )}
            </div>
          )}
        </div>

        <div className="mt-8">
          <div className="section-label mb-3">{t('projects.overview.progress')}</div>
          <ProgressStats progress={project.progress} />
          <ProgressBar progress={project.progress} className="mt-3" />
        </div>

        <ProjectProgressChart project={project} />

        <ProjectMilestones project={project} />

        <div className="mt-10">
          <div className="section-label mb-3">{t('projects.overview.updates')}</div>
          <div className="panel panel-sm p-3">
            <MarkdownEditor
              value={update}
              onChange={setUpdate}
              placeholder={t('projects.overview.updatePlaceholder')}
              minRows={2}
              bare
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {PROJECT_HEALTH.map((h) => (
                <button
                  type="button"
                  key={h}
                  onClick={() => setHealth(h)}
                  className={`prop ${health === h ? 'text-text shadow-[inset_0_0_0_1px_var(--color-primary)]' : ''}`}
                  aria-pressed={health === h}
                >
                  <span className="h-[7px] w-[7px]" style={{ background: HEALTH_COLOR[h] }} />
                  {healthLabel(h)}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-primary btn-sm ml-auto"
                disabled={!update.trim()}
                onClick={() => {
                  postUpdate.mutate({ body: update, health });
                  setUpdate('');
                }}
              >
                {t('projects.overview.postUpdate')}
              </button>
            </div>
          </div>
          {updates.map((u) => {
            const author = u.authorId ? ws.memberById.get(u.authorId) : undefined;
            return (
              <div key={u.id} className="mt-4 border-b border-border-soft pb-4">
                <div className="flex items-center gap-2 text-[12.5px]">
                  {author && (
                    <Avatar
                      name={author.name}
                      color={author.avatarColor}
                      src={author.avatarUrl}
                      size={18}
                    />
                  )}
                  <span className="font-medium">
                    {author?.name ?? t('projects.overview.formerMember')}
                  </span>
                  <HealthChip health={u.health} />
                  <span className="ml-auto font-mono text-[11px] text-index">
                    {relativeTime(u.createdAt)}
                  </span>
                </div>
                <div className="mt-2">
                  <Markdown source={u.body} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <aside>
        <div className="section-label mb-3">{t('projects.overview.properties')}</div>
        <div className="flex flex-col gap-3 text-[12.5px]">
          <label className="block text-index">
            {t('common.status')}
            <select
              className="input mt-1 h-8"
              value={project.status}
              onChange={(e) => save.mutate({ status: e.target.value })}
            >
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {projectStatusLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <div className="text-index">
            {t('projects.overview.lead')}
            <div className="mt-1">
              <Picker
                placeholder={t('projects.overview.setLead')}
                options={assigneeOptions(ws)}
                selected={[project.leadId ?? 'none']}
                onSelect={(v) => save.mutate({ leadId: v === 'none' ? null : v })}
                trigger={
                  <button type="button" className="prop w-full justify-start">
                    {lead ? (
                      <Avatar
                        name={lead.name}
                        color={lead.avatarColor}
                        src={lead.avatarUrl}
                        size={16}
                      />
                    ) : null}
                    {lead?.name ?? t('projects.overview.noLead')}
                  </button>
                }
              />
            </div>
          </div>
          <label className="block text-index">
            {t('projects.overview.startDate')}
            <input
              type="date"
              className="input mt-1 h-8"
              value={project.startDate ?? ''}
              onChange={(e) => save.mutate({ startDate: e.target.value || null })}
            />
          </label>
          <label className="block text-index">
            {t('projects.overview.targetDate')}
            <input
              type="date"
              className="input mt-1 h-8"
              value={project.targetDate ?? ''}
              onChange={(e) => save.mutate({ targetDate: e.target.value || null })}
            />
          </label>
          <label className="block text-index">
            {t('projects.overview.initiative')}
            <select
              className="input mt-1 h-8"
              value={project.initiativeId ?? ''}
              onChange={(e) => save.mutate({ initiativeId: e.target.value || null })}
            >
              <option value="">{t('common.none')}</option>
              {ws.initiatives.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-index" title={t('projects.overview.defaultAssigneeHint')}>
            {t('projects.overview.defaultAssignee')}
            <select
              className="input mt-1 h-8"
              value={project.defaultAssignee}
              onChange={(e) => save.mutate({ defaultAssignee: e.target.value })}
            >
              <option value="workspace">
                {t('projects.overview.workspaceDefault', {
                  name:
                    ws.memberById.get(ws.workspace.settings.defaultAssigneeId ?? '')?.name ??
                    t('projects.overview.noAssignee'),
                })}
              </option>
              <option value="none">{t('issues.none.assignee')}</option>
              {memberChoices(ws).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="text-index">
            {t('projects.overview.teams')}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ws.teams.map((team) => {
                const on = project.teamIds.includes(team.id);
                return (
                  <button
                    type="button"
                    key={team.id}
                    className={`prop ${on ? 'text-text shadow-[inset_0_0_0_1px_var(--color-primary)]' : ''}`}
                    onClick={() => {
                      const next = on
                        ? project.teamIds.filter((x) => x !== team.id)
                        : [...project.teamIds, team.id];
                      if (next.length) save.mutate({ teamIds: next });
                    }}
                    aria-pressed={on}
                  >
                    <TeamIcon color={team.color} label={team.key} size={14} /> {team.key}
                  </button>
                );
              })}
            </div>
          </div>
          {(ws.repositories.length > 0 || project.repositoryIds.length > 0) && (
            <div className="text-index" title={t('agents.repositories.projectHint')}>
              {t('agents.repositories.project')}
              <div className="mt-1 flex flex-wrap gap-1.5">
                {ws.repositories.map((repo) => {
                  const on = project.repositoryIds.includes(repo.id);
                  return (
                    <button
                      type="button"
                      key={repo.id}
                      className={`prop font-mono ${on ? 'text-text shadow-[inset_0_0_0_1px_var(--color-primary)]' : ''}`}
                      onClick={() =>
                        save.mutate({
                          repositoryIds: on
                            ? project.repositoryIds.filter((x) => x !== repo.id)
                            : [...project.repositoryIds, repo.id],
                        })
                      }
                      aria-pressed={on}
                      title={repo.url}
                    >
                      {repo.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {ws.isAdmin && project.repositoryIds.length > 0 && (
            <PullRequestAgentFields project={project} onSave={(body) => save.mutate(body)} />
          )}
          <div className="text-index">
            {t('projects.overview.color')}
            <div className="mt-1 flex flex-wrap gap-1">
              {LABEL_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => save.mutate({ color: c })}
                  className={`h-5 w-5 ${project.color === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
                  style={{ background: c }}
                  aria-label={t('projects.overview.colorLabel', { color: c })}
                />
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Who gets the project's pull requests once they're ready for review: an agent in its teams. */
function PullRequestAgentFields({
  project,
  onSave,
}: {
  project: Project;
  onSave: (body: { pullRequestAgentId?: string | null; pullRequestScope?: string }) => void;
}) {
  const ws = useWorkspace();
  const agents = ws.members.filter(
    (m) =>
      m.kind === 'agent' &&
      !m.suspended &&
      project.teamIds.some((id) => ws.teamById.get(id)?.memberIds.includes(m.id)),
  );
  return (
    <>
      <label className="block text-index" title={t('projects.overview.pullRequestAgentHint')}>
        {t('projects.overview.pullRequestAgent')}
        <select
          className="input mt-1 h-8"
          value={project.pullRequestAgentId ?? ''}
          onChange={(e) => onSave({ pullRequestAgentId: e.target.value || null })}
        >
          <option value="">{t('projects.overview.noPullRequestAgent')}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {project.pullRequestAgentId && (
        <label className="block text-index">
          {t('projects.overview.pullRequestScope')}
          <select
            className="input mt-1 h-8"
            value={project.pullRequestScope}
            onChange={(e) => onSave({ pullRequestScope: e.target.value })}
          >
            <option value="linked">{t('projects.overview.pullRequestScopeLinked')}</option>
            <option value="all">{t('projects.overview.pullRequestScopeAll')}</option>
          </select>
        </label>
      )}
    </>
  );
}

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
