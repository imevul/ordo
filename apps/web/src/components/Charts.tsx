import { useLayoutEffect, useRef, useState } from 'react';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';

/**
 * Small SVG charts in Hotline Pink: square ends, 2px lines, a recessive grid, text in text tokens
 * (never the series color), a legend for two or more series, and a hover readout. Series colors
 * are CSS colors; the accent plus `--color-chart-2` were checked for color-blind separation.
 */

export interface Series {
  key: string;
  label: string;
  color: string;
  /** Second encoding besides color, for the context series. */
  dashed?: boolean;
  /** Null where the series has no value (a forecast before today, an ideal past its target). */
  values: (number | null)[];
}

/** Runs of consecutive values as SVG points, so a line breaks where a value is missing. */
function segments(values: (number | null)[], px: (i: number) => number, py: (v: number) => number) {
  const out: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) out.push(run.join(' '));
      run = [];
    } else run.push(`${px(i)},${py(v)}`);
  });
  if (run.length) out.push(run.join(' '));
  return out;
}

/** Whole numbers as they are, others with one decimal, in the reader's language. */
const fmt = (n: number) => {
  const digits = Number.isInteger(n) ? 0 : 1;
  return n.toLocaleString(INTL_TAG[getLocale()], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(INTL_TAG[getLocale()], {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** A rounder maximum for the y axis: 1, 2, 5, 10, 20, 50… */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-4 font-mono text-[11px] text-muted">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <svg width="16" height="6" aria-hidden>
            <line
              x1="0"
              y1="3"
              x2="16"
              y2="3"
              stroke={s.color}
              strokeWidth="2"
              strokeDasharray={s.dashed ? '4 3' : undefined}
            />
          </svg>
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Lines over days or weeks (`x` are ISO dates), sharing one y axis. */
export function LineChart({
  series,
  x,
  height = 180,
  label,
  marker,
}: {
  series: Series[];
  x: string[];
  height?: number;
  label: string;
  /** A labelled vertical line on one day (a target date). */
  marker?: { day: string; label: string };
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 8, right: 16, bottom: 22, left: 34 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const px = (i: number) => m.left + (x.length > 1 ? (i / (x.length - 1)) * w : w / 2);
  const py = (v: number) => m.top + h - (v / max) * h;
  const ticks = max >= 2 ? [0, max / 2, max] : [0, max];
  const step = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(w / 72))));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(x.length - 1, Math.round(rel * (x.length - 1)))));
  };

  return (
    <figure className="relative">
      <Legend series={series} />
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label={label}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={m.left}
                x2={m.left + w}
                y1={py(tick)}
                y2={py(tick)}
                stroke="var(--color-border-soft)"
                strokeWidth="1"
              />
              <text
                x={m.left - 6}
                y={py(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-index font-mono text-[10px]"
              >
                {fmt(tick)}
              </text>
            </g>
          ))}
          {x.map((d, i) =>
            (i % step === 0 && px(x.length - 1) - px(i) >= 56) || i === x.length - 1 ? (
              <text
                key={d}
                x={px(i)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === x.length - 1 ? 'end' : 'middle'}
                className="fill-index font-mono text-[10px]"
              >
                {shortDay(d)}
              </text>
            ) : null,
          )}
          {series.flatMap((s) =>
            segments(s.values, px, py).map((points, k) => (
              <polyline
                key={`${s.key}:${k}`}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeDasharray={s.dashed ? '5 4' : undefined}
                points={points}
              />
            )),
          )}
          {marker && x.includes(marker.day) && (
            <g>
              <line
                x1={px(x.indexOf(marker.day))}
                x2={px(x.indexOf(marker.day))}
                y1={m.top}
                y2={m.top + h}
                stroke="var(--color-index)"
                strokeWidth="1"
                strokeDasharray="2 3"
              />
              <text
                x={px(x.indexOf(marker.day)) - 4}
                y={m.top + 8}
                textAnchor="end"
                className="fill-index font-mono text-[10px]"
              >
                {marker.label}
              </text>
            </g>
          )}
          {hover !== null && (
            <g>
              <line
                x1={px(hover)}
                x2={px(hover)}
                y1={m.top}
                y2={m.top + h}
                stroke="var(--color-border)"
                strokeWidth="1"
              />
              {series.map((s) =>
                s.values[hover] == null ? null : (
                  <rect
                    key={s.key}
                    x={px(hover) - 4}
                    y={py(s.values[hover]!) - 4}
                    width="8"
                    height="8"
                    fill={s.color}
                    stroke="var(--color-bg)"
                    strokeWidth="2"
                  />
                ),
              )}
            </g>
          )}
          <rect
            x={m.left}
            y={m.top}
            width={w}
            height={h}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null && (
          <div
            className="panel panel-sm panel-raised pointer-events-none absolute z-10 px-2.5 py-1.5 font-mono text-[11px]"
            style={{
              left: Math.min(px(hover) + 10, width - 150),
              top: m.top,
            }}
          >
            <div className="mb-1 text-index">{shortDay(x[hover]!)}</div>
            {series.map((s) =>
              s.values[hover] == null ? null : (
                <div key={s.key} className="flex items-center gap-2 text-muted">
                  <span className="h-0.5 w-3" style={{ background: s.color }} />
                  {s.label}
                  <span className="ml-auto pl-3 text-text">{fmt(s.values[hover]!)}</span>
                </div>
              ),
            )}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>{t('insights.chart.date')}</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {x.map((d, i) => (
            <tr key={d}>
              <td>{d}</td>
              {series.map((s) => (
                <td key={s.key}>{s.values[i] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export interface Band {
  key: string;
  label: string;
  /** A fill; bands are told apart by order, legend and readout too. */
  color: string;
  values: number[];
}

function SwatchLegend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
      {items.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2" style={{ background: s.color }} aria-hidden />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Readout({
  title,
  rows,
  left,
}: {
  title: string;
  rows: { key: string; label: string; color: string; value: number }[];
  left: number;
}) {
  return (
    <div
      className="panel panel-sm panel-raised pointer-events-none absolute top-2 z-10 px-2.5 py-1.5 font-mono text-[11px]"
      style={{ left }}
    >
      <div className="mb-1 text-index">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-muted">
          <span className="h-2 w-2" style={{ background: r.color }} />
          {r.label}
          <span className="ml-auto pl-3 text-text">{fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function YGrid({
  max,
  m,
  w,
  py,
}: {
  max: number;
  m: { left: number };
  w: number;
  py: (v: number) => number;
}) {
  return (
    <>
      {(max >= 2 ? [0, max / 2, max] : [0, max]).map((tick) => (
        <g key={tick}>
          <line
            x1={m.left}
            x2={m.left + w}
            y1={py(tick)}
            y2={py(tick)}
            stroke="var(--color-border-soft)"
            strokeWidth="1"
          />
          <text
            x={m.left - 6}
            y={py(tick)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-index font-mono text-[10px]"
          >
            {fmt(tick)}
          </text>
        </g>
      ))}
    </>
  );
}

function DataTable({
  label,
  head,
  x,
  bands,
}: {
  label: string;
  head: string;
  x: string[];
  bands: { key: string; label: string; values: (number | null)[] }[];
}) {
  return (
    <table className="sr-only">
      <caption>{label}</caption>
      <thead>
        <tr>
          <th>{head}</th>
          {bands.map((b) => (
            <th key={b.key}>{b.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {x.map((d, i) => (
          <tr key={d}>
            <td>{d}</td>
            {bands.map((b) => (
              <td key={b.key}>{b.values[i] ?? ''}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Bands stacked over days (first band at the bottom): a cumulative flow. */
export function StackedAreaChart({
  bands,
  x,
  height = 180,
  label,
}: {
  bands: Band[];
  x: string[];
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 8, right: 16, bottom: 22, left: 34 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const tops = x.map((_, i) => {
    let acc = 0;
    return bands.map((b) => (acc += b.values[i] ?? 0));
  });
  const max = niceMax(Math.max(0, ...tops.map((t) => t.at(-1) ?? 0)));
  const px = (i: number) => m.left + (x.length > 1 ? (i / (x.length - 1)) * w : w / 2);
  const py = (v: number) => m.top + h - (v / max) * h;
  const step = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(w / 72))));
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(x.length - 1, Math.round(rel * (x.length - 1)))));
  };
  return (
    <figure className="relative">
      <SwatchLegend items={[...bands].reverse()} />
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label={label}>
          <YGrid max={max} m={m} w={w} py={py} />
          {bands.map((b, k) => {
            const top = x.map((_, i) => `${px(i)},${py(tops[i]![k]!)}`);
            const bottom = x.map((_, i) => `${px(i)},${py(k ? tops[i]![k - 1]! : 0)}`).reverse();
            return (
              <polygon
                key={b.key}
                points={[...top, ...bottom].join(' ')}
                fill={b.color}
                stroke="var(--color-bg)"
                strokeWidth="1"
              />
            );
          })}
          {x.map((d, i) =>
            (i % step === 0 && px(x.length - 1) - px(i) >= 56) || i === x.length - 1 ? (
              <text
                key={d}
                x={px(i)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === x.length - 1 ? 'end' : 'middle'}
                className="fill-index font-mono text-[10px]"
              >
                {shortDay(d)}
              </text>
            ) : null,
          )}
          {hover !== null && (
            <line
              x1={px(hover)}
              x2={px(hover)}
              y1={m.top}
              y2={m.top + h}
              stroke="var(--color-text)"
              strokeWidth="1"
            />
          )}
          <rect
            x={m.left}
            y={m.top}
            width={w}
            height={h}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null && (
          <Readout
            title={shortDay(x[hover]!)}
            left={Math.min(px(hover) + 10, width - 160)}
            rows={[...bands].reverse().map((b) => ({ ...b, value: b.values[hover] ?? 0 }))}
          />
        )}
      </div>
      <DataTable label={label} head={t('insights.chart.date')} x={x} bands={bands} />
    </figure>
  );
}

/**
 * Columns per category (cycles), two series side by side, and an optional dashed reference line
 * (an average) across them.
 */
export function ColumnChart({
  x,
  series,
  reference,
  height = 180,
  label,
}: {
  /** Category labels. */
  x: string[];
  series: Band[];
  reference?: { label: string; value: number };
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 8, right: 16, bottom: 22, left: 34 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const max = niceMax(Math.max(0, reference?.value ?? 0, ...series.flatMap((s) => s.values)));
  const py = (v: number) => m.top + h - (v / max) * h;
  const slot = w / Math.max(1, x.length);
  const bar = Math.max(2, Math.min(18, (slot * 0.7) / series.length));
  const left = (i: number) => m.left + i * slot + (slot - bar * series.length) / 2;
  return (
    <figure className="relative">
      <SwatchLegend items={series} />
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label={label}>
          <YGrid max={max} m={m} w={w} py={py} />
          {x.map((c, i) => (
            <g key={c}>
              {series.map((s, k) => (
                <rect
                  key={s.key}
                  x={left(i) + k * bar}
                  y={py(s.values[i] ?? 0)}
                  width={bar - 1}
                  height={m.top + h - py(s.values[i] ?? 0)}
                  fill={s.color}
                  opacity={hover === null || hover === i ? 1 : 0.6}
                />
              ))}
              <text
                x={m.left + i * slot + slot / 2}
                y={height - 6}
                textAnchor="middle"
                className="fill-index font-mono text-[10px]"
              >
                {c}
              </text>
              <rect
                x={m.left + i * slot}
                y={m.top}
                width={slot}
                height={h}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
            </g>
          ))}
          {reference && (
            <g className="pointer-events-none">
              <line
                x1={m.left}
                x2={m.left + w}
                y1={py(reference.value)}
                y2={py(reference.value)}
                stroke="var(--color-text)"
                strokeWidth="1"
                strokeDasharray="5 4"
              />
              <text
                x={m.left + w}
                y={py(reference.value) - 4}
                textAnchor="end"
                className="fill-muted font-mono text-[10px]"
              >
                {reference.label}
              </text>
            </g>
          )}
        </svg>
        {hover !== null && (
          <Readout
            title={x[hover]!}
            left={Math.min(m.left + (hover + 1) * slot, width - 160)}
            rows={series.map((s) => ({ ...s, value: s.values[hover] ?? 0 }))}
          />
        )}
      </div>
      <DataTable label={label} head={t('insights.chart.cycle')} x={x} bands={series} />
    </figure>
  );
}

/** Horizontal bars with their labels and values: a breakdown that reads as a table too. */
export function BarList({
  bars,
  total,
  format = fmt,
}: {
  bars: { key: string; label: string; value: number }[];
  total?: number;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const sum = total ?? bars.reduce((a, b) => a + b.value, 0);
  return (
    <ul className="flex flex-col gap-0.5">
      {bars.map((b) => (
        <li
          key={b.key}
          className="group grid grid-cols-[minmax(0,9rem)_1fr_3.5rem] items-center gap-2 py-0.5"
          title={
            sum
              ? t('insights.chart.barShare', {
                  label: b.label,
                  value: format(b.value),
                  percent: Math.round((b.value / sum) * 100),
                })
              : t('insights.chart.bar', { label: b.label, value: format(b.value) })
          }
        >
          <span className="truncate text-[12.5px] text-muted group-hover:text-text">{b.label}</span>
          <span className="h-3.5 bg-border-soft/40">
            <span
              className="block h-full bg-primary opacity-80 group-hover:opacity-100"
              style={{ width: `${(b.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right font-mono text-[11.5px] text-text">{format(b.value)}</span>
        </li>
      ))}
    </ul>
  );
}
