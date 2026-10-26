import {
  type GroupBy,
  type Issue,
  type IssueDisplay,
  type OrderBy,
  PRIORITIES,
  prioritySortKey,
  STATE_TYPE_LABELS,
  STATE_TYPES,
  type StateType,
  type UpdateIssueInput,
} from '@ordo/shared';
import { cycleName, type WorkspaceData } from './workspace.tsx';

export interface IssueGroup {
  key: string;
  label: string;
  /** Value the grouped property takes for issues dropped into this group. */
  value: string | number | null;
  color?: string;
  stateType?: StateType;
  issues: Issue[];
}

const DONE_TYPES: StateType[] = ['completed', 'canceled'];

export const isDone = (ws: WorkspaceData, issue: Issue) =>
  DONE_TYPES.includes(ws.stateById.get(issue.stateId)?.type ?? 'backlog');

export function sortIssues(issues: Issue[], orderBy: OrderBy): Issue[] {
  const list = [...issues];
  const cmp: Record<OrderBy, (a: Issue, b: Issue) => number> = {
    manual: (a, b) => a.sortOrder - b.sortOrder || b.createdAt.localeCompare(a.createdAt),
    priority: (a, b) =>
      prioritySortKey(a.priority) - prioritySortKey(b.priority) || a.sortOrder - b.sortOrder,
    updatedAt: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    createdAt: (a, b) => b.createdAt.localeCompare(a.createdAt),
    dueDate: (a, b) =>
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.sortOrder - b.sortOrder,
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return list.sort(cmp[orderBy]);
}

export function visibleIssues(ws: WorkspaceData, issues: Issue[], display: IssueDisplay) {
  return issues.filter(
    (i) => (display.showCompleted || !isDone(ws, i)) && (display.showSubIssues || !i.parentId),
  );
}

/**
 * Splits issues into groups for the list and board. With a single team, status groups
 * follow that team's workflow; across teams they collapse into status types.
 */
export function groupIssues(
  ws: WorkspaceData,
  issues: Issue[],
  display: IssueDisplay,
  teamId?: string,
): IssueGroup[] {
  const sorted = sortIssues(issues, display.orderBy);
  const groups: IssueGroup[] = [];
  const by = display.groupBy;
  const add = (g: Omit<IssueGroup, 'issues'>, match: (i: Issue) => boolean) =>
    groups.push({ ...g, issues: sorted.filter(match) });

  const singleTeam =
    teamId ?? (new Set(issues.map((i) => i.teamId)).size === 1 ? issues[0]?.teamId : undefined);

  switch (by as GroupBy) {
    case 'state': {
      const team = singleTeam ? ws.teamById.get(singleTeam) : undefined;
      if (team) {
        const states = [...team.states]
          .filter((s) => s.type !== 'triage' || team.triageEnabled)
          .sort(
            (a, b) =>
              STATE_TYPES.indexOf(a.type) - STATE_TYPES.indexOf(b.type) || a.position - b.position,
          );
        for (const s of states)
          add(
            { key: s.id, label: s.name, value: s.id, color: s.color, stateType: s.type },
            (i) => i.stateId === s.id,
          );
      } else {
        for (const t of STATE_TYPES) {
          add(
            { key: t, label: STATE_TYPE_LABELS[t], value: t, stateType: t },
            (i) => ws.stateById.get(i.stateId)?.type === t,
          );
        }
      }
      break;
    }
    case 'priority':
      for (const p of [1, 2, 3, 4, 0]) {
        add(
          { key: `p${p}`, label: PRIORITIES.find((x) => x.value === p)!.label, value: p },
          (i) => i.priority === p,
        );
      }
      break;
    case 'assignee':
      for (const m of ws.members)
        add(
          { key: m.id, label: m.name, value: m.id, color: m.avatarColor },
          (i) => i.assigneeId === m.id,
        );
      add({ key: 'none', label: 'No assignee', value: null }, (i) => !i.assigneeId);
      break;
    case 'project':
      for (const p of ws.projects)
        add({ key: p.id, label: p.name, value: p.id, color: p.color }, (i) => i.projectId === p.id);
      add({ key: 'none', label: 'No project', value: null }, (i) => !i.projectId);
      break;
    case 'cycle': {
      const cycles = ws.cycles.filter((c) => !singleTeam || c.teamId === singleTeam);
      for (const c of cycles) {
        const team = ws.teamById.get(c.teamId);
        add(
          {
            key: c.id,
            label: singleTeam ? cycleName(c) : `${team?.key} · ${cycleName(c)}`,
            value: c.id,
          },
          (i) => i.cycleId === c.id,
        );
      }
      add({ key: 'none', label: 'No cycle', value: null }, (i) => !i.cycleId);
      break;
    }
    case 'label':
      for (const l of ws.labels)
        add({ key: l.id, label: l.name, value: l.id, color: l.color }, (i) =>
          i.labelIds.includes(l.id),
        );
      add({ key: 'none', label: 'No labels', value: null }, (i) => i.labelIds.length === 0);
      break;
    default:
      groups.push({ key: 'all', label: 'All issues', value: null, issues: sorted });
  }

  return display.showEmptyGroups || by === 'none'
    ? groups
    : groups.filter((g) => g.issues.length > 0);
}

/** The patch that moves `issue` into `group` (used by board drag-and-drop). */
export function patchForGroup(
  ws: WorkspaceData,
  by: GroupBy,
  group: IssueGroup,
  issue: Issue,
): UpdateIssueInput | null {
  switch (by) {
    case 'state': {
      if (typeof group.value !== 'string') return null;
      if (ws.stateById.has(group.value))
        return group.value === issue.stateId ? {} : { stateId: group.value };
      // Grouped by status type: pick the issue's team's first status of that type.
      const team = ws.teamById.get(issue.teamId);
      const target = team?.states
        .filter((s) => s.type === group.value)
        .sort((a, b) => a.position - b.position)[0];
      if (!target) return null;
      return ws.stateById.get(issue.stateId)?.type === group.value ? {} : { stateId: target.id };
    }
    case 'priority':
      return { priority: group.value as number };
    case 'assignee':
      return { assigneeId: group.value as string | null };
    case 'project':
      return { projectId: group.value as string | null };
    case 'cycle':
      return { cycleId: group.value as string | null };
    default:
      return null;
  }
}
