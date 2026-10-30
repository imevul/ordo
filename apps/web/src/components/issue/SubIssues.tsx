import type { IssueDetail } from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useUpdateIssue } from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';
import { ui } from '../../lib/store.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { StatusProp } from '../properties.tsx';
import { Avatar } from '../ui/Avatar.tsx';

export function SubIssues({ issue }: { issue: IssueDetail }) {
  const ws = useWorkspace();
  const update = useUpdateIssue(ws.slug);
  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="section-label flex-1">
          {t('issue.detail.subIssues')}
          {issue.subIssues.length > 0 && (
            <span className="text-muted">
              {issue.completedSubIssueCount}/{issue.subIssueCount}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            ui.openCreateIssue({
              teamId: issue.teamId,
              parentId: issue.id,
              projectId: issue.projectId,
              cycleId: issue.cycleId,
            })
          }
        >
          <Plus size={12} /> {t('common.add')}
        </button>
      </div>
      {issue.subIssues.map((s) => {
        const st = ws.stateById.get(s.stateId);
        const assignee = s.assigneeId ? ws.memberById.get(s.assigneeId) : null;
        return (
          <div
            key={s.id}
            className="row flex h-9 items-center gap-2.5 border-b border-border-soft/60 px-2"
          >
            <StatusProp
              issue={s}
              onPatch={(pp) => update.mutate({ id: s.id, patch: pp })}
              variant="icon"
            />
            <span className="w-16 flex-none font-mono text-[11px] text-index">{s.identifier}</span>
            <Link
              to="/$slug/issue/$identifier"
              params={{ slug: ws.slug, identifier: s.identifier }}
              className="min-w-0 flex-1 truncate text-[13.5px]"
            >
              {s.title}
            </Link>
            {st?.type === 'completed' && (
              <span className="chip [--chip:var(--color-success)]">{t('common.done')}</span>
            )}
            {assignee && (
              <Avatar
                name={assignee.name}
                color={assignee.avatarColor}
                src={assignee.avatarUrl}
                size={16}
                status={assignee.status}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}
