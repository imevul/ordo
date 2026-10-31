import type { Project } from '@ordo/shared';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';

/** Who gets the project's pull requests once they're ready for review: an agent in its teams. */
export function PullRequestAgentFields({
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
