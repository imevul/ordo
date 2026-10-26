import {
  LABEL_COLORS,
  PROJECT_HEALTH,
  PROJECT_HEALTH_LABELS,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  type Project,
  type ProjectHealth,
} from '@ordo/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Plus, Star, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { keys, useProjectUpdates, useWsMutation } from '../api/queries.ts';
import { IssuesView } from '../components/IssuesView.tsx';
import { ProjectIcon, ProjectStatusIcon, TeamIcon } from '../components/icons.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { MarkdownEditor } from '../components/MarkdownEditor.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { ProgressBar, ProgressStats } from '../components/Progress.tsx';
import { assigneeOptions, Picker } from '../components/properties.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { ConfirmModal, Modal } from '../components/ui/Modal.tsx';
import { relativeTime, shortDate } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

const HEALTH_COLOR: Record<ProjectHealth, string> = {
  on_track: 'var(--color-success)',
  at_risk: 'var(--color-warning)',
  off_track: 'var(--color-error)',
};

export function HealthChip({ health }: { health: ProjectHealth | null }) {
  if (!health) return <span className="chip [--chip:var(--color-index)]">no update</span>;
  return (
    <span className="chip" style={{ ['--chip' as string]: HEALTH_COLOR[health] }}>
      {PROJECT_HEALTH_LABELS[health]}
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
    defaultTeamId ? [defaultTeamId] : ws.myTeams.slice(0, 1).map((t) => t.id),
  );
  const [targetDate, setTargetDate] = useState('');
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<Project>(wsPath(ws.slug, '/projects'), body),
    { success: 'Project created' },
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
    <Modal open={open} onClose={onClose} width={520} label="New project" align="center">
      <form onSubmit={submit} className="p-6">
        <div className="section-label mb-4">New project</div>
        <input
          autoFocus
          className="w-full bg-transparent text-[20px] font-semibold outline-none placeholder:text-index"
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mt-4 text-[12px] text-muted">Teams</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {ws.teams.map((t) => {
            const on = teamIds.includes(t.id);
            return (
              <button
                type="button"
                key={t.id}
                onClick={() =>
                  setTeamIds(on ? teamIds.filter((x) => x !== t.id) : [...teamIds, t.id])
                }
                className={`prop ${on ? 'text-text shadow-[inset_0_0_0_1px_var(--color-primary)]' : ''}`}
                aria-pressed={on}
              >
                <TeamIcon color={t.color} label={t.key} size={14} /> {t.name}
              </button>
            );
          })}
        </div>
        <label className="mt-4 block text-[12px] text-muted">
          Target date
          <input
            type="date"
            className="input mt-1"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!name.trim() || teamIds.length === 0 || create.isPending}
          >
            Create project <span className="arrow">→</span>
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
            projects
          </>
        }
        title={team ? `${team.name} projects` : 'Projects'}
        actions={
          !ws.isGuest && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
              <Plus size={13} /> New project
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <EmptyState
            title="no projects yet"
            body="Projects group issues toward a goal with a target date, across one or more teams."
            action={
              !ws.isGuest && (
                <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
                  New project <span className="arrow">→</span>
                </button>
              )
            }
          />
        ) : (
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem_7rem_6rem_10rem_9rem] items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              <span>Name</span>
              <span>Health</span>
              <span>Lead</span>
              <span>Target</span>
              <span>Status</span>
              <span>Progress</span>
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
                      <ProjectStatusIcon status={p.status} /> {PROJECT_STATUS_LABELS[p.status]}
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
          aria-label="Project name"
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
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    save.mutate({ description: desc });
                    setEditingDesc(false);
                  }}
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <div className="min-h-10 cursor-text" onClick={() => setEditingDesc(true)}>
              {project.description?.trim() ? (
                <Markdown source={project.description} />
              ) : (
                <p className="text-index">Add a project brief…</p>
              )}
            </div>
          )}
        </div>

        <div className="mt-8">
          <div className="section-label mb-3">Progress</div>
          <ProgressStats progress={project.progress} />
          <ProgressBar progress={project.progress} className="mt-3" />
        </div>

        <div className="mt-10">
          <div className="section-label mb-3">Updates</div>
          <div className="panel panel-sm p-3">
            <MarkdownEditor
              value={update}
              onChange={setUpdate}
              placeholder="Write a project update…"
              minRows={2}
              bare
            />
            <div className="mt-2 flex items-center gap-2">
              {PROJECT_HEALTH.map((h) => (
                <button
                  type="button"
                  key={h}
                  onClick={() => setHealth(h)}
                  className={`prop ${health === h ? 'text-text shadow-[inset_0_0_0_1px_var(--color-primary)]' : ''}`}
                  aria-pressed={health === h}
                >
                  <span className="h-[7px] w-[7px]" style={{ background: HEALTH_COLOR[h] }} />
                  {PROJECT_HEALTH_LABELS[h]}
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
                Post update
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
                  <span className="font-medium">{author?.name ?? 'Former member'}</span>
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
        <div className="section-label mb-3">Properties</div>
        <div className="flex flex-col gap-3 text-[12.5px]">
          <label className="block text-index">
            Status
            <select
              className="input mt-1 h-8"
              value={project.status}
              onChange={(e) => save.mutate({ status: e.target.value })}
            >
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <div className="text-index">
            Lead
            <div className="mt-1">
              <Picker
                placeholder="Set lead…"
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
                    {lead?.name ?? 'No lead'}
                  </button>
                }
              />
            </div>
          </div>
          <label className="block text-index">
            Start date
            <input
              type="date"
              className="input mt-1 h-8"
              value={project.startDate ?? ''}
              onChange={(e) => save.mutate({ startDate: e.target.value || null })}
            />
          </label>
          <label className="block text-index">
            Target date
            <input
              type="date"
              className="input mt-1 h-8"
              value={project.targetDate ?? ''}
              onChange={(e) => save.mutate({ targetDate: e.target.value || null })}
            />
          </label>
          <div className="text-index">
            Teams
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ws.teams.map((t) => {
                const on = project.teamIds.includes(t.id);
                return (
                  <button
                    type="button"
                    key={t.id}
                    className={`prop ${on ? 'text-text shadow-[inset_0_0_0_1px_var(--color-primary)]' : ''}`}
                    onClick={() => {
                      const next = on
                        ? project.teamIds.filter((x) => x !== t.id)
                        : [...project.teamIds, t.id];
                      if (next.length) save.mutate({ teamIds: next });
                    }}
                    aria-pressed={on}
                  >
                    <TeamIcon color={t.color} label={t.key} size={14} /> {t.key}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="text-index">
            Color
            <div className="mt-1 flex flex-wrap gap-1">
              {LABEL_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => save.mutate({ color: c })}
                  className={`h-5 w-5 ${project.color === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

export function ProjectDetailPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { projectId } = useParams({ from: '/$slug/project/$projectId' });
  const { tab } = useSearch({ from: '/$slug/project/$projectId' });
  const project = ws.projectById.get(projectId);
  const [confirm, setConfirm] = useState(false);
  const fav = ws.favorites.find((f) => f.kind === 'project' && f.targetId === projectId);
  const toggleFav = useWsMutation(ws.slug, () =>
    fav
      ? api.del(wsPath(ws.slug, `/favorites/${fav.id}`))
      : api.post(wsPath(ws.slug, '/favorites'), { kind: 'project', targetId: projectId }),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/projects/${projectId}`)), {
    success: 'Project deleted',
  });
  if (!project) return <EmptyState title="project not found" />;

  const tabs = (
    <div className="flex gap-1 px-4 pb-2">
      {(['overview', 'issues'] as const).map((t) => (
        <Link
          key={t}
          to="/$slug/project/$projectId"
          params={{ slug: ws.slug, projectId }}
          search={t === 'issues' ? { tab: 'issues' } : {}}
          className={`h-6 px-2.5 font-mono text-[11px] leading-6 tracking-[0.1em] uppercase ${(tab ?? 'overview') === t ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
        >
          {t}
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
        aria-label="Favorite"
      >
        <Star size={13} className={fav ? 'fill-primary text-primary' : ''} />
      </button>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => setConfirm(true)}
        aria-label="Delete project"
      >
        <Trash2 size={13} />
      </button>
    </>
  );
  const kicker = (
    <>
      projects
      <Sep />
      <span className="inline-flex items-center gap-1.5 align-[-2px]">
        <ProjectStatusIcon status={project.status} size={11} />{' '}
        {PROJECT_STATUS_LABELS[project.status].toLowerCase()}
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ProjectOverview project={project} />
          </div>
        </div>
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${project.name}?`}
        body="Its issues stay, but are removed from the project."
        confirmLabel="Delete project"
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
