import { useLayoutEffect, useRef, useState } from 'react';

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
  values: number[];
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
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
}: {
  series: Series[];
  x: string[];
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 8, right: 16, bottom: 22, left: 34 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
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
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={m.left}
                x2={m.left + w}
                y1={py(t)}
                y2={py(t)}
                stroke="var(--color-border-soft)"
                strokeWidth="1"
              />
              <text
                x={m.left - 6}
                y={py(t)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-index font-mono text-[10px]"
              >
                {fmt(t)}
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
          {series.map((s) => (
            <polyline
              key={s.key}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeDasharray={s.dashed ? '5 4' : undefined}
              points={s.values.map((v, i) => `${px(i)},${py(v)}`).join(' ')}
            />
          ))}
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
              {series.map((s) => (
                <rect
                  key={s.key}
                  x={px(hover) - 4}
                  y={py(s.values[hover] ?? 0) - 4}
                  width="8"
                  height="8"
                  fill={s.color}
                  stroke="var(--color-bg)"
                  strokeWidth="2"
                />
              ))}
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
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-muted">
                <span className="h-0.5 w-3" style={{ background: s.color }} />
                {s.label}
                <span className="ml-auto pl-3 text-text">{fmt(s.values[hover] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>Date</th>
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
                <td key={s.key}>{s.values[i]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
          title={`${b.label}: ${format(b.value)}${sum ? ` (${Math.round((b.value / sum) * 100)}%)` : ''}`}
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
