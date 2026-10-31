import {
  type Bootstrap,
  type Comment,
  type CreateIssueInput,
  type CustomFieldValue,
  defaultAssigneeFor,
  type Issue,
  isAdminRole,
  type Team,
  type UpdateIssueInput,
} from '@ordo/shared';
import { patchIssue, toggleReaction } from './optimistic.ts';

/**
 * Changes made through the local copy, waiting to reach the server. Each is a small typed
 * operation that maps onto one REST call; they're sent in order, and until then they're shown on
 * top of what the server last said, so the screen reflects them straight away.
 */

export type Op =
  | { kind: 'issue.create'; issue: CreateIssueInput & { id: string } }
  | { kind: 'issue.update'; ids: string[]; patch: UpdateIssueInput }
  | { kind: 'issue.trash'; ids: string[] }
  | { kind: 'issue.restore'; ids: string[] }
  /** To another team: the server renumbers it and maps its status onto the team's workflow. */
  | { kind: 'issue.move'; ids: string[]; teamId: string }
  | {
      kind: 'comment.create';
      comment: { id: string; issueId: string; body: string; parentId: string | null };
    }
  | { kind: 'comment.update'; id: string; issueId: string; body: string }
  | { kind: 'comment.delete'; id: string; issueId: string }
  | { kind: 'reaction'; commentId: string; issueId: string; emoji: string; on: boolean }
  | {
      kind: 'relation.create';
      relation: { id: string; issueId: string; type: string; relatedIssueId: string };
    }
  | { kind: 'relation.delete'; id: string };

export interface PendingOp {
  /** Its place in the queue (the store's key). */
  key: number;
  op: Op;
  /** Who queued it: another person signing in on this device doesn't send it. */
  userId: string;
  queuedAt: string;
  attempts: number;
  /** Set when the server refused it; it then waits for someone to look at it. */
  error: string | null;
}

/** Ids of things an operation creates. */
export function creates(op: Op): string[] {
  if (op.kind === 'issue.create') return [op.issue.id];
  if (op.kind === 'comment.create') return [op.comment.id];
  if (op.kind === 'relation.create') return [op.relation.id];
  return [];
}

/** Ids an operation needs to exist: if creating one of them failed, this one can't succeed. */
export function needs(op: Op): string[] {
  switch (op.kind) {
    case 'issue.create':
      return op.issue.parentId ? [op.issue.parentId] : [];
    case 'issue.update':
    case 'issue.trash':
    case 'issue.restore':
    case 'issue.move':
      return op.ids;
    case 'comment.create':
      return [op.comment.issueId, ...(op.comment.parentId ? [op.comment.parentId] : [])];
    case 'comment.update':
    case 'comment.delete':
      return [op.id, op.issueId];
    case 'reaction':
      return [op.commentId];
    case 'relation.create':
      return [op.relation.issueId, op.relation.relatedIssueId];
    case 'relation.delete':
      return [op.id];
  }
}

// ─── issues ──────────────────────────────────────────────────────────────

/** Where a new issue starts when no status is given, picked as the server picks it. */
function defaultState(team: Team | undefined) {
  const states = [...(team?.states ?? [])].sort((a, b) => a.position - b.position);
  return (
    states.find((s) => s.id === team?.defaultStateId) ??
    states.find((s) => s.type === 'backlog') ??
    states.find((s) => s.type === 'unstarted') ??
    states[0]
  );
}

/**
 * Leaving the assignee out means the usual person (the project's choice, else the workspace's)
 * if they can work in the team; triage leaves it to whoever triages. As the server decides it.
 */
function guessAssignee(
  input: CreateIssueInput,
  team: Team | undefined,
  stateType: string | undefined,
  bootstrap: Bootstrap | null,
): string | null {
  if (input.assigneeId !== undefined) return input.assigneeId;
  if (!bootstrap || !team || stateType === 'triage') return null;
  // Partial bootstraps (tests, older caches) just have no default.
  const projects = bootstrap.projects ?? [];
  const projectId =
    (input.milestoneId &&
      projects.find((p) => p.milestones?.some((m) => m.id === input.milestoneId))?.id) ||
    input.projectId;
  const project = projectId ? projects.find((p) => p.id === projectId) : null;
  const userId = defaultAssigneeFor(bootstrap.workspace?.settings?.defaultAssigneeId, project);
  const member = userId ? bootstrap.members?.find((m) => m.id === userId) : undefined;
  if (!member) return null;
  const canWork =
    isAdminRole(member.role) ||
    team.memberIds?.includes(member.id) ||
    (member.role === 'member' && !team.private);
  return canWork ? member.id : null;
}

/** What a new issue looks like until the server numbers it. */
function draftIssue(
  input: CreateIssueInput & { id: string },
  bootstrap: Bootstrap | null,
  at: string,
): Issue {
  const team = bootstrap?.teams.find((t) => t.id === input.teamId);
  const state = input.stateId
    ? team?.states?.find((s) => s.id === input.stateId)
    : defaultState(team);
  const stateId = input.stateId ?? state?.id ?? '';
  return {
    id: input.id,
    identifier: `${team?.key ?? '?'}-…`,
    number: 0,
    teamId: input.teamId,
    title: input.title,
    description: input.description ?? '',
    stateId,
    priority: input.priority ?? 0,
    assigneeId: guessAssignee(input, team, state?.type, bootstrap),
    creatorId: null,
    projectId: input.projectId ?? null,
    milestoneId: input.milestoneId ?? null,
    cycleId: input.cycleId ?? null,
    releaseId: input.releaseId ?? null,
    parentId: input.parentId ?? null,
    estimate: input.estimate ?? null,
    dueDate: input.dueDate ?? null,
    // New issues go to the top of their column, as the server puts them.
    sortOrder: input.sortOrder ?? Number.MIN_SAFE_INTEGER,
    labelIds: input.labelIds ?? [],
    customFields: Object.fromEntries(
      Object.entries(input.customFields ?? {}).filter(
        (e): e is [string, CustomFieldValue] => e[1] !== null,
      ),
    ),
    subIssueCount: 0,
    completedSubIssueCount: 0,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    slaBreachesAt: null,
    archivedAt: null,
  };
}

/** An issue in another team, as the server will move it (the number comes from the server). */
function moveIssue(issue: Issue, teamId: string, bootstrap: Bootstrap | null, now: string): Issue {
  if (issue.teamId === teamId) return issue;
  const team = bootstrap?.teams.find((t) => t.id === teamId);
  const type = bootstrap?.teams
    .find((t) => t.id === issue.teamId)
    ?.states?.find((s) => s.id === issue.stateId)?.type;
  const states = [...(team?.states ?? [])].sort((a, b) => a.position - b.position);
  const labelTeam = new Map(bootstrap?.labels.map((l) => [l.id, l.teamId]));
  const fieldTeam = new Map(bootstrap?.customFields?.map((f) => [f.id, f.teamId]));
  return {
    ...issue,
    teamId,
    stateId: states.find((s) => s.type === type)?.id ?? defaultState(team)?.id ?? issue.stateId,
    // Cleared even when it lands in a started status: cycle automation doesn't apply to moves.
    cycleId: null,
    // Team-scoped labels and fields from the old team no longer apply.
    labelIds: issue.labelIds.filter((id) => {
      const owner = labelTeam.get(id);
      return !owner || owner === teamId;
    }),
    customFields: Object.fromEntries(
      Object.entries(issue.customFields ?? {}).filter(([id]) => {
        const owner = fieldTeam.get(id);
        return !owner || owner === teamId;
      }),
    ),
    updatedAt: now,
  };
}

type IssueOp = Extract<Op, { ids: string[] }>;

/** One pending operation on one of its issues; trashing marks the issue deleted. */
function applyOp(issue: Issue, op: IssueOp, queuedAt: string, bootstrap: Bootstrap | null): Issue {
  switch (op.kind) {
    case 'issue.update':
      return patchIssue(issue, op.patch, queuedAt);
    case 'issue.move':
      return moveIssue(issue, op.teamId, bootstrap, queuedAt);
    case 'issue.trash':
      return { ...issue, deletedAt: issue.deletedAt ?? queuedAt };
    case 'issue.restore':
      return { ...issue, deletedAt: null };
  }
}

/**
 * The server's issues with pending operations applied on top. `gone` holds issues already out of
 * `base` (a trash that was sent) that a pending restore can bring back.
 */
export function overlayIssues(
  base: ReadonlyMap<string, Issue>,
  pending: readonly PendingOp[],
  bootstrap: Bootstrap | null,
  userId: string,
  gone: ReadonlyMap<string, Issue> = new Map(),
): Map<string, Issue> {
  const out = new Map(base);
  // Trashed here or before, so restoring them (Undo while offline) brings them back.
  const trashed = new Map(gone);
  for (const { op, queuedAt, error } of pending) {
    if (error) continue;
    if (op.kind === 'issue.create') {
      if (!out.has(op.issue.id))
        out.set(op.issue.id, { ...draftIssue(op.issue, bootstrap, queuedAt), creatorId: userId });
    } else if ('ids' in op) {
      for (const id of op.ids) {
        const issue = out.get(id) ?? (op.kind === 'issue.restore' ? trashed.get(id) : undefined);
        if (!issue) continue;
        const next = applyOp(issue, op, queuedAt, bootstrap);
        if (next.deletedAt && !issue.deletedAt) {
          out.delete(id);
          trashed.set(id, next);
        } else {
          out.set(id, next);
          trashed.delete(id);
        }
      }
    }
  }
  return out;
}

/**
 * One issue from the server (its page, say) with pending operations applied on top. Trashed
 * here, it shows as in the trash rather than going away.
 */
export function overlayIssue<T extends Issue>(
  issue: T,
  pending: readonly PendingOp[],
  bootstrap: Bootstrap | null,
): T {
  let out: T = issue;
  for (const { op, queuedAt, error } of pending)
    if (!error && 'ids' in op && op.ids.includes(issue.id))
      out = { ...out, ...applyOp(out, op, queuedAt, bootstrap) };
  return out;
}

// ─── comments ────────────────────────────────────────────────────────────

/** An issue's comments with pending operations applied on top, oldest first. */
export function overlayComments(
  issueId: string,
  base: readonly Comment[],
  pending: readonly PendingOp[],
  userId: string,
): Comment[] {
  const out = new Map(base.map((c) => [c.id, c]));
  for (const { op, queuedAt, error } of pending) {
    if (error) continue;
    if (op.kind === 'comment.create' && op.comment.issueId === issueId && !out.has(op.comment.id))
      out.set(op.comment.id, {
        ...op.comment,
        authorId: userId,
        createdAt: queuedAt,
        updatedAt: queuedAt,
        editedAt: null,
        reactions: [],
      });
    else if (op.kind === 'comment.update' && op.issueId === issueId) {
      const c = out.get(op.id);
      if (c) out.set(op.id, { ...c, body: op.body, editedAt: queuedAt, updatedAt: queuedAt });
    } else if (op.kind === 'comment.delete' && op.issueId === issueId) out.delete(op.id);
    else if (op.kind === 'reaction' && op.issueId === issueId) {
      const c = out.get(op.commentId);
      if (c)
        out.set(c.id, { ...c, reactions: toggleReaction(c.reactions, op.emoji, userId, op.on) });
    }
  }
  return [...out.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
