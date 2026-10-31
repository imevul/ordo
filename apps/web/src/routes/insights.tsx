import { useState } from 'react';
import { useInsightsTimeline, useVelocity } from '../api/queries.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import {
  BurndownChart,
  BurnUpChart,
  ChartTitle,
  CumulativeFlowChart,
  hasPoints,
  MeasureSelect,
  useMeasure,
  VelocityChart,
} from '../components/TimelineCharts.tsx';
import { t } from '../i18n/index.ts';
import { isoDay } from '../lib/insights.ts';
import { readPref, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';

const DAY = 86_400_000;
/** Weeks back; 0 is a project's whole life. */
const RANGES = [4, 12, 26, 52] as const;

/**
 * Charts across the workspace, one team or one project, rebuilt from issue history: burn-up and
 * cumulative flow for any of them, a burndown with forecast for a project, velocity for a team.
 */
export function InsightsPage() {
  const ws = useWorkspace();
  // "", "team:<id>" or "project:<id>"; anything no longer there falls back to the workspace.
  const [saved, setSaved] = useState(() => readPref('insightsPage:scope', ''));
  const [weeks, setWeeks] = useState(() => readPref('insightsPage:weeks', 12));
  const [kind, id] = saved.split(':') as ['team' | 'project' | '', string | undefined];
  const team = kind === 'team' && id ? ws.teamById.get(id) : undefined;
  const project = kind === 'project' && id ? ws.projectById.get(id) : undefined;
  const scope = team ? `team:${team.id}` : project ? `project:${project.id}` : '';
  // A project starts where it starts unless a range is picked; the rest show the range.
  const whole = !!project && weeks === 0;
  const from = whole ? undefined : isoDay(Date.now() - ((weeks || 12) * 7 - 1) * DAY);
  const { data, isLoading } = useInsightsTimeline(ws.slug, {
    teamId: team?.id,
    projectId: project?.id,
    from,
  });
  const velocity = useVelocity(ws.slug, team?.id);
  const points = hasPoints(data?.days);
  const [measure, setMeasure] = useMeasure(points);

  const select = 'input h-7 w-auto max-w-[14rem] py-0 font-mono text-[11px]';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader kicker={t('insights.page.kicker')} title={t('insights.page.title')}>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5">
          <select
            className={select}
            value={scope}
            onChange={(e) => {
              setSaved(e.target.value);
              writePref('insightsPage:scope', e.target.value);
            }}
            aria-label={t('insights.page.scope')}
          >
            <option value="">{t('insights.page.workspace')}</option>
            <optgroup label={t('insights.page.teams')}>
              {ws.teams.map((tm) => (
                <option key={tm.id} value={`team:${tm.id}`}>
                  {tm.name}
                </option>
              ))}
            </optgroup>
            {ws.projects.length > 0 && (
              <optgroup label={t('insights.page.projects')}>
                {ws.projects.map((p) => (
                  <option key={p.id} value={`project:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <select
            className={select}
            value={project ? weeks : weeks || 12}
            onChange={(e) => {
              setWeeks(Number(e.target.value));
              writePref('insightsPage:weeks', Number(e.target.value));
            }}
            aria-label={t('insights.page.range')}
          >
            {project && <option value={0}>{t('insights.page.sinceStart')}</option>}
            {RANGES.map((w) => (
              <option key={w} value={w}>
                {t('insights.page.weeks', { count: w })}
              </option>
            ))}
          </select>
          {points && <MeasureSelect value={measure} onChange={setMeasure} />}
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-9 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
          {!data ? (
            <p className="font-mono text-[12px] text-index">
              {isLoading ? t('insights.page.loading') : null}
            </p>
          ) : (
            <>
              <section className="lg:col-span-2">
                {project ? (
                  <>
                    <ChartTitle>{t('insights.burndown.title')}</ChartTitle>
                    <BurndownChart
                      days={data.days}
                      measure={measure}
                      target={project.targetDate}
                      height={220}
                    />
                  </>
                ) : (
                  <>
                    <ChartTitle>{t('insights.burnUp.title')}</ChartTitle>
                    <BurnUpChart days={data.days} measure={measure} height={220} />
                    <p className="mt-1.5 font-mono text-[10.5px] text-index">
                      {t('insights.page.burndownHint')}
                    </p>
                  </>
                )}
              </section>
              <section>
                <ChartTitle>{t('insights.cumulativeFlow.title')}</ChartTitle>
                <CumulativeFlowChart days={data.days} measure={measure} height={200} />
              </section>
              <section>
                <ChartTitle>{t('insights.velocity.title')}</ChartTitle>
                {team ? (
                  velocity.data && (
                    <VelocityChart velocity={velocity.data} measure={measure} height={200} />
                  )
                ) : (
                  <p className="font-mono text-[12px] text-index">
                    {t('insights.page.velocityHint')}
                  </p>
                )}
              </section>
              {project && (
                <section>
                  <ChartTitle>{t('insights.burnUp.title')}</ChartTitle>
                  <BurnUpChart days={data.days} measure={measure} height={200} />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
