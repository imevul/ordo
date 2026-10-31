import type { Bootstrap, Comment, CreateIssueInput, Issue, UpdateIssueInput } from '@ordo/shared';
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

/** What a new issue looks like until the server numbers it. */
function draftIssue(
  input: CreateIssueInput & { id: string },
  bootstrap: Bootstrap | null,
  at: string,
): Issue {
  const team = bootstrap?.teams.find((t) => t.id === input.teamId);
  const stateId =
    input.stateId ??
    team?.defaultStateId ??
    team?.states?.find((s) => s.type === 'backlog')?.id ??
    team?.states?.[0]?.id ??
    '';
  return {
    id: input.id,
    identifier: `${team?.key ?? '?'}-…`,
    number: 0,
    teamId: input.teamId,
    title: input.title,
    description: input.description ?? '',
    stateId,
    priority: input.priority ?? 0,
    assigneeId: input.assigneeId ?? null,
    creatorId: null,
    projectId: input.projectId ?? null,
    milestoneId: input.milestoneId ?? null,
    cycleId: input.cycleId ?? null,
    parentId: input.parentId ?? null,
    estimate: input.estimate ?? null,
    dueDate: input.dueDate ?? null,
    // New issues go to the top of their column, as the server puts them.
    sortOrder: input.sortOrder ?? Number.MIN_SAFE_INTEGER,
    labelIds: input.labelIds ?? [],
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

/** The server's issues with pending operations applied on top. */
export function overlayIssues(
  base: ReadonlyMap<string, Issue>,
  pending: readonly PendingOp[],
  bootstrap: Bootstrap | null,
  userId: string,
): Map<string, Issue> {
  const out = new Map(base);
  for (const { op, queuedAt, error } of pending) {
    if (error) continue;
    if (op.kind === 'issue.create') {
      if (!out.has(op.issue.id))
        out.set(op.issue.id, { ...draftIssue(op.issue, bootstrap, queuedAt), creatorId: userId });
    } else if (op.kind === 'issue.update') {
      for (const id of op.ids) {
        const issue = out.get(id);
        if (issue) out.set(id, patchIssue(issue, op.patch, queuedAt));
      }
    } else if (op.kind === 'issue.trash') for (const id of op.ids) out.delete(id);
  }
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
