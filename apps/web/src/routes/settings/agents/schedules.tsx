import { Link } from '@tanstack/react-router';
import { Repeat } from 'lucide-react';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';

/**
 * The recurring issues assigned to an agent: each occurrence queues it a run. They're managed
 * with their templates, so this only lists them.
 */
export function AgentSchedules({ agentId }: { agentId: string }) {
  const ws = useWorkspace();
  const templates = new Map(ws.templates.map((tpl) => [tpl.id, tpl]));
  const schedules = ws.recurring.filter((r) => templates.get(r.templateId)?.assigneeId === agentId);
  if (schedules.length === 0) return null;
  return (
    <div className="mt-2 ml-[34px]">
      {schedules.map((s) => {
        const template = templates.get(s.templateId)!;
        const cadence = t(`templates.cadence.${s.unit}`, { count: s.every });
        const team = ws.teamById.get(s.teamId)?.key ?? '?';
        return (
          <div key={s.id} className="flex items-center gap-2 py-0.5 text-[12px]">
            <Repeat size={11} className={`flex-none ${s.paused ? 'text-index' : 'text-primary'}`} />
            <span className="min-w-0 flex-1">
              {template.name}{' '}
              <span className="font-mono text-index">
                {s.paused
                  ? t('templates.schedule.paused', { cadence, team })
                  : t('templates.schedule.next', { cadence, team, date: s.nextOn })}
              </span>
            </span>
            <Link
              to="/$slug/settings/$section"
              params={{ slug: ws.slug, section: 'templates' }}
              className="btn btn-ghost btn-sm flex-none"
            >
              {t('agents.schedules.manage')}
            </Link>
          </div>
        );
      })}
    </div>
  );
}
