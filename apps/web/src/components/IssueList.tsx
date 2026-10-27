import type { Issue, UpdateIssueInput } from '@ordo/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { IssueGroup } from '../lib/issues.ts';
import { IssueRow } from './IssueRow.tsx';
import { PriorityIcon, StatusIcon } from './icons.tsx';
import { Avatar } from './ui/Avatar.tsx';

interface Props {
  groups: IssueGroup[];
  flat: Issue[];
  focusedId: string | null;
  selected: Set<string>;
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  onPatch: (issue: Issue, patch: UpdateIssueInput) => void;
  onFocus: (id: string) => void;
  onToggleSelect: (id: string, shift: boolean) => void;
  onCreateInGroup: (group: IssueGroup) => void;
  groupKind: string;
}

function GroupIcon({ group, kind }: { group: IssueGroup; kind: string }) {
  if (kind === 'state' && group.stateType)
    return <StatusIcon type={group.stateType} color={group.color ?? 'var(--color-muted)'} />;
  if (kind === 'priority') return <PriorityIcon priority={group.value as number} />;
  if (kind === 'assignee' && group.value)
    return <Avatar name={group.label} color={group.color ?? 'var(--color-primary)'} size={16} />;
  if (group.color) return <span className="tag-dot" style={{ background: group.color }} />;
  return null;
}

/** Above this many rows the list renders only what's on screen. */
const VIRTUAL_FROM = 400;
const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 36;

type Row =
  | { kind: 'header'; group: IssueGroup }
  | { kind: 'issue'; group: IssueGroup; issue: Issue };

export function IssueList(props: Props) {
  const { groups, collapsed, groupKind } = props;
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const group of groups) {
      if (groupKind !== 'none') out.push({ kind: 'header', group });
      if (!collapsed.has(group.key))
        for (const issue of group.issues) out.push({ kind: 'issue', group, issue });
    }
    return out;
  }, [groups, collapsed, groupKind]);
  return rows.length > VIRTUAL_FROM ? (
    <VirtualList {...props} rows={rows} />
  ) : (
    <PlainList {...props} />
  );
}

function GroupHeader({
  group,
  groupKind,
  collapsed,
  showAdd,
  onToggleCollapse,
  onCreateInGroup,
}: {
  group: IssueGroup;
  groupKind: string;
  collapsed: boolean;
  showAdd: boolean;
  onToggleCollapse: (key: string) => void;
  onCreateInGroup: (group: IssueGroup) => void;
}) {
  return (
    <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-border-soft bg-surface px-3">
      <button
        type="button"
        className="flex items-center gap-2 text-left"
        onClick={() => onToggleCollapse(group.key)}
        aria-expanded={!collapsed}
      >
        <ChevronRight
          size={13}
          className={`text-index transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        <GroupIcon group={group} kind={groupKind} />
        <span className="text-[13px] font-medium">{group.label}</span>
        <span className="font-mono text-[11px] text-index">{group.issues.length}</span>
      </button>
      <button
        type="button"
        className={`ml-auto flex h-6 w-6 items-center justify-center text-index hover:text-text ${showAdd ? 'opacity-100' : 'opacity-0'}`}
        onClick={() => onCreateInGroup(group)}
        aria-label={`New issue in ${group.label}`}
      >
        <Plus size={14} />
      </button>
    </header>
  );
}

function PlainList({
  groups,
  focusedId,
  selected,
  collapsed,
  onToggleCollapse,
  onPatch,
  onFocus,
  onToggleSelect,
  onCreateInGroup,
  groupKind,
}: Props) {
  const [hoverGroup, setHoverGroup] = useState<string | null>(null);
  return (
    <div className="h-full overflow-y-auto">
      <div className="pb-24" role="list">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <section
              key={g.key}
              onMouseEnter={() => setHoverGroup(g.key)}
              onMouseLeave={() => setHoverGroup(null)}
            >
              {groupKind !== 'none' && (
                <GroupHeader
                  group={g}
                  groupKind={groupKind}
                  collapsed={isCollapsed}
                  showAdd={hoverGroup === g.key}
                  onToggleCollapse={onToggleCollapse}
                  onCreateInGroup={onCreateInGroup}
                />
              )}
              {!isCollapsed &&
                g.issues.map((issue) => (
                  <IssueRow
                    key={`${g.key}:${issue.id}`}
                    issue={issue}
                    focused={focusedId === issue.id}
                    selected={selected.has(issue.id)}
                    onPatch={onPatch}
                    onFocus={() => onFocus(issue.id)}
                    onToggleSelect={(shift) => onToggleSelect(issue.id, shift)}
                  />
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The same list for very big views: rows are absolutely placed and only those near the viewport
 * exist. The group of the topmost row stays pinned, as sticky headers would.
 */
function VirtualList({
  rows,
  focusedId,
  selected,
  collapsed,
  onToggleCollapse,
  onPatch,
  onFocus,
  onToggleSelect,
  onCreateInGroup,
  groupKind,
}: Props & { rows: Row[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i]!.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 15,
    paddingEnd: 96,
  });

  // Keyboard focus (J/K) may land on a row that isn't rendered yet.
  useEffect(() => {
    if (!focusedId) return;
    const index = rows.findIndex((r) => r.kind === 'issue' && r.issue.id === focusedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [focusedId, rows, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const top = items[0] ? rows[items[0].index] : undefined;
  const header = (group: IssueGroup): ReactNode => (
    <GroupHeader
      group={group}
      groupKind={groupKind}
      collapsed={collapsed.has(group.key)}
      showAdd
      onToggleCollapse={onToggleCollapse}
      onCreateInGroup={onCreateInGroup}
    />
  );

  return (
    <div ref={scroller} className="h-full overflow-y-auto" role="list">
      {groupKind !== 'none' && top && virtualizer.scrollOffset ? (
        <div className="sticky top-0 z-20 h-0">{header(top.group)}</div>
      ) : null}
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={item.key}
              className="absolute inset-x-0"
              style={{ top: item.start, height: item.size }}
            >
              {row.kind === 'header' ? (
                header(row.group)
              ) : (
                <IssueRow
                  issue={row.issue}
                  focused={focusedId === row.issue.id}
                  selected={selected.has(row.issue.id)}
                  onPatch={onPatch}
                  onFocus={() => onFocus(row.issue.id)}
                  onToggleSelect={(shift) => onToggleSelect(row.issue.id, shift)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
