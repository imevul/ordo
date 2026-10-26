import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type GroupBy, type Issue, sortOrderBetween, type UpdateIssueInput } from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { GitBranch, Plus } from 'lucide-react';
import { memo, useState } from 'react';
import { dueState, shortDate } from '../lib/format.ts';
import { type IssueGroup, isDone, patchForGroup } from '../lib/issues.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { AssigneeProp, PriorityProp } from './properties.tsx';
import { Avatar } from './ui/Avatar.tsx';

interface Props {
  groups: IssueGroup[];
  groupBy: GroupBy;
  manualOrder: boolean;
  focusedId: string | null;
  selected: Set<string>;
  onPatch: (issue: Issue, patch: UpdateIssueInput) => void;
  onFocus: (id: string) => void;
  onCreateInGroup: (group: IssueGroup) => void;
}

const Card = memo(function Card({
  issue,
  focused,
  selected,
  onPatch,
  overlay,
}: {
  issue: Issue;
  focused?: boolean;
  selected?: boolean;
  onPatch?: (issue: Issue, patch: UpdateIssueInput) => void;
  overlay?: boolean;
}) {
  const ws = useWorkspace();
  const labels = issue.labelIds.map((id) => ws.labelById.get(id)).filter(Boolean);
  const project = issue.projectId ? ws.projectById.get(issue.projectId) : null;
  const due = dueState(issue.dueDate, isDone(ws, issue));
  const state = ws.stateById.get(issue.stateId);
  return (
    <div
      className={`panel panel-sm ${overlay ? '[--panel-border:var(--color-primary)]' : 'panel-interactive'} ${focused || selected ? '[--panel-border:var(--color-primary)]' : ''} block cursor-grab p-3 active:cursor-grabbing`}
      data-issue-id={issue.id}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-index">{issue.identifier}</span>
        <span className="ml-auto">
          {onPatch ? (
            <AssigneeProp issue={issue} onPatch={(p) => onPatch(issue, p)} variant="icon" />
          ) : null}
        </span>
      </div>
      <div className="mt-1 flex items-start gap-2">
        {state && (
          <span className="mt-[3px]">
            <StatusIcon type={state.type} color={state.color} size={13} />
          </span>
        )}
        <Link
          to="/$slug/issue/$identifier"
          params={{ slug: ws.slug, identifier: issue.identifier }}
          className="line-clamp-3 text-[13.5px] leading-snug text-text"
          onPointerDown={(e) => e.stopPropagation()}
          draggable={false}
        >
          {issue.title}
        </Link>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {onPatch ? (
          <PriorityProp issue={issue} onPatch={(p) => onPatch(issue, p)} variant="icon" />
        ) : (
          <PriorityIcon priority={issue.priority} />
        )}
        {labels.slice(0, 3).map((l) => (
          <span key={l!.id} className="tag">
            <span className="tag-dot" style={{ background: l!.color }} />
            {l!.name}
          </span>
        ))}
        {project && (
          <span className="tag max-w-36">
            <ProjectIcon color={project.color} size={11} />
            <span className="truncate">{project.name}</span>
          </span>
        )}
        {issue.dueDate && (
          <span
            className={`tag ${due === 'overdue' ? 'text-error' : due === 'soon' ? 'text-warning' : ''}`}
          >
            {shortDate(issue.dueDate)}
          </span>
        )}
        {issue.subIssueCount > 0 && (
          <span className="tag font-mono">
            <GitBranch size={11} />
            {issue.completedSubIssueCount}/{issue.subIssueCount}
          </span>
        )}
        {issue.estimate != null && <span className="tag font-mono">{issue.estimate}</span>}
      </div>
    </div>
  );
});

function SortableCard(props: {
  issue: Issue;
  focused: boolean;
  selected: boolean;
  onPatch: Props['onPatch'];
  onFocus: () => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.issue.id,
    disabled: props.disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : 1,
      }}
      onMouseEnter={props.onFocus}
      {...attributes}
      {...listeners}
    >
      <Card
        issue={props.issue}
        focused={props.focused}
        selected={props.selected}
        onPatch={props.onPatch}
      />
    </div>
  );
}

function Column({
  group,
  groupBy,
  children,
  onCreate,
}: {
  group: IssueGroup;
  groupBy: GroupBy;
  children: React.ReactNode;
  onCreate: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${group.key}` });
  return (
    <div className="flex w-[300px] flex-none flex-col">
      <header className="flex h-9 flex-none items-center gap-2 px-1">
        {groupBy === 'state' && group.stateType && (
          <StatusIcon type={group.stateType} color={group.color ?? '#b8aab2'} />
        )}
        {groupBy === 'priority' && <PriorityIcon priority={group.value as number} />}
        {groupBy === 'assignee' && group.value && (
          <Avatar name={group.label} color={group.color ?? '#ff1493'} size={16} />
        )}
        {groupBy !== 'state' && groupBy !== 'priority' && groupBy !== 'assignee' && group.color && (
          <span className="tag-dot" style={{ background: group.color }} />
        )}
        <span className="truncate text-[13px] font-medium">{group.label}</span>
        <span className="font-mono text-[11px] text-index">{group.issues.length}</span>
        <button
          type="button"
          className="ml-auto flex h-6 w-6 items-center justify-center text-index hover:text-text"
          onClick={onCreate}
          aria-label={`New issue in ${group.label}`}
        >
          <Plus size={14} />
        </button>
      </header>
      <div
        ref={setNodeRef}
        className={`flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-1 pb-10 transition-colors ${isOver ? 'bg-primary/[0.04]' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}

export function IssueBoard({
  groups,
  groupBy,
  manualOrder,
  focusedId,
  selected,
  onPatch,
  onFocus,
  onCreateInGroup,
}: Props) {
  const ws = useWorkspace();
  const [dragging, setDragging] = useState<Issue | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const draggable = groupBy !== 'label' && groupBy !== 'none';

  const findGroup = (id: string) =>
    id.startsWith('col:')
      ? groups.find((g) => `col:${g.key}` === id)
      : groups.find((g) => g.issues.some((i) => i.id === id));

  const onDragStart = (e: DragStartEvent) => {
    setDragging(groups.flatMap((g) => g.issues).find((i) => i.id === e.active.id) ?? null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const from = findGroup(String(active.id));
    const to = findGroup(String(over.id));
    const issue = from?.issues.find((i) => i.id === active.id);
    if (!from || !to || !issue) return;

    const patch: UpdateIssueInput =
      from.key === to.key ? {} : (patchForGroup(ws, groupBy, to, issue) ?? {});
    if (from.key !== to.key && Object.keys(patch).length === 0) return;

    if (manualOrder) {
      const others = to.issues.filter((i) => i.id !== issue.id);
      let index = others.length;
      if (!String(over.id).startsWith('col:')) {
        const overIndex = others.findIndex((i) => i.id === over.id);
        const activeIndex = to.issues.findIndex((i) => i.id === issue.id);
        // Moving down inside the same column lands after the hovered card.
        index =
          overIndex < 0
            ? others.length
            : from.key === to.key && activeIndex >= 0 && activeIndex <= overIndex
              ? overIndex + 1
              : overIndex;
      }
      const before = others[index - 1]?.sortOrder;
      const after = others[index]?.sortOrder;
      const next = sortOrderBetween(before, after);
      if (from.key !== to.key || next !== issue.sortOrder) patch.sortOrder = next;
    }
    if (Object.keys(patch).length) onPatch(issue, patch);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex h-full gap-3 overflow-x-auto px-4 pt-2">
        {groups.map((g) => (
          <Column key={g.key} group={g} groupBy={groupBy} onCreate={() => onCreateInGroup(g)}>
            <SortableContext
              items={g.issues.map((i) => i.id)}
              strategy={verticalListSortingStrategy}
            >
              {g.issues.map((issue) => (
                <SortableCard
                  key={issue.id}
                  issue={issue}
                  focused={focusedId === issue.id}
                  selected={selected.has(issue.id)}
                  onPatch={onPatch}
                  onFocus={() => onFocus(issue.id)}
                  disabled={!draggable}
                />
              ))}
            </SortableContext>
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging ? <Card issue={dragging} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
