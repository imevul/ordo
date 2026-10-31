import type { Issue } from '@ordo/shared';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useInsightsTimeline } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import {
  breakdown,
  burnUp,
  durations,
  formatDays,
  type Measure,
  SLICES,
  type Slice,
  timelineBurnUp,
  weeklyFlow,
} from '../lib/insights.ts';
import { readPref, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { BarList, LineChart } from './Charts.tsx';

const QUARTER = 90 * 86_400_000;

/**
 * Charts over the issues a view shows: a burn-up for a time box (cycles), otherwise created vs
 * completed per week; a breakdown by any property; and how long finished work took.
 */
export function InsightsPanel({
  issues,
  burn,
  filtered = false,
  onClose,
}: {
  issues: Issue[];
  /** Plot scope and completed work across these days instead of weekly flow. */
  burn?: { from: string; to: string; cycleId?: string };
  /** The person narrowed the view: a burn-up can only count the issues it shows, as they are. */
  filtered?: boolean;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const [measure, setMeasure] = useState<Measure>(() => readPref('insightsMeasure', 'count'));
  const [slice, setSlice] = useState<Slice>(() => readPref('insightsSlice', 'state'));
  const hasEstimates = issues.some((i) => i.estimate != null);
  const m: Measure = hasEstimates ? measure : 'count';

  // A whole cycle's burn-up comes from history, so work added late or moved out counts right.
  const fromHistory = !!burn?.cycleId && !filtered;
  const timeline = useInsightsTimeline(ws.slug, { cycleId: burn?.cycleId }, fromHistory);
  const bars = useMemo(() => breakdown(ws, issues, slice, m), [ws, issues, slice, m]);
  const flow = useMemo(() => (burn ? null : weeklyFlow(issues, m)), [issues, m, burn]);
  const burned = useMemo(() => {
    if (!burn) return null;
    if (fromHistory) return timeline.data ? timelineBurnUp(timeline.data.days, m) : [];
    return burnUp(issues, m, burn.from, burn.to);
  }, [issues, m, burn, fromHistory, timeline.data]);
  const times = useMemo(() => durations(issues, Date.now() - QUARTER), [issues]);

  const select = 'input h-7 w-auto py-0 font-mono text-[11px]';
  return (
    <aside
      className="flex h-full w-[22rem] flex-none flex-col border-l border-border-soft bg-surface"
      aria-label={t('insights.title')}
    >
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
        <span className="section-label flex-1">{t('insights.title')}</span>
        {hasEstimates && (
          <select
            className={select}
            value={m}
            onChange={(e) => {
              setMeasure(e.target.value as Measure);
              writePref('insightsMeasure', e.target.value);
            }}
            aria-label={t('insights.measure')}
          >
            <option value="count">{t('insights.issues')}</option>
            <option value="estimate">{t('insights.points')}</option>
          </select>
        )}
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
          onClick={onClose}
          aria-label={t('insights.close')}
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {burned ? (
          <section>
            <h3 className="kicker mb-2 text-[11px] uppercase tracking-[0.14em]">
              {t('insights.burnUp.title')}
            </h3>
            {burned.length > 0 ? (
              <LineChart
                label={
                  m === 'count'
                    ? t('insights.burnUp.labelIssues')
                    : t('insights.burnUp.labelPoints')
                }
                x={burned.map((p) => p.day)}
                series={[
                  {
                    key: 'scope',
                    label: t('insights.burnUp.scope'),
                    color: 'var(--color-chart-2)',
                    dashed: true,
                    values: burned.map((p) => p.scope),
                  },
                  {
                    key: 'completed',
                    label: t('insights.burnUp.completed'),
                    color: 'var(--color-primary)',
                    values: burned.map((p) => p.completed),
                  },
                ]}
              />
            ) : fromHistory && timeline.isLoading ? null : (
              <p className="font-mono text-[12px] text-index">
                {t('insights.burnUp.starts', { date: burn!.from })}
              </p>
            )}
            {burn?.cycleId && filtered && burned.length > 0 && (
              <p className="mt-1 font-mono text-[10.5px] text-index">
                {t('insights.burnUpFiltered')}
              </p>
            )}
          </section>
        ) : (
          <section>
            <h3 className="kicker mb-2 text-[11px] uppercase tracking-[0.14em]">
              {t('insights.flow.title')}
            </h3>
            <LineChart
              label={
                m === 'count' ? t('insights.flow.labelIssues') : t('insights.flow.labelPoints')
              }
              x={flow!.map((p) => p.start)}
              series={[
                {
                  key: 'created',
                  label: t('insights.flow.created'),
                  color: 'var(--color-chart-2)',
                  dashed: true,
                  values: flow!.map((p) => p.created),
                },
                {
                  key: 'completed',
                  label: t('insights.flow.completed'),
                  color: 'var(--color-primary)',
                  values: flow!.map((p) => p.completed),
                },
              ]}
            />
          </section>
        )}

        <section className="mt-7">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="kicker flex-1 text-[11px] uppercase tracking-[0.14em]">
              {t('insights.breakdown.title')}
            </h3>
            <select
              className={select}
              value={slice}
              onChange={(e) => {
                setSlice(e.target.value as Slice);
                writePref('insightsSlice', e.target.value);
              }}
              aria-label={t('insights.breakdown.by')}
            >
              {SLICES.map((s) => (
                <option key={s} value={s}>
                  {t(`insights.breakdown.slice.${s}`)}
                </option>
              ))}
            </select>
          </div>
          {bars.length ? (
            <BarList bars={bars.slice(0, 12)} />
          ) : (
            <p className="font-mono text-[12px] text-index">{t('insights.breakdown.empty')}</p>
          )}
          {bars.length > 12 && (
            <p className="mt-1 font-mono text-[11px] text-index">
              {t('insights.breakdown.more', { count: bars.length - 12 })}
            </p>
          )}
        </section>

        <section className="mt-7">
          <h3 className="kicker mb-2 text-[11px] uppercase tracking-[0.14em]">
            {t('insights.durations.title')}
          </h3>
          {times.count === 0 ? (
            <p className="font-mono text-[12px] text-index">{t('insights.durations.empty')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-px bg-border-soft">
              {(
                [
                  [
                    'cycle',
                    t('insights.durations.cycleTime'),
                    times.cycle,
                    t('insights.durations.cycleTimeHint'),
                  ],
                  [
                    'lead',
                    t('insights.durations.leadTime'),
                    times.lead,
                    t('insights.durations.leadTimeHint'),
                  ],
                ] as const
              ).map(([id, name, stat, hint]) => (
                <div key={id} className="bg-surface px-3 py-2.5" title={hint}>
                  <div className="font-mono text-[10px] tracking-[0.16em] text-index uppercase">
                    {name}
                  </div>
                  <div className="mt-0.5 font-mono text-[18px] font-semibold text-text">
                    {stat ? formatDays(stat.median) : '—'}
                  </div>
                  {stat && (
                    <div className="font-mono text-[10.5px] text-index">
                      {t('insights.durations.p75', { value: formatDays(stat.p75) })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="mt-1.5 font-mono text-[10.5px] text-index">
            {t('insights.durations.completed', { count: times.count })}
          </p>
        </section>
      </div>
    </aside>
  );
}
