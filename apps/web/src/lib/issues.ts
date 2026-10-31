import {
  type GroupBy,
  groupByField,
  ISSUE_IDENTIFIER_PATTERN,
  type Issue,
  type IssueDisplay,
  type OrderBy,
  prioritySortKey,
  STATE_TYPES,
  type StateType,
  type UpdateIssueInput,
} from '@ordo/shared';
import { t } from '../i18n/index.ts';
import { priorityLabel, stateTypeLabel } from '../i18n/labels.ts';
import { groupingField } from './customFields.ts';
import { cycleName, type WorkspaceData } from './workspace.tsx';

export interface IssueGroup {
  key: string;
  label: string;
  /** Value the grouped property takes for issues dropped into this group. */
  value: string | number | null;
  color?: string;
  stateType?: StateType;
  /** A group of one person's issues (assignee or a person field): headers show an avatar. */
  person?: boolean;
  issues: Issue[];
}

const DONE_TYPES: StateType[] = ['completed', 'canceled'];

export const isDone = (ws: WorkspaceData, issue: Issue) =>
  DONE_TYPES.includes(ws.stateById.get(issue.stateId)?.type ?? 'backlog');

/**
 * The identifier an issue page opened as `asked` should show in its URL instead, if any: the
 * issue has moved team (a queued move that was sent, or an old link) or its team key changed.
 * Not while the server hasn't numbered it yet.
 */
export function newerIdentifier(asked: string, issue: Pick<Issue, 'identifier'>): string | null {
  if (!ISSUE_IDENTIFIER_PATTERN.test(issue.identifier)) return null;
  return asked.toUpperCase() === issue.identifier.toUpperCase() ? null : issue.identifier;
}

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

  /** A group per member, then per other person with issues, then one for nobody. */
  const addPeople = (personOf: (i: Issue) => string | null, noneLabel: string) => {
    for (const m of ws.members)
      add(
        { key: m.id, label: m.name, value: m.id, color: m.avatarColor, person: true },
        (i) => personOf(i) === m.id,
      );
    // Placeholders and people who left aren't members, but their issues still need a group.
    const memberIds = new Set(ws.members.map((m) => m.id));
    const others = [
      ...new Set(
        issues.flatMap((i) => {
          const id = personOf(i);
          return id && !memberIds.has(id) ? [id] : [];
        }),
      ),
    ]
      .map((id) => ({ id, person: ws.memberById.get(id) }))
      .sort(
        (a, b) =>
          Number(!a.person) - Number(!b.person) ||
          (a.person?.name ?? '').localeCompare(b.person?.name ?? ''),
      );
    for (const { id, person } of others)
      add(
        {
          key: id,
          label: !person
            ? t('issues.group.someone')
            : person.placeholder
              ? t('issues.group.placeholder', { name: person.name })
              : person.former
                ? t('issues.group.formerMember', { name: person.name })
                : person.name,
          value: id,
          color: person?.avatarColor,
          person: true,
        },
        (i) => personOf(i) === id,
      );
    add({ key: 'none', label: noneLabel, value: null }, (i) => !personOf(i));
  };

  const field = groupingField(ws, by);
  if (field) {
    const value = (i: Issue) => i.customFields?.[field.id];
    const none = t('customFields.props.none', { field: field.name });
    if (field.type === 'person') {
      addPeople((i) => {
        const v = value(i);
        return typeof v === 'string' ? v : null;
      }, none);
    } else {
      const known = new Set(field.options.map((o) => o.id));
      const has = (i: Issue, id: string) => {
        const v = value(i);
        return Array.isArray(v) ? v.includes(id) : v === id;
      };
      for (const o of field.options)
        add({ key: o.id, label: o.name, value: o.id, color: o.color }, (i) => has(i, o.id));
      // An option removed since the issue was loaded counts as no value.
      add({ key: 'none', label: none, value: null }, (i) => {
        const v = value(i);
        const ids = v === undefined ? [] : Array.isArray(v) ? v : [String(v)];
        return !ids.some((id) => known.has(id));
      });
    }
    return display.showEmptyGroups ? groups : groups.filter((g) => g.issues.length > 0);
  }

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
        for (const type of STATE_TYPES) {
          add(
            { key: type, label: stateTypeLabel(type), value: type, stateType: type },
            (i) => ws.stateById.get(i.stateId)?.type === type,
          );
        }
      }
      break;
    }
    case 'priority':
      for (const p of [1, 2, 3, 4, 0]) {
        add({ key: `p${p}`, label: priorityLabel(p), value: p }, (i) => i.priority === p);
      }
      break;
    case 'assignee':
      addPeople((i) => i.assigneeId, t('issues.none.assignee'));
      break;
    case 'project':
      for (const p of ws.projects)
        add({ key: p.id, label: p.name, value: p.id, color: p.color }, (i) => i.projectId === p.id);
      add({ key: 'none', label: t('issues.none.project'), value: null }, (i) => !i.projectId);
      break;
    case 'milestone': {
      // Milestones of the projects in view, in project then date order.
      const used = new Set(issues.map((i) => i.projectId));
      const projects = ws.projects.filter((p) => used.has(p.id));
      for (const p of projects)
        for (const m of p.milestones)
          add(
            {
              key: m.id,
              label: projects.length > 1 ? `${p.name} · ${m.name}` : m.name,
              value: m.id,
              color: p.color,
            },
            (i) => i.milestoneId === m.id,
          );
      add({ key: 'none', label: t('issues.none.milestone'), value: null }, (i) => !i.milestoneId);
      break;
    }
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
      add({ key: 'none', label: t('issues.none.cycle'), value: null }, (i) => !i.cycleId);
      break;
    }
    case 'label':
      for (const l of ws.labels)
        add({ key: l.id, label: l.name, value: l.id, color: l.color }, (i) =>
          i.labelIds.includes(l.id),
        );
      add(
        { key: 'none', label: t('issues.none.labels'), value: null },
        (i) => i.labelIds.length === 0,
      );
      break;
    default:
      groups.push({ key: 'all', label: t('issues.allIssues'), value: null, issues: sorted });
  }

  return display.showEmptyGroups || by === 'none'
    ? groups
    : groups.filter((g) => g.issues.length > 0);
}

/**
 * Whether board cards can be dragged between groups. Not for labels and multi-selects (an issue
 * can be in several of their groups) or the ungrouped board.
 */
export function canDropOnGroups(ws: WorkspaceData, by: GroupBy): boolean {
  if (by === 'label' || by === 'none') return false;
  if (!groupByField(by)) return true;
  const field = groupingField(ws, by);
  return !!field && field.type !== 'multi_select';
}

/** The patch that moves `issue` into `group` (used by board drag-and-drop). */
export function patchForGroup(
  ws: WorkspaceData,
  by: GroupBy,
  group: IssueGroup,
  issue: Issue,
): UpdateIssueInput | null {
  if (groupByField(by)) {
    const field = groupingField(ws, by);
    if (!field || !canDropOnGroups(ws, by)) return null;
    // A team field can't be set on another team's issue.
    if (field.teamId && field.teamId !== issue.teamId) return null;
    if (
      field.type === 'person' &&
      group.value !== null &&
      !ws.members.some((m) => m.id === group.value)
    )
      return null;
    if (group.value !== null && typeof group.value !== 'string') return null;
    return { customFields: { [field.id]: group.value } };
  }
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
      // Placeholders and former members can't be picked, so their groups take no new issues.
      if (group.value !== null && !ws.members.some((m) => m.id === group.value)) return null;
      return { assigneeId: group.value as string | null };
    case 'project':
      return { projectId: group.value as string | null };
    case 'cycle':
      return { cycleId: group.value as string | null };
    case 'milestone':
      return { milestoneId: group.value as string | null };
    default:
      return null;
  }
}
