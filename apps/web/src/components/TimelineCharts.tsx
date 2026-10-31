import type { InsightsDay, Velocity } from '@ordo/shared';
import { useMemo, useState } from 'react';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';
import { stateTypeLabel } from '../i18n/labels.ts';
import { burndown, cumulativeFlow, type Measure, timelineBurnUp } from '../lib/insights.ts';
import { readPref, writePref } from '../lib/store.ts';
import { ColumnChart, LineChart, StackedAreaChart } from './Charts.tsx';

/**
 * Charts over a history timeline (`GET /insights/timeline`) or a team's cycles
 * (`GET /insights/velocity`): burn-up, burndown with a forecast, cumulative flow and velocity.
 */

const DAY = 86_400_000;
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(INTL_TAG[getLocale()], {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
const round1 = (n: number) => Math.round(n * 10) / 10;

export function ChartTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="kicker mb-2 text-[11px] uppercase tracking-[0.14em]">{children}</h3>;
}

/** Whether anything in the timeline was estimated, so points mean something. */
export const hasPoints = (days: InsightsDay[] | undefined) =>
  !!days?.some((d) => Object.values(d.points).some((v) => v > 0));

/** Issues or points, remembered like the insights panel's choice; points only when `points`. */
export function useMeasure(points: boolean) {
  const [measure, setMeasure] = useState<Measure>(() => readPref('insightsMeasure', 'count'));
  const set = (m: Measure) => {
    setMeasure(m);
    writePref('insightsMeasure', m);
  };
  return [points ? measure : 'count', set] as const;
}

export function MeasureSelect({
  value,
  onChange,
}: {
  value: Measure;
  onChange: (m: Measure) => void;
}) {
  return (
    <select
      className="input h-7 w-auto py-0 font-mono text-[11px]"
      value={value}
      onChange={(e) => onChange(e.target.value as Measure)}
      aria-label={t('insights.measure')}
    >
      <option value="count">{t('insights.issues')}</option>
      <option value="estimate">{t('insights.points')}</option>
    </select>
  );
}

export function BurnUpChart({
  days,
  measure,
  height,
}: {
  days: InsightsDay[];
  measure: Measure;
  height?: number;
}) {
  const points = useMemo(() => timelineBurnUp(days, measure), [days, measure]);
  return (
    <LineChart
      label={
        measure === 'count' ? t('insights.burnUp.labelIssues') : t('insights.burnUp.labelPoints')
      }
      x={points.map((p) => p.day)}
      height={height}
      series={[
        {
          key: 'scope',
          label: t('insights.burnUp.scope'),
          color: 'var(--color-chart-2)',
          dashed: true,
          values: points.map((p) => p.scope),
        },
        {
          key: 'completed',
          label: t('insights.burnUp.completed'),
          color: 'var(--color-primary)',
          values: points.map((p) => p.completed),
        },
      ]}
    />
  );
}

/** Work left per day, the ideal line to the target date, and when it's done at the recent pace. */
export function BurndownChart({
  days,
  measure,
  target,
  height,
}: {
  days: InsightsDay[];
  measure: Measure;
  target: string | null;
  height?: number;
}) {
  const b = useMemo(() => burndown(days, measure, target), [days, measure, target]);
  const verdict = () => {
    if (!b.forecastDate || !target) return null;
    const diff = Math.round((Date.parse(b.forecastDate) - Date.parse(target)) / DAY);
    if (diff > 0) return t('insights.burndown.late', { count: diff });
    if (diff < 0) return t('insights.burndown.early', { count: -diff });
    return t('insights.burndown.onTarget');
  };
  const late = !!(b.forecastDate && target && b.forecastDate > target);
  return (
    <>
      <LineChart
        label={
          measure === 'count'
            ? t('insights.burndown.labelIssues')
            : t('insights.burndown.labelPoints')
        }
        x={b.x}
        height={height}
        marker={target ? { day: target, label: t('insights.burndown.target') } : undefined}
        series={[
          {
            key: 'ideal',
            label: t('insights.burndown.ideal'),
            color: 'var(--color-index)',
            dashed: true,
            values: b.ideal,
          },
          {
            key: 'forecast',
            label: t('insights.burndown.forecast'),
            color: 'var(--color-chart-2)',
            dashed: true,
            values: b.forecast,
          },
          {
            key: 'remaining',
            label: t('insights.burndown.remaining'),
            color: 'var(--color-primary)',
            values: b.remaining,
          },
        ]}
      />
      <p className="mt-1.5 font-mono text-[11px] text-index">
        {b.done ? (
          t('insights.burndown.done')
        ) : b.forecastDate ? (
          <>
            <span className="text-text">
              {t('insights.burndown.forecastOn', { date: shortDate(b.forecastDate) })}
            </span>
            {verdict() && (
              <span className={late ? 'text-warning' : 'text-success'}> · {verdict()}</span>
            )}
            {' · '}
            {measure === 'count'
              ? t('insights.burndown.rateIssues', { rate: round1(b.rate * 7) })
              : t('insights.burndown.ratePoints', { rate: round1(b.rate * 7) })}
          </>
        ) : (
          t('insights.burndown.noForecast')
        )}
      </p>
    </>
  );
}

/** Fills bottom to top: completed in the accent, then lighter steps of the second chart color. */
const FLOW_COLORS: Record<string, string> = {
  completed: 'var(--color-primary)',
  started: 'var(--color-chart-2)',
  unstarted: 'color-mix(in srgb, var(--color-chart-2) 45%, var(--color-bg))',
  backlog: 'color-mix(in srgb, var(--color-muted) 35%, var(--color-bg))',
  triage: 'color-mix(in srgb, var(--color-warning) 55%, var(--color-bg))',
};

export function CumulativeFlowChart({
  days,
  measure,
  height,
}: {
  days: InsightsDay[];
  measure: Measure;
  height?: number;
}) {
  // Triage only gets a band when something was in it.
  const bands = useMemo(
    () =>
      cumulativeFlow(days, measure)
        .filter((f) => f.type !== 'triage' || f.values.some((v) => v > 0))
        .map((f) => ({
          key: f.type,
          label: stateTypeLabel(f.type),
          color: FLOW_COLORS[f.type]!,
          values: f.values,
        })),
    [days, measure],
  );
  return (
    <StackedAreaChart
      label={
        measure === 'count'
          ? t('insights.cumulativeFlow.labelIssues')
          : t('insights.cumulativeFlow.labelPoints')
      }
      x={days.map((d) => d.day)}
      height={height}
      bands={bands}
    />
  );
}

/** Committed and completed per cycle, with the average of the finished ones. */
export function VelocityChart({
  velocity,
  measure,
  height,
}: {
  velocity: Velocity;
  measure: Measure;
  height?: number;
}) {
  if (velocity.cycles.length === 0)
    return <p className="font-mono text-[12px] text-index">{t('insights.velocity.empty')}</p>;
  const key = measure === 'count' ? 'issues' : 'points';
  const finished = velocity.cycles.filter((c) => !c.current).length;
  const average = velocity.average?.[key];
  return (
    <>
      <ColumnChart
        label={
          measure === 'count'
            ? t('insights.velocity.labelIssues')
            : t('insights.velocity.labelPoints')
        }
        x={velocity.cycles.map((c) => c.name || t('insights.velocity.short', { number: c.number }))}
        height={height}
        series={[
          {
            key: 'committed',
            label: t('insights.velocity.committed'),
            color: 'var(--color-chart-2)',
            values: velocity.cycles.map((c) => c.committed[key]),
          },
          {
            key: 'completed',
            label: t('insights.velocity.completed'),
            color: 'var(--color-primary)',
            values: velocity.cycles.map((c) => c.completed[key]),
          },
        ]}
        reference={
          average != null
            ? { label: t('insights.velocity.average', { value: average }), value: average }
            : undefined
        }
      />
      {average != null && (
        <p className="mt-1.5 font-mono text-[11px] text-index">
          {measure === 'count'
            ? t('insights.velocity.summaryIssues', { count: finished, value: average })
            : t('insights.velocity.summaryPoints', { count: finished, value: average })}
        </p>
      )}
    </>
  );
}
