import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { Cycle, CycleWorkload, WorkloadEntry, WorkloadIssue } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { keys, useCycleWorkload, useUpdateIssue, useWsMutation } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { loadBar, loadLevel, moveIssue } from '../lib/workload.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { StatusIcon } from './icons.tsx';
import { Avatar } from './ui/Avatar.tsx';

const UNASSIGNED = 'none';

/**
 * Each person's load in a cycle against their capacity, over-capacity in the warning colour.
 * Dragging an issue onto someone assigns it to them.
 */
export function WorkloadPanel({ cycle, onClose }: { cycle: Cycle; onClose: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const { data } = useCycleWorkload(ws.slug, cycle.id);
  const update = useUpdateIssue(ws.slug);
  const [dragging, setDragging] = useState<WorkloadIssue | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const nameOf = (userId: string | null) =>
    userId ? (ws.memberById.get(userId)?.name ?? '?') : t('cycles.workload.unassigned');

  const onDragStart = (e: DragStartEvent) =>
    setDragging(data?.entries.flatMap((x) => x.issues).find((i) => i.id === e.active.id) ?? null);

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    if (!data || !e.over) return;
    const issueId = String(e.active.id);
    const over = String(e.over.id);
    const to = over === UNASSIGNED ? null : over;
    const from = data.entries.find((x) => x.issues.some((i) => i.id === issueId));
    const issue = from?.issues.find((i) => i.id === issueId);
    if (!from || !issue || from.userId === to) return;
    const key = keys.workload(ws.slug, cycle.id);
    qc.setQueryData<CycleWorkload>(key, (w) => (w ? moveIssue(w, issueId, to) : w));
    update.mutate(
      { id: issueId, patch: { assigneeId: to } },
      {
        onSuccess: () =>
          toast.success(
            to
              ? t('cycles.workload.moved', { identifier: issue.identifier, name: nameOf(to) })
              : t('cycles.workload.unassignedToast', { identifier: issue.identifier }),
          ),
      },
    );
  };

  const maxLoad = Math.max(0, ...(data?.entries.map((e) => e.load) ?? []));
  return (
    <aside
      className="absolute inset-0 z-20 flex flex-col bg-surface sm:static sm:h-full sm:w-[22rem] sm:flex-none sm:border-l sm:border-border-soft"
      aria-label={t('cycles.workload.title')}
    >
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
        <span className="section-label flex-1">{t('cycles.workload.title')}</span>
        {data && (
          <span className="font-mono text-[11px] text-index">
            {data.unit === 'points'
              ? t('cycles.workload.unitPoints')
              : t('cycles.workload.unitIssues')}
          </span>
        )}
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
          onClick={onClose}
          aria-label={t('cycles.workload.close')}
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!data ? (
          <p className="font-mono text-[12px] text-index">{t('cycles.workload.loading')}</p>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragging(null)}
          >
            {!ws.isGuest && (
              <p className="mb-3 text-[12px] text-index">{t('cycles.workload.hint')}</p>
            )}
            {data.entries.map((e) => (
              <EntryRow
                key={e.userId ?? UNASSIGNED}
                entry={e}
                cycle={cycle}
                maxLoad={maxLoad}
                name={nameOf(e.userId)}
                canDrag={!ws.isGuest}
              />
            ))}
            <DragOverlay dropAnimation={null}>
              {dragging && <IssueLine issue={dragging} overlay />}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </aside>
  );
}

function EntryRow({
  entry,
  cycle,
  maxLoad,
  name,
  canDrag,
}: {
  entry: WorkloadEntry;
  cycle: Cycle;
  maxLoad: number;
  name: string;
  canDrag: boolean;
}) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: entry.userId ?? UNASSIGNED });
  const person = entry.userId ? ws.memberById.get(entry.userId) : undefined;
  const level = loadLevel(entry);
  const bar = loadBar(entry, maxLoad);
  const over = level === 'over';
  // Capacities belong to team members; anyone who plans the cycle may change them for it.
  const canEdit = !ws.isGuest && entry.userId != null && !entry.outsideTeam;
  const source = entry.capacitySource
    ? t(`cycles.workload.source.${entry.capacitySource}`)
    : t('cycles.workload.noCapacity');
  const amount =
    entry.capacity == null
      ? t('cycles.workload.loadOnly', { load: entry.load })
      : t('cycles.workload.loadOfCapacity', { load: entry.load, capacity: entry.capacity });

  return (
    <section
      ref={setNodeRef}
      className={`mb-2 border px-3 py-2.5 ${isOver ? 'border-primary' : 'border-border-soft'}`}
      data-workload-user={entry.userId ?? UNASSIGNED}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-5 w-5 flex-none items-center justify-center text-index hover:text-text"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={t('cycles.workload.showIssues', { name })}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {person && (
          <Avatar name={person.name} color={person.avatarColor} src={person.avatarUrl} size={18} />
        )}
        <span className={`min-w-0 flex-1 truncate text-[13px] ${person ? '' : 'text-muted'}`}>
          {name}
          {entry.outsideTeam && (
            <span className="ml-1.5 font-mono text-[10.5px] text-index">
              {t('cycles.workload.outsideTeam')}
            </span>
          )}
        </span>
        {canEdit && !editing ? (
          <button
            type="button"
            className={`font-mono text-[12px] hover:text-text ${over ? 'text-warning' : 'text-muted'}`}
            onClick={() => setEditing(true)}
            title={source}
            aria-label={t('cycles.workload.editCapacity', { name })}
          >
            {amount}
          </button>
        ) : (
          !editing && (
            <span
              className={`font-mono text-[12px] ${over ? 'text-warning' : 'text-muted'}`}
              title={entry.userId ? source : undefined}
            >
              {amount}
            </span>
          )
        )}
      </div>
      {editing && entry.userId && (
        <CapacityEditor
          cycle={cycle}
          userId={entry.userId}
          name={name}
          value={entry.capacitySource === 'cycle' ? entry.capacity : null}
          placeholder={entry.capacitySource === 'cycle' ? null : entry.capacity}
          onDone={() => setEditing(false)}
        />
      )}
      {entry.userId != null && (
        <div className="mt-2 flex items-center gap-2">
          <div
            className="progress-track relative flex-1"
            role="meter"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={entry.capacity ?? maxLoad}
            aria-valuenow={entry.load}
          >
            <div
              className={`absolute inset-y-0 left-0 ${over ? 'bg-warning' : 'progress-fill'}`}
              style={{ width: `${bar.load}%`, opacity: over ? 1 : 0.45 }}
            />
            <div
              className={`absolute inset-y-0 left-0 ${over ? 'bg-warning' : 'progress-fill'}`}
              style={{ width: `${bar.completed}%` }}
            />
          </div>
          {over && (
            <span className="font-mono text-[10.5px] text-warning">
              {t('cycles.workload.over', { count: entry.load - (entry.capacity ?? 0) })}
            </span>
          )}
        </div>
      )}
      {entry.unestimated > 0 && (
        <div className="mt-1 font-mono text-[10.5px] text-index">
          {t('cycles.workload.unestimated', { count: entry.unestimated })}
        </div>
      )}
      {open && (
        <div className="mt-2">
          {entry.issues.length === 0 ? (
            <p className="pl-7 font-mono text-[11px] text-index">{t('cycles.workload.noIssues')}</p>
          ) : (
            entry.issues.map((i) =>
              canDrag ? (
                <DraggableIssue key={i.id} issue={i} />
              ) : (
                <IssueLine key={i.id} issue={i} />
              ),
            )
          )}
        </div>
      )}
    </section>
  );
}

function CapacityEditor({
  cycle,
  userId,
  name,
  value,
  placeholder,
  onDone,
}: {
  cycle: Cycle;
  userId: string;
  name: string;
  value: number | null;
  placeholder: number | null;
  onDone: () => void;
}) {
  const ws = useWorkspace();
  const [text, setText] = useState(value == null ? '' : String(value));
  // Escape closes the editor, which blurs the input: that must not save.
  const cancelled = useRef(false);
  const save = useWsMutation(
    ws.slug,
    (capacity: number | null) =>
      api.put(wsPath(ws.slug, `/cycles/${cycle.id}/capacity/${userId}`), { capacity }),
    { success: t('cycles.workload.capacitySaved'), invalidate: [keys.workload(ws.slug, cycle.id)] },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cancelled.current || save.isPending) return;
    const next = text.trim() === '' ? null : Number(text);
    if (next === value || (next != null && !Number.isInteger(next))) return onDone();
    save.mutate(next, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} className="mt-2 pl-7">
      <input
        type="number"
        min={0}
        max={10000}
        step={1}
        className="input h-7 w-24 py-0 font-mono text-[12px]"
        value={text}
        placeholder={placeholder == null ? '' : String(placeholder)}
        onChange={(e) => setText(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancelled.current = true;
            onDone();
          }
        }}
        aria-label={t('cycles.workload.editCapacity', { name })}
        autoFocus
      />
      <span className="ml-2 text-[11px] text-index">{t('cycles.workload.capacityHint')}</span>
    </form>
  );
}

function DraggableIssue({ issue }: { issue: WorkloadIssue }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id: issue.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-40' : ''}`}
    >
      <IssueLine issue={issue} />
    </div>
  );
}

function IssueLine({ issue, overlay }: { issue: WorkloadIssue; overlay?: boolean }) {
  const ws = useWorkspace();
  const state = ws.stateById.get(issue.stateId);
  return (
    <div
      className={`flex h-7 items-center gap-2 pl-7 text-[12.5px] ${overlay ? 'panel panel-sm pr-2 [--panel-border:var(--color-primary)]' : ''}`}
    >
      {state && <StatusIcon type={state.type} color={state.color} size={12} />}
      <span className="flex-none font-mono text-[11px] text-index">{issue.identifier}</span>
      <Link
        to="/$slug/issue/$identifier"
        params={{ slug: ws.slug, identifier: issue.identifier }}
        className={`min-w-0 flex-1 truncate ${issue.completed ? 'text-muted line-through' : 'text-text'}`}
        draggable={false}
      >
        {issue.title}
      </Link>
      {issue.estimate != null && (
        <span className="flex-none font-mono text-[11px] text-index">{issue.estimate}</span>
      )}
    </div>
  );
}
