import { type Issue, type IssueFilter, matchesFieldFilter, type StateType } from '@ordo/shared';

/**
 * The server's issue filter (`filterConditions` in the API), on the client: sync clients answer
 * list queries from their own copy with it. A parity test in the API runs random filters through
 * both and expects the same issues.
 */

export interface MatchContext {
  /** Who "me" is in assignee and creator filters. */
  userId: string;
  /** A workflow state's type, for `stateTypes`. */
  stateType: (stateId: string) => StateType | undefined;
}

/**
 * Whether the local copy can answer this filter. Full-text search reads comments, "subscribed
 * by me" needs subscribers, and the copy keeps no trashed or archived issues.
 */
export const matchesLocally = (f: IssueFilter) =>
  !f.trashed && !f.archived && !f.subscribedBy && !f.q?.trim();

const among = (value: string | null, wanted: string[] | undefined, me?: string) => {
  if (!wanted?.length) return true;
  const ids = wanted.map((v) => (v === 'me' ? me : v));
  return value === null ? wanted.includes('none') : ids.includes(value);
};

export function matchIssue(issue: Issue, f: IssueFilter, ctx: MatchContext): boolean {
  if (f.trashed ? !issue.deletedAt : !!issue.deletedAt) return false;
  if (f.archived === 'only' && !issue.archivedAt) return false;
  if (f.archived !== 'only' && f.archived !== 'include' && !f.trashed && issue.archivedAt)
    return false;
  if (f.teamId && issue.teamId !== f.teamId) return false;
  if (f.stateIds?.length && !f.stateIds.includes(issue.stateId)) return false;
  if (f.stateTypes?.length) {
    const type = ctx.stateType(issue.stateId);
    if (!type || !f.stateTypes.includes(type)) return false;
  }
  if (f.priorities?.length && !f.priorities.includes(issue.priority)) return false;
  if (!among(issue.assigneeId, f.assigneeIds, ctx.userId)) return false;
  if (!among(issue.projectId, f.projectIds)) return false;
  if (!among(issue.milestoneId, f.milestoneIds)) return false;
  if (!among(issue.cycleId, f.cycleIds)) return false;
  if (f.creatorIds?.length) {
    const creators = f.creatorIds.map((v) => (v === 'me' ? ctx.userId : v));
    if (!issue.creatorId || !creators.includes(issue.creatorId)) return false;
  }
  if (f.labelIds?.length && !issue.labelIds.some((l) => f.labelIds!.includes(l))) return false;
  for (const [fieldId, wanted] of Object.entries(f.customFields ?? {})) {
    if (!matchesFieldFilter(issue.customFields?.[fieldId], wanted, ctx.userId)) return false;
  }
  if (f.parentId && issue.parentId !== f.parentId) return false;
  return true;
}
