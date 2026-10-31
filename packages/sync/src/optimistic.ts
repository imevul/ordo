import type { CommentReaction, Issue, UpdateIssueInput } from '@ordo/shared';

/**
 * How a change looks before the server confirms it. Shared by the local copy's pending operations
 * and the web app's React Query caches, so both show the same thing.
 */

/**
 * An issue with `patch` applied as of `now`. A team move is left to the server, which renumbers
 * the issue and maps its status onto the new team's workflow; state timestamps are its job too.
 */
export function patchIssue(issue: Issue, patch: UpdateIssueInput, now: string): Issue {
  const next = { ...issue } as Issue & Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === 'addLabelIds' || k === 'removeLabelIds' || k === 'teamId')
      continue;
    next[k] = v;
  }
  if (patch.addLabelIds) next.labelIds = [...new Set([...next.labelIds, ...patch.addLabelIds])];
  if (patch.removeLabelIds)
    next.labelIds = next.labelIds.filter((l) => !patch.removeLabelIds!.includes(l));
  next.updatedAt = now;
  return next;
}

/** A comment's reactions with `userId`'s `emoji` added (`on`) or removed. */
export function toggleReaction(
  reactions: readonly CommentReaction[],
  emoji: string,
  userId: string,
  on: boolean,
): CommentReaction[] {
  const rest = reactions.map((r) =>
    r.emoji === emoji ? { ...r, userIds: r.userIds.filter((u) => u !== userId) } : r,
  );
  const next = on
    ? rest.some((r) => r.emoji === emoji)
      ? rest.map((r) => (r.emoji === emoji ? { ...r, userIds: [...r.userIds, userId] } : r))
      : [...rest, { emoji, userIds: [userId] }]
    : rest;
  return next.filter((r) => r.userIds.length > 0);
}
