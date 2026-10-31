import {
  DATE_FILTER_FIELDS,
  type DateFilter,
  dayInZone,
  type FilterClock,
  filterClock,
  filterValues,
  type Issue,
  type IssueConditions,
  type IssueFilter,
  matchesFieldFilter,
  rangeDays,
  SERVER_ONLY_FILTERS,
  type StateType,
} from '@ordo/shared';

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
  /** Now, for relative dates (default: the real now). */
  now?: Date;
}

/**
 * Whether the local copy can answer this filter. Full-text search reads comments, "subscribed
 * by me" needs subscribers, relation and pull request filters need what the copy doesn't keep,
 * and the copy keeps no trashed or archived issues.
 */
export const matchesLocally = (f: IssueFilter) =>
  !f.trashed &&
  !f.archived &&
  !f.subscribedBy &&
  !f.q?.trim() &&
  SERVER_ONLY_FILTERS.every((key) => filterValues(f, key).length === 0);

const among = (value: string | null, wanted: string[], me?: string) => {
  const ids = wanted.map((v) => (v === 'me' ? me : v));
  return value === null ? wanted.includes('none') : ids.includes(value);
};

const OPEN = (type: StateType | undefined) => type !== 'completed' && type !== 'canceled';

interface Env {
  ctx: MatchContext;
  clock: FilterClock;
  tz: string;
}

function matchDate(
  issue: Issue,
  field: (typeof DATE_FILTER_FIELDS)[number],
  d: DateFilter,
  env: Env,
) {
  const raw = issue[field];
  if (d.range === 'none') return raw === null;
  if (raw === null) return false;
  // Timestamps count on the day they fall on in the filter's zone, as the server does.
  const day = field === 'dueDate' ? raw : dayInZone(env.tz, new Date(raw));
  if (d.range && d.range !== 'any') {
    if (d.range === 'overdue' && !OPEN(env.ctx.stateType(issue.stateId))) return false;
    const { from, to } = rangeDays(d.range, env.clock);
    if ((from && day < from) || (to && day > to)) return false;
  }
  if (d.from && day < d.from) return false;
  if (d.to && day > d.to) return false;
  return true;
}

/** One result per condition set in `c`, so `exclude` can negate them one at a time. */
function parts(issue: Issue, c: IssueConditions, env: Env): boolean[] {
  const { ctx } = env;
  const out: boolean[] = [];
  if (c.stateIds?.length) out.push(c.stateIds.includes(issue.stateId));
  if (c.stateTypes?.length) {
    const type = ctx.stateType(issue.stateId);
    out.push(!!type && c.stateTypes.includes(type));
  }
  if (c.priorities?.length) out.push(c.priorities.includes(issue.priority));
  if (c.assigneeIds?.length) out.push(among(issue.assigneeId, c.assigneeIds, ctx.userId));
  if (c.projectIds?.length) out.push(among(issue.projectId, c.projectIds));
  if (c.milestoneIds?.length) out.push(among(issue.milestoneId, c.milestoneIds));
  if (c.cycleIds?.length) out.push(among(issue.cycleId, c.cycleIds));
  if (c.creatorIds?.length) {
    const creators = c.creatorIds.map((v) => (v === 'me' ? ctx.userId : v));
    out.push(!!issue.creatorId && creators.includes(issue.creatorId));
  }
  if (c.labelIds?.length) out.push(issue.labelIds.some((l) => c.labelIds!.includes(l)));
  for (const [fieldId, wanted] of Object.entries(c.customFields ?? {})) {
    out.push(matchesFieldFilter(issue.customFields?.[fieldId], wanted, ctx.userId));
  }
  for (const field of DATE_FILTER_FIELDS) {
    const d = c[field];
    if (d) out.push(matchDate(issue, field, d, env));
  }
  if (c.estimate) {
    const { none, min, max } = c.estimate;
    const e = issue.estimate;
    const bounded = min !== undefined || max !== undefined;
    out.push(
      e === null
        ? !!none
        : bounded
          ? (min === undefined || e >= min) && (max === undefined || e <= max)
          : !none,
    );
  }
  if (c.hasSubIssues !== undefined) out.push(issue.subIssueCount > 0 === c.hasSubIssues);
  if (c.isSubIssue !== undefined) out.push(!!issue.parentId === c.isSubIssue);
  // `matchesLocally` keeps blocked, blocking and hasPullRequest on the server.
  if (c.exclude) out.push(parts(issue, c.exclude, env).every((p) => !p));
  if (c.or?.length) out.push(c.or.some((g) => parts(issue, g, env).every(Boolean)));
  return out;
}

export function matchIssue(issue: Issue, f: IssueFilter, ctx: MatchContext): boolean {
  if (f.trashed ? !issue.deletedAt : !!issue.deletedAt) return false;
  if (f.archived === 'only' && !issue.archivedAt) return false;
  if (f.archived !== 'only' && f.archived !== 'include' && !f.trashed && issue.archivedAt)
    return false;
  if (f.teamId && issue.teamId !== f.teamId) return false;
  if (f.parentId && issue.parentId !== f.parentId) return false;
  const tz = f.tz ?? 'UTC';
  const env = { ctx, tz, clock: filterClock(tz, f.weekStartsOn, ctx.now) };
  return parts(issue, f, env).every(Boolean);
}
