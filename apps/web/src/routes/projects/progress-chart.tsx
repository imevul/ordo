import type { Project } from '@ordo/shared';
import { useState } from 'react';
import { useInsightsTimeline } from '../../api/queries.ts';
import {
  BurndownChart,
  CumulativeFlowChart,
  hasPoints,
  MeasureSelect,
  useMeasure,
} from '../../components/TimelineCharts.tsx';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';

/**
 * The project day by day since it started (or since its first issue), from issue history: work
 * left against the target date with a forecast, and how it moved through the workflow.
 */
export function ProjectProgressChart({ project }: { project: Project }) {
  const ws = useWorkspace();
  const { data } = useInsightsTimeline(ws.slug, { projectId: project.id });
  const [flow, setFlow] = useState(false);
  const points = hasPoints(data?.days);
  const [measure, setMeasure] = useMeasure(points);
  if (!data || data.days.length < 2) return null;
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <div className="section-label flex-1">{t('projects.chart.title')}</div>
        <div className="flex" role="group">
          {(
            [
              [false, t('insights.burndown.title')],
              [true, t('insights.cumulativeFlow.title')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={flow === value}
              className={`btn btn-ghost btn-sm ${flow === value ? 'text-primary' : ''}`}
              onClick={() => setFlow(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {points && <MeasureSelect value={measure} onChange={setMeasure} />}
      </div>
      {flow ? (
        <CumulativeFlowChart days={data.days} measure={measure} height={180} />
      ) : (
        <BurndownChart
          days={data.days}
          measure={measure}
          target={project.targetDate}
          height={180}
        />
      )}
    </div>
  );
}
