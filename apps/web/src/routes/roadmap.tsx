import type { Project } from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { ProjectIcon } from '../components/icons.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { readPref, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { InitiativeIcon } from './initiatives.tsx';

const DAY = 86_400_000;
const ZOOMS = { weeks: 14, months: 4, quarters: 1.6 } as const;
type Zoom = keyof typeof ZOOMS;
const NAME_WIDTH = 260;
const ROW = 36;

const toDay = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const todayDay = () => toDay(new Date().toISOString().slice(0, 10));

/** First day of each month in [from, to], for the axis. */
function months(from: number, to: number) {
  const out: { day: number; label: string; year: boolean }[] = [];
  const d = new Date(from * DAY);
  d.setUTCDate(1);
  while (toDay(d.toISOString().slice(0, 10)) <= to) {
    const day = toDay(d.toISOString().slice(0, 10));
    out.push({
      day,
      label: d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
      year: d.getUTCMonth() === 0,
    });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

type Drag = { id: string; mode: 'move' | 'start' | 'end'; x: number; start: number; end: number };

/**
 * Projects on a timeline, grouped by initiative: bars run from start to target date, filled as
 * far as the project is done, with diamonds for milestones. Drag a bar to move it, or its ends to
 * change dates.
 */
export function RoadmapPage() {
  const ws = useWorkspace();
  const [zoom, setZoom] = useState<Zoom>(() => readPref<Zoom>('roadmapZoom', 'months'));
  const [showClosed, setShowClosed] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const moved = useRef(false);
  const save = useWsMutation(ws.slug, (v: { id: string; startDate: string; targetDate: string }) =>
    api.patch(wsPath(ws.slug, `/projects/${v.id}`), {
      startDate: v.startDate,
      targetDate: v.targetDate,
    }),
  );
  const px = ZOOMS[zoom];
  const today = todayDay();

  const projects = ws.projects.filter(
    (p) => showClosed || (p.status !== 'completed' && p.status !== 'canceled'),
  );
  /** Where a project sits: its dates, or a drag in progress. */
  const span = (p: Project) => {
    if (drag?.id === p.id) return { start: drag.start, end: drag.end };
    const start = p.startDate ? toDay(p.startDate) : null;
    const end = p.targetDate ? toDay(p.targetDate) : null;
    if (start === null && end === null) return null;
    return { start: start ?? end!, end: end ?? start! };
  };

  const range = useMemo(() => {
    let lo = today - 30;
    let hi = today + 120;
    for (const p of ws.projects) {
      for (const d of [p.startDate, p.targetDate, ...p.milestones.map((m) => m.targetDate)])
        if (d) {
          lo = Math.min(lo, toDay(d) - 14);
          hi = Math.max(hi, toDay(d) + 30);
        }
    }
    for (const i of ws.initiatives) if (i.targetDate) hi = Math.max(hi, toDay(i.targetDate) + 30);
    const first = new Date(lo * DAY);
    first.setUTCDate(1);
    return { from: toDay(first.toISOString().slice(0, 10)), to: hi };
  }, [ws.projects, ws.initiatives, today]);
  const x = (day: number) => (day - range.from) * px;
  const width = x(range.to) + 40;

  const groups = [
    ...ws.initiatives.map((i) => ({
      key: i.id,
      initiative: i,
      projects: projects.filter((p) => p.initiativeId === i.id),
    })),
    {
      key: 'none',
      initiative: null,
      projects: projects.filter(
        (p) => !p.initiativeId || !ws.initiatives.some((i) => i.id === p.initiativeId),
      ),
    },
  ].filter((g) => g.projects.length > 0 || (g.initiative && g.initiative.status !== 'completed'));
  const scheduled = (list: Project[]) => list.filter((p) => span(p));
  const unscheduled = projects.filter((p) => !span(p));

  const startDrag = (e: React.PointerEvent, p: Project, mode: Drag['mode']) => {
    const s = span(p);
    if (!s || ws.isGuest) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    moved.current = false;
    setDrag({ id: p.id, mode, x: e.clientX, start: s.start, end: s.end });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = ws.projects.find((x) => x.id === drag.id)!;
    const base = {
      start: toDay(p.startDate ?? p.targetDate!),
      end: toDay(p.targetDate ?? p.startDate!),
    };
    const days = Math.round((e.clientX - drag.x) / px);
    if (days !== 0) moved.current = true;
    if (drag.mode === 'move') setDrag({ ...drag, start: base.start + days, end: base.end + days });
    else if (drag.mode === 'start')
      setDrag({ ...drag, start: Math.min(base.start + days, drag.end) });
    else setDrag({ ...drag, end: Math.max(base.end + days, drag.start) });
  };
  const endDrag = () => {
    if (!drag) return;
    if (moved.current)
      save.mutate({ id: drag.id, startDate: fromDay(drag.start), targetDate: fromDay(drag.end) });
    // The mutation's refetch replaces the drag preview.
    setTimeout(() => setDrag(null), moved.current ? 400 : 0);
  };

  const bar = (p: Project) => {
    const s = span(p)!;
    const left = x(s.start);
    const w = Math.max((s.end - s.start + 1) * px, 8);
    const pct = p.progress.total ? p.progress.completed / p.progress.total : 0;
    const handle = 'absolute top-0 h-full w-2 cursor-ew-resize';
    return (
      <div
        className="absolute top-1/2 h-5 -translate-y-1/2"
        style={{ left, width: w }}
        title={`${p.name}: ${p.startDate ?? '?'} → ${p.targetDate ?? '?'} · ${Math.round(pct * 100)}% done`}
      >
        <Link
          to="/$slug/project/$projectId"
          params={{ slug: ws.slug, projectId: p.id }}
          search={{}}
          draggable={false}
          onClick={(e) => moved.current && e.preventDefault()}
          onPointerDown={(e) => startDrag(e, p, 'move')}
          className={`block h-full overflow-hidden border ${ws.isGuest ? '' : 'cursor-grab active:cursor-grabbing'}`}
          style={{
            borderColor: p.color,
            background: `color-mix(in srgb, ${p.color} 14%, transparent)`,
          }}
        >
          <span
            className="block h-full"
            style={{
              width: `${pct * 100}%`,
              background: `color-mix(in srgb, ${p.color} 45%, transparent)`,
            }}
          />
        </Link>
        {!ws.isGuest && (
          <>
            <span className={`${handle} left-0`} onPointerDown={(e) => startDrag(e, p, 'start')} />
            <span className={`${handle} right-0`} onPointerDown={(e) => startDrag(e, p, 'end')} />
          </>
        )}
        {p.milestones
          .filter((m) => m.targetDate)
          .map((m) => (
            <span
              key={m.id}
              className="pointer-events-auto absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-bg"
              style={{ left: x(toDay(m.targetDate!)) - left + px / 2, background: p.color }}
              title={`${m.name} · ${m.targetDate}`}
            />
          ))}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            roadmap
          </>
        }
        title="Roadmap"
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 font-mono text-[11px] text-index">
              <input
                type="checkbox"
                className="accent-primary"
                checked={showClosed}
                onChange={(e) => setShowClosed(e.target.checked)}
              />
              closed
            </label>
            <div className="flex">
              {(Object.keys(ZOOMS) as Zoom[]).map((z) => (
                <button
                  key={z}
                  type="button"
                  className={`h-7 px-2.5 font-mono text-[11px] tracking-[0.1em] uppercase ${z === zoom ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
                  onClick={() => {
                    setZoom(z);
                    writePref('roadmapZoom', z);
                  }}
                >
                  {z}
                </button>
              ))}
            </div>
          </div>
        }
      />
      {projects.length === 0 ? (
        <EmptyState
          title="nothing on the roadmap"
          body="Projects with a start or target date show up here, grouped by initiative."
        />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto select-none"
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="relative" style={{ width: NAME_WIDTH + width }}>
            {/* Axis */}
            <div className="sticky top-0 z-20 flex h-9 border-b border-border-soft bg-surface">
              <div
                className="sticky left-0 z-10 flex-none border-r border-border-soft bg-surface"
                style={{ width: NAME_WIDTH }}
              />
              <div className="relative flex-1">
                {months(range.from, range.to).map((m) => (
                  <span
                    key={m.day}
                    className="absolute top-0 flex h-full items-center border-l border-border-soft pl-1.5 font-mono text-[10.5px] tracking-[0.12em] text-index uppercase"
                    style={{ left: x(m.day) }}
                  >
                    {m.label}
                    {(m.year || m.day === months(range.from, range.to)[0]!.day) &&
                      ` ${new Date(m.day * DAY).getUTCFullYear()}`}
                  </span>
                ))}
              </div>
            </div>
            {/* Today */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-primary"
              style={{ left: NAME_WIDTH + x(today) }}
            />
            {groups.map((g) => (
              <section key={g.key}>
                <div
                  className="relative flex border-b border-border-soft bg-surface/60"
                  style={{ height: ROW }}
                >
                  <div
                    className="sticky left-0 z-10 flex flex-none items-center gap-2 border-r border-border-soft bg-surface px-3"
                    style={{ width: NAME_WIDTH }}
                  >
                    {g.initiative ? (
                      <Link
                        to="/$slug/initiative/$initiativeId"
                        params={{ slug: ws.slug, initiativeId: g.initiative.id }}
                        className="flex min-w-0 items-center gap-2 hover:text-highlight"
                      >
                        <InitiativeIcon color={g.initiative.color} />
                        <span className="truncate text-[13px] font-medium">
                          {g.initiative.name}
                        </span>
                      </Link>
                    ) : (
                      <span className="font-mono text-[11px] tracking-[0.12em] text-index uppercase">
                        No initiative
                      </span>
                    )}
                  </div>
                  {g.initiative?.targetDate && (
                    <span
                      className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-bg"
                      style={{
                        left: NAME_WIDTH + x(toDay(g.initiative.targetDate)) + px / 2,
                        background: g.initiative.color,
                      }}
                      title={`${g.initiative.name} target · ${g.initiative.targetDate}`}
                    />
                  )}
                </div>
                {scheduled(g.projects).map((p) => (
                  <div
                    key={p.id}
                    className="row relative flex border-b border-border-soft/60"
                    style={{ height: ROW }}
                  >
                    <Link
                      to="/$slug/project/$projectId"
                      params={{ slug: ws.slug, projectId: p.id }}
                      search={{}}
                      className="sticky left-0 z-10 flex flex-none items-center gap-2 border-r border-border-soft bg-bg pr-3 pl-7"
                      style={{ width: NAME_WIDTH }}
                    >
                      <ProjectIcon color={p.color} />
                      <span className="truncate text-[13px]">{p.name}</span>
                    </Link>
                    <div className="relative flex-1">{bar(p)}</div>
                  </div>
                ))}
              </section>
            ))}
            {unscheduled.length > 0 && (
              <section>
                <div
                  className="sticky left-0 flex items-center border-b border-border-soft bg-surface/60 px-3 font-mono text-[11px] tracking-[0.12em] text-index uppercase"
                  style={{ height: ROW, width: NAME_WIDTH }}
                >
                  No dates
                </div>
                {unscheduled.map((p) => (
                  <Link
                    key={p.id}
                    to="/$slug/project/$projectId"
                    params={{ slug: ws.slug, projectId: p.id }}
                    search={{}}
                    className="row sticky left-0 flex items-center gap-2 border-b border-border-soft/60 pr-3 pl-7"
                    style={{ height: ROW, width: NAME_WIDTH }}
                  >
                    <ProjectIcon color={p.color} />
                    <span className="truncate text-[13px]">{p.name}</span>
                  </Link>
                ))}
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
