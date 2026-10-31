import type { Project } from '@ordo/shared';
import { useMemo } from 'react';
import { useIssues } from '../../api/queries.ts';
import { LineChart } from '../../components/Charts.tsx';
import { t } from '../../i18n/index.ts';
import { burnUp, isoDay } from '../../lib/insights.ts';
import { useWorkspace } from '../../lib/workspace.tsx';

/** Scope and completed work since the project started (or its first issue), day by day. */
export function ProjectProgressChart({ project }: { project: Project }) {
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
