import type { DashboardWidget, IssueFilter } from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import {
  useAgentActivity,
  useInsightsTimeline,
  useIssues,
  useVelocity,
} from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';
import { timelineScope } from '../../lib/dashboards.ts';
import { usd } from '../../lib/format.ts';
import { breakdown, weeklyFlow } from '../../lib/insights.ts';
import { sortIssues, visibleIssues } from '../../lib/issues.ts';
import { useWorkspace, type WorkspaceData } from '../../lib/workspace.tsx';
import { BarList, LineChart } from '../Charts.tsx';
import { StatusIcon } from '../icons.tsx';
import {
  BurndownChart,
  BurnUpChart,
  CumulativeFlowChart,
  hasPoints,
  VelocityChart,
} from '../TimelineCharts.tsx';

/** One grid row and the gap between rows, in pixels. */
export const ROW_PX = 240;
export const GAP_PX = 12;
/** What a chart's plot gets of its rows: less the padding, the title and the chart's legend. */
const chartHeight = (w: DashboardWidget) => w.h * ROW_PX + (w.h - 1) * GAP_PX - 108;

type Of<T extends DashboardWidget['type']> = Extract<DashboardWidget, { type: T }>;

/** What a widget is called when it wasn't given a title. */
export function widgetTitle(ws: WorkspaceData, w: DashboardWidget): string {
  if (w.title) return w.title;
  switch (w.type) {
    case 'count':
      return w.measure === 'estimate'
        ? t('dashboards.widget.points')
        : t('dashboards.widget.issues');
    case 'view':
      return ws.viewById.get(w.viewId)?.name ?? t('dashboards.widget.viewGone');
    case 'agents':
      return t('dashboards.widget.agentsTitle', { count: w.days });
    case 'chart': {
      const scope = w.projectId
        ? ws.projectById.get(w.projectId)?.name
        : w.teamId
          ? ws.teamById.get(w.teamId)?.name
          : undefined;
      const name =
        w.chart === 'breakdown'
          ? t('dashboards.widget.breakdownBy', {
              slice: t(`insights.breakdown.slice.${w.slice ?? 'state'}`),
            })
          : w.chart === 'flow'
            ? t('dashboards.widget.flow')
            : t(`insights.${w.chart}.title`);
      if (w.currentCycle && scope) return t('dashboards.widget.currentCycleOf', { name, scope });
      return scope ? t('dashboards.widget.chartOf', { name, scope }) : name;
    }
  }
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[12px] text-index">{children}</p>;
}

function Loading() {
  return <Note>{t('dashboards.widget.loading')}</Note>;
}

function CountWidget({ widget }: { widget: Of<'count'> }) {
  const ws = useWorkspace();
  const { data, isLoading } = useIssues(ws.slug, widget.filters);
  if (isLoading || !data) return <Loading />;
  const value =
    widget.measure === 'estimate' ? data.reduce((a, i) => a + (i.estimate ?? 0), 0) : data.length;
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="font-mono text-[44px] leading-none font-semibold tracking-[-0.02em] text-text">
        {value.toLocaleString()}
      </div>
      <div className="kicker mt-2 text-[10.5px] tracking-[0.14em] uppercase">
        {widget.measure === 'estimate'
          ? t('dashboards.widget.points')
          : t('dashboards.widget.issues')}
      </div>
    </div>
  );
}

function ViewWidget({ widget }: { widget: Of<'view'> }) {
  const ws = useWorkspace();
  const view = ws.viewById.get(widget.viewId);
  const filter = useMemo<IssueFilter>(
    () => (view ? { ...view.filters, ...(view.teamId ? { teamId: view.teamId } : {}) } : {}),
    [view],
  );
  const { data, isLoading } = useIssues(ws.slug, filter, !!view);
  if (!view) return <Note>{t('dashboards.widget.viewGoneBody')}</Note>;
  if (isLoading || !data) return <Loading />;
  const shown = sortIssues(visibleIssues(ws, data, view.display), view.display.orderBy);
  const more = shown.length - widget.limit;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {shown.length === 0 ? (
        <Note>{t('dashboards.widget.viewEmpty')}</Note>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {shown.slice(0, widget.limit).map((i) => {
            const state = ws.stateById.get(i.stateId);
            return (
              <li key={i.id}>
                <Link
                  to="/$slug/issue/$identifier"
                  params={{ slug: ws.slug, identifier: i.identifier }}
                  className="row flex h-8 items-center gap-2 border-b border-border-soft/60 px-1"
                >
                  {state && <StatusIcon type={state.type} color={state.color} size={13} />}
                  <span className="w-16 flex-none font-mono text-[11px] text-index">
                    {i.identifier}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{i.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link
        to="/$slug/view/$viewId"
        params={{ slug: ws.slug, viewId: view.id }}
        className="mt-2 flex-none font-mono text-[11px] text-muted hover:text-text"
      >
        {more > 0
          ? t('dashboards.widget.viewMore', { count: more })
          : t('dashboards.widget.openView')}{' '}
        <span className="arrow">→</span>
      </Link>
    </div>
  );
}

function AgentsWidget({ widget }: { widget: Of<'agents'> }) {
  const ws = useWorkspace();
  const { data, isLoading } = useAgentActivity(ws.slug, {
    days: widget.days,
    agentId: widget.agentId,
    teamId: widget.teamId,
  });
  if (isLoading || !data) return <Loading />;
  if (data.agents.length === 0)
    return <Note>{t('dashboards.widget.agentsNone', { count: widget.days })}</Note>;
  const total = data.agents.reduce((a, r) => a + r.costUsd, 0);
  const cell = 'px-1.5 py-1 text-right font-mono text-[12px]';
  return (
    <div className="min-h-0 overflow-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="kicker text-[10px] tracking-[0.12em] uppercase">
            <th className="px-1.5 py-1 text-left font-normal">{t('dashboards.widget.agent')}</th>
            <th className={`${cell} font-normal`}>{t('dashboards.widget.runs')}</th>
            <th className={`${cell} font-normal`}>{t('dashboards.widget.succeeded')}</th>
            <th className={`${cell} font-normal`}>{t('dashboards.widget.failed')}</th>
            <th className={`${cell} font-normal`}>{t('dashboards.widget.open')}</th>
            <th className={`${cell} font-normal`}>{t('dashboards.widget.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {data.agents.map((a) => (
            <tr key={a.agentId} className="border-t border-border-soft/60">
              <td className="max-w-0 truncate px-1.5 py-1 text-[13px]">
                {ws.memberById.get(a.agentId)?.name ?? t('dashboards.widget.unknownAgent')}
              </td>
              <td className={cell}>{a.runs}</td>
              <td className={cell}>{a.succeeded}</td>
              <td className={`${cell} ${a.failed ? 'text-error' : ''}`}>{a.failed}</td>
              <td className={cell}>{a.open}</td>
              <td className={cell}>{usd(a.costUsd)}</td>
            </tr>
          ))}
        </tbody>
        {data.agents.length > 1 && (
          <tfoot>
            <tr className="border-t border-border-soft">
              <td className="px-1.5 py-1 text-[12px] text-muted">{t('dashboards.widget.total')}</td>
              <td colSpan={4} />
              <td className={`${cell} font-semibold`}>{usd(total)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Breakdown and created-vs-completed, over the issues the widget's filter matches. */
function IssueChart({ widget }: { widget: Of<'chart'> }) {
  const ws = useWorkspace();
  const { data, isLoading } = useIssues(ws.slug, widget.filters ?? {});
  const m = widget.measure;
  const bars = useMemo(
    () =>
      data && widget.chart === 'breakdown' ? breakdown(ws, data, widget.slice ?? 'state', m) : [],
    [ws, data, widget.chart, widget.slice, m],
  );
  const flow = useMemo(
    () => (data && widget.chart === 'flow' ? weeklyFlow(data, m, widget.weeks ?? 12) : []),
    [data, widget.chart, widget.weeks, m],
  );
  if (isLoading || !data) return <Loading />;
  if (widget.chart === 'breakdown') {
    // As many bars as the rows leave room for.
    const fits = Math.max(3, Math.floor(chartHeight(widget) / 22));
    return bars.length ? (
      <BarList bars={bars.slice(0, fits)} />
    ) : (
      <Note>{t('insights.breakdown.empty')}</Note>
    );
  }
  return (
    <LineChart
      label={
        m === 'count'
          ? t('dashboards.widget.flowLabelIssues')
          : t('dashboards.widget.flowLabelPoints')
      }
      x={flow.map((p) => p.start)}
      height={chartHeight(widget)}
      series={[
        {
          key: 'created',
          label: t('insights.flow.created'),
          color: 'var(--color-chart-2)',
          dashed: true,
          values: flow.map((p) => p.created),
        },
        {
          key: 'completed',
          label: t('insights.flow.completed'),
          color: 'var(--color-primary)',
          values: flow.map((p) => p.completed),
        },
      ]}
    />
  );
}

function TimelineChart({ widget }: { widget: Of<'chart'> }) {
  const ws = useWorkspace();
  const scope = useMemo(() => timelineScope(widget, ws.cycles), [widget, ws.cycles]);
  const { data, isLoading } = useInsightsTimeline(ws.slug, scope ?? {}, !!scope);
  if (!scope) return <Note>{t('dashboards.widget.noCycle')}</Note>;
  if (isLoading || !data) return <Loading />;
  // Points only mean something when something was estimated.
  const m = hasPoints(data.days) ? widget.measure : 'count';
  const height = chartHeight(widget);
  if (widget.chart === 'burndown') {
    const project = widget.projectId ? ws.projectById.get(widget.projectId) : undefined;
    return (
      <BurndownChart
        days={data.days}
        measure={m}
        target={project?.targetDate ?? null}
        height={height - 20}
      />
    );
  }
  if (widget.chart === 'cumulativeFlow')
    return <CumulativeFlowChart days={data.days} measure={m} height={height} />;
  return <BurnUpChart days={data.days} measure={m} height={height} />;
}

function VelocityWidget({ widget }: { widget: Of<'chart'> }) {
  const ws = useWorkspace();
  const { data, isLoading } = useVelocity(ws.slug, widget.teamId ?? undefined);
  if (isLoading || !data) return <Loading />;
  // Less the line under it with the average.
  return (
    <VelocityChart velocity={data} measure={widget.measure} height={chartHeight(widget) - 20} />
  );
}

export function WidgetBody({ widget }: { widget: DashboardWidget }) {
  switch (widget.type) {
    case 'count':
      return <CountWidget widget={widget} />;
    case 'view':
      return <ViewWidget widget={widget} />;
    case 'agents':
      return <AgentsWidget widget={widget} />;
    case 'chart':
      if (widget.chart === 'velocity') return <VelocityWidget widget={widget} />;
      if (widget.chart === 'breakdown' || widget.chart === 'flow')
        return <IssueChart widget={widget} />;
      return <TimelineChart widget={widget} />;
  }
}
