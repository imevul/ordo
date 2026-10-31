import {
  LABEL_COLORS,
  PROJECT_HEALTH,
  PROJECT_STATUSES,
  type Project,
  type ProjectHealth,
} from '@ordo/shared';
import { useEffect, useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { keys, useProjectUpdates, useWsMutation } from '../../api/queries.ts';
import { ClickToEdit } from '../../components/ClickToEdit.tsx';
import { TeamIcon } from '../../components/icons.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { MarkdownEditor } from '../../components/MarkdownEditor.tsx';
import { ProgressBar, ProgressStats } from '../../components/Progress.tsx';
import { assigneeOptions, Picker } from '../../components/properties.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { t } from '../../i18n/index.ts';
import { healthLabel, projectStatusLabel } from '../../i18n/labels.ts';
import { relativeTime } from '../../lib/format.ts';
import { memberChoices, useWorkspace } from '../../lib/workspace.tsx';
import { ProjectMilestones } from './milestones.tsx';
import { ProjectProgressChart } from './progress-chart.tsx';
import { PullRequestAgentFields } from './pull-request-agent.tsx';
import { HEALTH_COLOR, HealthChip } from './ui.tsx';

export function ProjectOverview({ project }: { project: Project }) {
  const ws = useWorkspace();
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/projects/${project.id}`), body),
  );
  const { data: updates = [] } = useProjectUpdates(ws.slug, project.id);
  const postUpdate = useWsMutation(
    ws.slug,
    (body: object) => api.post(wsPath(ws.slug, `/projects/${project.id}/updates`), body),
    {
      invalidate: [keys.projectUpdates(ws.slug, project.id)],
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
          <ClickToEdit
            editing={editingDesc}
            onEdit={() => setEditingDesc(true)}
            className="min-h-10"
            editor={
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
            }
          >
            {project.description?.trim() ? (
              <Markdown source={project.description} />
            ) : (
              <p className="text-index">{t('projects.overview.addBrief')}</p>
            )}
          </ClickToEdit>
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
