import type { Issue } from '@ordo/shared';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  breakdown,
  burnUp,
  durations,
  formatDays,
  type Measure,
  SLICES,
  type Slice,
  weeklyFlow,
} from '../lib/insights.ts';
import { readPref, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { BarList, LineChart } from './Charts.tsx';

const SLICE_LABELS: Record<Slice, string> = {
  state: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  label: 'Label',
  project: 'Project',
  team: 'Team',
  cycle: 'Cycle',
};

const QUARTER = 90 * 86_400_000;

/**
 * Charts over the issues a view shows: a burn-up for a time box (cycles), otherwise created vs
 * completed per week; a breakdown by any property; and how long finished work took.
 */
export function InsightsPanel({
  issues,
  burn,
  onClose,
}: {
  issues: Issue[];
  /** Plot scope and completed work across these days instead of weekly flow. */
  burn?: { from: string; to: string };
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const [measure, setMeasure] = useState<Measure>(() => readPref('insightsMeasure', 'count'));
  const [slice, setSlice] = useState<Slice>(() => readPref('insightsSlice', 'state'));
  const hasEstimates = issues.some((i) => i.estimate != null);
  const m: Measure = hasEstimates ? measure : 'count';
  const unit = m === 'count' ? 'issues' : 'points';

  const bars = useMemo(() => breakdown(ws, issues, slice, m), [ws, issues, slice, m]);
  const flow = useMemo(() => (burn ? null : weeklyFlow(issues, m)), [issues, m, burn]);
  const burned = useMemo(
    () => (burn ? burnUp(issues, m, burn.from, burn.to) : null),
    [issues, m, burn],
  );
  const times = useMemo(() => durations(issues, Date.now() - QUARTER), [issues]);

  const select = 'input h-7 w-auto py-0 font-mono text-[11px]';
  return (
    <aside
      className="flex h-full w-[22rem] flex-none flex-col border-l border-border-soft bg-surface"
      aria-label="Insights"
    >
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
        <span className="section-label flex-1">Insights</span>
        {hasEstimates && (
          <select
            className={select}
            value={m}
            onChange={(e) => {
              setMeasure(e.target.value as Measure);
              writePref('insightsMeasure', e.target.value);
            }}
            aria-label="Measure"
          >
            <option value="count">Issues</option>
            <option value="estimate">Points</option>
          </select>
        )}
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
          onClick={onClose}
          aria-label="Close insights"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {burned ? (
          <section>
            <h3 className="kicker mb-2 text-[11px] uppercase tracking-[0.14em]">Burn-up</h3>
            {burned.length > 0 ? (
              <LineChart
                label={`Burn-up: scope and completed ${unit} per day`}
                x={burned.map((p) => p.day)}
                series={[
                  {
                    key: 'scope',
                    label: 'Scope',
                    color: 'var(--color-chart-2)',
                    dashed: true,
                    values: burned.map((p) => p.scope),
                  },
                  {
                    key: 'completed',
                    label: 'Completed',
                    color: 'var(--color-primary)',
                    values: burned.map((p) => p.completed),
                  },
                ]}
              />
            ) : (
              <p className="font-mono text-[12px] text-index">// starts {burn!.from}</p>
            )}
          </section>
        ) : (
          <section>
            <h3 className="kicker mb-2 text-[11px] uppercase tracking-[0.14em]">
              Created vs completed · 12 weeks
            </h3>
            <LineChart
              label={`${unit} created and completed per week, last 12 weeks`}
              x={flow!.map((p) => p.start)}
              series={[
                {
                  key: 'created',
                  label: 'Created',
                  color: 'var(--color-chart-2)',
                  dashed: true,
                  values: flow!.map((p) => p.created),
                },
                {
                  key: 'completed',
                  label: 'Completed',
                  color: 'var(--color-primary)',
                  values: flow!.map((p) => p.completed),
                },
              ]}
            />
          </section>
        )}

        <section className="mt-7">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="kicker flex-1 text-[11px] uppercase tracking-[0.14em]">Breakdown</h3>
            <select
              className={select}
              value={slice}
              onChange={(e) => {
                setSlice(e.target.value as Slice);
                writePref('insightsSlice', e.target.value);
              }}
              aria-label="Break down by"
            >
              {SLICES.map((s) => (
                <option key={s} value={s}>
                  by {SLICE_LABELS[s].toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          {bars.length ? (
            <BarList bars={bars.slice(0, 12)} />
          ) : (
            <p className="font-mono text-[12px] text-index">// nothing to count</p>
          )}
          {bars.length > 12 && (
            <p className="mt-1 font-mono text-[11px] text-index">+ {bars.length - 12} more</p>
          )}
        </section>

        <section className="mt-7">
          <h3 className="kicker mb-2 text-[11px] uppercase tracking-[0.14em]">
            Time to complete · 90 days
          </h3>
          {times.count === 0 ? (
            <p className="font-mono text-[12px] text-index">// nothing completed lately</p>
          ) : (
            <div className="grid grid-cols-2 gap-px bg-border-soft">
              {(
                [
                  ['cycle time', times.cycle, 'From started to done'],
                  ['lead time', times.lead, 'From created to done'],
                ] as const
              ).map(([name, stat, hint]) => (
                <div key={name} className="bg-surface px-3 py-2.5" title={hint}>
                  <div className="font-mono text-[10px] tracking-[0.16em] text-index uppercase">
                    {name}
                  </div>
                  <div className="mt-0.5 font-mono text-[18px] font-semibold text-text">
                    {stat ? formatDays(stat.median) : '—'}
                  </div>
                  {stat && (
                    <div className="font-mono text-[10.5px] text-index">
                      median · p75 {formatDays(stat.p75)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="mt-1.5 font-mono text-[10.5px] text-index">
            {times.count} issue{times.count === 1 ? '' : 's'} completed
          </p>
        </section>
      </div>
    </aside>
  );
}
