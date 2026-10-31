import type { Milestone, Project } from '@ordo/shared';
import { Milestone as MilestoneIcon, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';

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

/** Stages of the project, each with a target date and its own progress. */
export function ProjectMilestones({ project }: { project: Project }) {
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
