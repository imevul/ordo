import type { Issue, UpdateIssueInput } from '@ordo/shared';
import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
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
    return <StatusIcon type={group.stateType} color={group.color ?? '#b8aab2'} />;
  if (kind === 'priority') return <PriorityIcon priority={group.value as number} />;
  if (kind === 'assignee' && group.value)
    return <Avatar name={group.label} color={group.color ?? '#ff1493'} size={16} />;
  if (group.color) return <span className="tag-dot" style={{ background: group.color }} />;
  return null;
}

export function IssueList({
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
              <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-border-soft bg-surface px-3">
                <button
                  type="button"
                  className="flex items-center gap-2 text-left"
                  onClick={() => onToggleCollapse(g.key)}
                  aria-expanded={!isCollapsed}
                >
                  <ChevronRight
                    size={13}
                    className={`text-index transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  />
                  <GroupIcon group={g} kind={groupKind} />
                  <span className="text-[13px] font-medium">{g.label}</span>
                  <span className="font-mono text-[11px] text-index">{g.issues.length}</span>
                </button>
                <button
                  type="button"
                  className={`ml-auto flex h-6 w-6 items-center justify-center text-index hover:text-text ${hoverGroup === g.key ? 'opacity-100' : 'opacity-0'}`}
                  onClick={() => onCreateInGroup(g)}
                  aria-label={`New issue in ${g.label}`}
                >
                  <Plus size={14} />
                </button>
              </header>
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
  );
}
