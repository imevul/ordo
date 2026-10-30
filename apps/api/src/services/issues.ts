import {
  type CreateIssueInput,
  defaultAssigneeFor,
  type HistoryChange,
  ISSUE_IDENTIFIER_PATTERN,
  type Issue,
  type IssueDetail,
  type IssueFilter,
  type IssueRef,
  type IssueRelation,
  type SlaHours,
  SORT_GAP,
  type StateType,
  type UpdateIssueInput,
} from '@ordo/shared';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client.ts';
import {
  type comments,
  cycles,
  issueHistory,
  issueLabels,
  issueRelations,
  issueSubscribers,
  issues,
  labels,
  projectMilestones,
  projects,
  teamKeyAliases,
  teams,
  workflowStates,
  workspaces,
} from '../db/schema.ts';
import { badRequest, conflict, notFound, one } from '../lib/errors.ts';
import {
  type Access,
  assertTeamAccess,
  canReadTeam,
  teamScope,
  usersWithTeamAccess,
} from './access.ts';
import { onAssigneeChanged } from './agents.ts';
import { claimAttachments, listAttachments } from './attachments.ts';
import { type Ctx, emit, record } from './context.ts';
import { requestsOnIssue } from './customers.ts';
import { cycleForStartedIssue } from './cycle-automation.ts';
import { listIssueLinks } from './links.ts';
import { notify, subscribe, subscriberIds } from './notifications.ts';
import { isWorkspacePlaceholder } from './placeholders.ts';
import { anyWordQuery, matchingIssueIds, textQuery, textRank } from './search.ts';
import { toProject } from './serialize.ts';
import { applyTriageRules } from './triage.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Correlated subqueries name the outer table explicitly ("issues"."id"): Drizzle leaves columns
// unqualified in single-table selects, and a bare "id" would bind to the subquery's own table.
const issueSelect = {
  ...getTableColumns(issues),
  teamKey: teams.key,
  labelIds: sql<
    string[]
  >`coalesce((select array_agg(il.label_id::text) from issue_labels il where il.issue_id = "issues"."id"), '{}')`,
  subIssueCount: sql<number>`(select count(*)::int from issues c where c.parent_id = "issues"."id" and c.deleted_at is null)`,
  completedSubIssueCount: sql<number>`(select count(*)::int from issues c join workflow_states cs on cs.id = c.state_id where c.parent_id = "issues"."id" and c.deleted_at is null and cs.type in ('completed', 'canceled'))`,
};

type IssueRow = typeof issues.$inferSelect & {
  teamKey: string;
  labelIds: string[];
  subIssueCount: number;
  completedSubIssueCount: number;
};

export function toIssue(r: IssueRow): Issue {
  return {
    id: r.id,
    identifier: `${r.teamKey}-${r.number}`,
    number: r.number,
    teamId: r.teamId,
    title: r.title,
    description: r.description,
    stateId: r.stateId,
    priority: r.priority,
    assigneeId: r.assigneeId,
    creatorId: r.creatorId,
    projectId: r.projectId,
    milestoneId: r.milestoneId,
    cycleId: r.cycleId,
    parentId: r.parentId,
    estimate: r.estimate,
    dueDate: r.dueDate,
    sortOrder: r.sortOrder,
    labelIds: r.labelIds ?? [],
    subIssueCount: r.subIssueCount,
    completedSubIssueCount: r.completedSubIssueCount,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    canceledAt: r.canceledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
    slaBreachesAt: r.slaBreachesAt,
    archivedAt: r.archivedAt,
  };
}

function baseQuery(db: DbOrTx) {
  return db.select(issueSelect).from(issues).innerJoin(teams, eq(teams.id, issues.teamId));
}

/** Translates an IssueFilter into SQL conditions, limited to teams `access` can read. `me` is the viewer. */
export function filterConditions(access: Access, f: IssueFilter): SQL[] {
  const userId = access.userId;
  const me = (v: string) => (v === 'me' ? userId : v);
  const conds: SQL[] = [eq(issues.workspaceId, access.workspaceId)];
  const scope = teamScope(access, issues.teamId);
  if (scope) conds.push(scope);
  conds.push(f.trashed ? isNotNull(issues.deletedAt) : isNull(issues.deletedAt));
  // The trash shows everything that's in it, archived or not.
  if (f.archived === 'only') conds.push(isNotNull(issues.archivedAt));
  else if (f.archived !== 'include' && !f.trashed) conds.push(isNull(issues.archivedAt));
  if (f.teamId) conds.push(eq(issues.teamId, f.teamId));
  if (f.stateIds?.length) conds.push(inArray(issues.stateId, f.stateIds));
  if (f.stateTypes?.length) {
    conds.push(
      inArray(
        issues.stateId,
        sql`(select ws.id from workflow_states ws where ws.type in (${sql.join(
          f.stateTypes.map((t) => sql`${t}`),
          sql`, `,
        )}))`,
      ),
    );
  }
  if (f.priorities?.length) conds.push(inArray(issues.priority, f.priorities));
  const nullable = (
    col:
      | typeof issues.assigneeId
      | typeof issues.projectId
      | typeof issues.milestoneId
      | typeof issues.cycleId,
    values: string[] | undefined,
    mapper = (v: string) => v,
  ) => {
    if (!values?.length) return;
    const ids = values.filter((v) => v !== 'none').map(mapper);
    const parts: SQL[] = [];
    if (ids.length) parts.push(inArray(col, ids));
    if (values.includes('none')) parts.push(isNull(col));
    conds.push(parts.length === 1 ? parts[0]! : or(...parts)!);
  };
  nullable(issues.assigneeId, f.assigneeIds, me);
  nullable(issues.projectId, f.projectIds);
  nullable(issues.milestoneId, f.milestoneIds);
  nullable(issues.cycleId, f.cycleIds);
  if (f.creatorIds?.length) conds.push(inArray(issues.creatorId, f.creatorIds.map(me)));
  if (f.labelIds?.length) {
    conds.push(
      exists(
        sql`(select 1 from issue_labels fl where fl.issue_id = "issues"."id" and fl.label_id in (${sql.join(
          f.labelIds.map((l) => sql`${l}`),
          sql`, `,
        )}))`,
      ),
    );
  }
  if (f.parentId) conds.push(eq(issues.parentId, f.parentId));
  if (f.subscribedBy === 'me') {
    conds.push(
      exists(
        sql`(select 1 from issue_subscribers su where su.issue_id = "issues"."id" and su.user_id = ${userId})`,
      ),
    );
  }
  if (f.q?.trim()) conds.push(textConditions(f.q.trim()).match);
  return conds;
}

/**
 * Text search: an identifier (ENG-12), or words in the title, description or comments (full
 * text, as prefixes). `rank` orders matches by relevance.
 */
function textConditions(q: string) {
  const m = ISSUE_IDENTIFIER_PATTERN.exec(q.toUpperCase());
  const query = textQuery(q);
  const lookups: SQL[] = [];
  if (m) {
    lookups.push(
      sql`select i.id from issues i join teams t on t.id = i.team_id where t.key = ${m[1]!} and i.number = ${Number(m[2])}`,
    );
  }
  if (query) lookups.push(matchingIssueIds(query));
  const match = lookups.length
    ? sql`"issues"."id" in (${sql.join(lookups, sql` union `)})`
    : sql`false`;
  const identifier = m ? and(eq(teams.key, m[1]!), eq(issues.number, Number(m[2])))! : sql`false`;
  const rank = sql`(case when ${identifier} then 10 else 0 end)${query ? sql` + ${textRank(query)}` : sql``}`;
  return { match, rank };
}

export async function queryIssues(
  db: DbOrTx,
  access: Access,
  filter: IssueFilter,
  limit = 2000,
  order: 'manual' | 'recent' | 'priority' | 'relevance' = 'manual',
): Promise<Issue[]> {
  const q = filter.q?.trim();
  const orderBy =
    order === 'relevance' && q
      ? [desc(textConditions(q).rank), desc(issues.updatedAt)]
      : order === 'recent'
        ? [desc(issues.updatedAt)]
        : order === 'priority'
          ? // Urgent first, "no priority" last.
            [
              sql`case when ${issues.priority} = 0 then 5 else ${issues.priority} end`,
              desc(issues.updatedAt),
            ]
          : [asc(issues.sortOrder), desc(issues.createdAt)];
  const rows = await baseQuery(db)
    .where(and(...filterConditions(access, filter)))
    .orderBy(...orderBy)
    .limit(limit);
  return rows.map(toIssue);
}

/**
 * Open issues sharing telling words with `text`, best match first: the candidates when looking
 * for duplicates of an issue (`excludeId`) or of one about to be written.
 */
export async function similarIssues(
  db: DbOrTx,
  access: Access,
  text: string,
  excludeId: string | null,
  limit = 15,
): Promise<Issue[]> {
  const query = anyWordQuery(text);
  if (!query) return [];
  const rows = await baseQuery(db)
    .where(
      and(
        ...filterConditions(access, { stateTypes: ['triage', 'backlog', 'unstarted', 'started'] }),
        sql`"issues"."id" in (${matchingIssueIds(query)})`,
        excludeId ? ne(issues.id, excludeId) : undefined,
      ),
    )
    .orderBy(desc(textRank(query)), desc(issues.updatedAt))
    .limit(limit);
  return rows.map(toIssue);
}

/**
 * One page of matching issues in id order, after the id `after` (null for the first page). Pages
 * are how clients load views of any size; they sort and group on their side.
 */
export async function queryIssuePage(
  db: DbOrTx,
  access: Access,
  filter: IssueFilter,
  after: string | null,
  limit: number,
): Promise<Issue[]> {
  const rows = await baseQuery(db)
    .where(and(...filterConditions(access, filter), after ? gt(issues.id, after) : undefined))
    .orderBy(asc(issues.id))
    .limit(limit);
  return rows.map(toIssue);
}

/**
 * The given issues as `access` may see them: in readable teams, not trashed or archived. Sync
 * clients treat the ones missing from the answer as gone.
 */
export async function issuesByIds(db: DbOrTx, access: Access, ids: string[]): Promise<Issue[]> {
  if (!ids.length) return [];
  const rows = await baseQuery(db).where(
    and(...filterConditions(access, {}), inArray(issues.id, ids)),
  );
  return rows.map(toIssue);
}

/** Every issue of a workspace, trashed ones too, a page at a time in id order (for exports). */
export async function workspaceIssuePage(
  db: DbOrTx,
  workspaceId: string,
  after: string | null,
  limit: number,
): Promise<Issue[]> {
  const rows = await baseQuery(db)
    .where(and(eq(issues.workspaceId, workspaceId), after ? gt(issues.id, after) : undefined))
    .orderBy(asc(issues.id))
    .limit(limit);
  return rows.map(toIssue);
}

/** One issue by id or identifier; "not found" if it's outside the teams `access` can read. */
export async function getIssue(db: DbOrTx, access: Access, idOrIdentifier: string): Promise<Issue> {
  let where: SQL | undefined;
  if (UUID_RE.test(idOrIdentifier)) where = eq(issues.id, idOrIdentifier);
  else {
    const m = ISSUE_IDENTIFIER_PATTERN.exec(idOrIdentifier.toUpperCase());
    if (!m) throw notFound('Issue');
    where = and(
      eq(issues.number, Number(m[2])),
      // Former keys keep old identifiers working after a team is renamed.
      or(
        eq(teams.key, m[1]!),
        inArray(
          issues.teamId,
          db
            .select({ id: teamKeyAliases.teamId })
            .from(teamKeyAliases)
            .where(
              and(
                eq(teamKeyAliases.workspaceId, access.workspaceId),
                eq(teamKeyAliases.key, m[1]!),
              ),
            ),
        ),
      ),
    );
  }
  const [row] = await baseQuery(db).where(
    and(eq(issues.workspaceId, access.workspaceId), teamScope(access, issues.teamId), where),
  );
  if (!row) throw notFound('Issue');
  return toIssue(row);
}

const refSelect = {
  id: issues.id,
  number: issues.number,
  title: issues.title,
  stateId: issues.stateId,
  teamId: issues.teamId,
  teamKey: teams.key,
};

const toRef = (r: {
  id: string;
  number: number;
  title: string;
  stateId: string;
  teamId: string;
  teamKey: string;
}): IssueRef => ({
  id: r.id,
  identifier: `${r.teamKey}-${r.number}`,
  title: r.title,
  stateId: r.stateId,
  teamId: r.teamId,
});

export async function getIssueDetail(
  db: DbOrTx,
  access: Access,
  idOrIdentifier: string,
): Promise<IssueDetail> {
  const issue = await getIssue(db, access, idOrIdentifier);
  // References to issues in teams the viewer can't read are left out.
  const visible = teamScope(access, issues.teamId);
  const [parentRows, subIssues, outgoing, incoming, subs] = await Promise.all([
    issue.parentId
      ? db
          .select(refSelect)
          .from(issues)
          .innerJoin(teams, eq(teams.id, issues.teamId))
          .where(and(eq(issues.id, issue.parentId), visible))
      : Promise.resolve([]),
    queryIssues(db, access, { parentId: issue.id }),
    db
      .select({ relId: issueRelations.id, type: issueRelations.type, ...refSelect })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.relatedIssueId))
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(and(eq(issueRelations.issueId, issue.id), isNull(issues.deletedAt), visible)),
    db
      .select({ relId: issueRelations.id, type: issueRelations.type, ...refSelect })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(and(eq(issueRelations.relatedIssueId, issue.id), isNull(issues.deletedAt), visible)),
    db
      .select({ userId: issueSubscribers.userId })
      .from(issueSubscribers)
      .where(eq(issueSubscribers.issueId, issue.id)),
  ]);
  const relations: IssueRelation[] = [
    ...outgoing.map((r) => ({
      id: r.relId,
      type:
        r.type === 'blocks'
          ? ('blocks' as const)
          : r.type === 'duplicate'
            ? ('duplicate_of' as const)
            : ('related' as const),
      issue: toRef(r),
    })),
    ...incoming.map((r) => ({
      id: r.relId,
      type:
        r.type === 'blocks'
          ? ('blocked_by' as const)
          : r.type === 'duplicate'
            ? ('duplicated_by' as const)
            : ('related' as const),
      issue: toRef(r),
    })),
  ];
  return {
    ...issue,
    parent: parentRows[0] ? toRef(parentRows[0]) : null,
    subIssues,
    relations,
    subscriberIds: subs.map((s) => s.userId),
    links: await listIssueLinks(db, issue.id),
    attachments: await listAttachments(db, issue.id),
    customerRequests: await requestsOnIssue(db, access, issue.id),
  };
}

// ─── validation helpers ────────────────────────────────────────────────

async function teamOf(ctx: Ctx, teamId: string) {
  const [team] = await ctx.tx
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!team) throw badRequest('Unknown team').as('unknown_team');
  assertTeamAccess(ctx.access, team.id);
  return team;
}

export async function stateOf(ctx: Ctx, teamId: string, stateId: string) {
  const [state] = await ctx.tx
    .select()
    .from(workflowStates)
    .where(and(eq(workflowStates.id, stateId), eq(workflowStates.teamId, teamId)));
  if (!state) throw badRequest('Status does not belong to this team');
  return state;
}

async function defaultState(ctx: Ctx, team: typeof teams.$inferSelect) {
  const states = await ctx.tx
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.teamId, team.id))
    .orderBy(asc(workflowStates.position));
  const pick =
    states.find((s) => s.id === team.defaultStateId) ??
    states.find((s) => s.type === 'backlog') ??
    states.find((s) => s.type === 'unstarted') ??
    states[0];
  if (!pick) throw badRequest('Team has no workflow states');
  return pick;
}

/** Assignees must be able to see the issue's team; imports may also assign their placeholders. */
/**
 * The default assignee for a new issue in this team and project (the project's choice, else the
 * workspace's), or null when there is none or they can't work in the team.
 */
async function defaultAssignee(ctx: Ctx, teamId: string, projectId: string | null) {
  const [[ws], [project]] = await Promise.all([
    ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)),
    projectId
      ? ctx.tx.select().from(projects).where(eq(projects.id, projectId))
      : Promise.resolve([]),
  ]);
  const userId = defaultAssigneeFor(
    ws?.settings?.defaultAssigneeId,
    project ? toProject(project, []) : null,
  );
  if (!userId) return null;
  const [ok] = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, teamId, [userId]);
  return ok ?? null;
}

export async function assertAssignee(ctx: Ctx, teamId: string, userId: string, imported = false) {
  const [ok] = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, teamId, [userId]);
  if (ok || (imported && (await isWorkspacePlaceholder(ctx.tx, ctx.workspaceId, userId)))) return;
  throw badRequest("Assignee isn't a member of this workspace, or can't access this team");
}

/**
 * The SLA deadline for this priority under the team's hours, as SQL counted from `from` (the
 * issue's creation; in SQL so it matches the stored timestamp exactly), or null without one.
 */
function slaDeadline(hours: SlaHours, priority: number, from: SQL) {
  const h = hours[String(priority) as keyof SlaHours];
  return h ? sql<string>`${from} + make_interval(hours => ${h})` : null;
}

/** A milestone in this workspace; its project comes along. */
async function milestoneOf(ctx: Ctx, milestoneId: string) {
  const [m] = await ctx.tx
    .select({ id: projectMilestones.id, projectId: projectMilestones.projectId })
    .from(projectMilestones)
    .innerJoin(projects, eq(projects.id, projectMilestones.projectId))
    .where(and(eq(projectMilestones.id, milestoneId), eq(projects.workspaceId, ctx.workspaceId)));
  if (!m) throw badRequest('Unknown milestone').as('unknown_milestone');
  return m;
}

/**
 * Keeps an issue's project and milestone consistent: picking a milestone sets its project, and
 * moving to another project drops a milestone that belonged to the old one.
 */
async function projectAndMilestone(
  ctx: Ctx,
  current: { projectId: string | null; milestoneId: string | null },
  projectId: string | null | undefined,
  milestoneId: string | null | undefined,
) {
  if (milestoneId) {
    const m = await milestoneOf(ctx, milestoneId);
    if (projectId !== undefined && projectId !== m.projectId)
      throw badRequest('The milestone belongs to another project');
    return { projectId: m.projectId, milestoneId };
  }
  if (projectId !== undefined && projectId !== current.projectId && current.milestoneId) {
    return { projectId, milestoneId: milestoneId === undefined ? null : milestoneId };
  }
  return { projectId, milestoneId };
}

export async function assertProject(ctx: Ctx, projectId: string) {
  const [p] = await ctx.tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, ctx.workspaceId)));
  if (!p) throw badRequest('Unknown project').as('unknown_project');
}

async function assertCycle(ctx: Ctx, teamId: string, cycleId: string) {
  const [c] = await ctx.tx
    .select({ id: cycles.id })
    .from(cycles)
    .where(and(eq(cycles.id, cycleId), eq(cycles.teamId, teamId)));
  if (!c) throw badRequest('Cycle does not belong to this team');
}

export async function assertLabels(ctx: Ctx, teamId: string | null, labelIds: string[]) {
  if (labelIds.length === 0) return;
  const rows = await ctx.tx
    .select({ id: labels.id, teamId: labels.teamId })
    .from(labels)
    .where(and(eq(labels.workspaceId, ctx.workspaceId), inArray(labels.id, labelIds)));
  if (rows.length !== new Set(labelIds).size || rows.some((l) => l.teamId && l.teamId !== teamId)) {
    throw badRequest('Unknown label for this team').as('unknown_label');
  }
}

async function assertParent(ctx: Ctx, issueId: string | null, parentId: string) {
  if (issueId === parentId) throw badRequest('An issue cannot be its own parent').as('own_parent');
  // Walk up from the proposed parent; hitting `issueId` would create a cycle.
  let cursor: string | null = parentId;
  for (let depth = 0; cursor && depth < 50; depth++) {
    const [row] = await ctx.tx
      .select({
        id: issues.id,
        parentId: issues.parentId,
        workspaceId: issues.workspaceId,
        teamId: issues.teamId,
      })
      .from(issues)
      .where(eq(issues.id, cursor));
    if (!row || row.workspaceId !== ctx.workspaceId)
      throw badRequest('Unknown parent issue').as('unknown_parent');
    // The parent itself must be visible; ancestors beyond it are only walked to detect loops.
    if (depth === 0 && !canReadTeam(ctx.access, row.teamId))
      throw badRequest('Unknown parent issue').as('unknown_parent');
    if (issueId && row.parentId === issueId)
      throw badRequest('That would create a sub-issue loop').as('sub_issue_loop');
    cursor = row.parentId;
  }
}

/**
 * Timestamps for entering a status of `type`. Moving between two statuses of the same type (say,
 * Done in one team to Done in another) keeps when it happened: the issue wasn't finished again.
 */
function stateTimestamps(
  type: StateType,
  prev?: { startedAt: string | null; completedAt: string | null; canceledAt: string | null },
) {
  const now = new Date().toISOString();
  return {
    startedAt: type === 'started' || type === 'completed' ? (prev?.startedAt ?? now) : null,
    completedAt: type === 'completed' ? (prev?.completedAt ?? now) : null,
    canceledAt: type === 'canceled' ? (prev?.canceledAt ?? now) : null,
  };
}

async function recordHistory(
  ctx: Ctx,
  issueId: string,
  changes: HistoryChange[],
  at: { actorId?: string | null; createdAt?: string } = {},
) {
  if (changes.length === 0) return;
  await ctx.tx.insert(issueHistory).values({
    issueId,
    actorId: at.actorId === undefined ? ctx.userId : at.actorId,
    changes,
    createdAt: at.createdAt,
  });
}

/** What an import keeps from the source: who made the issue, when things happened, its number. */
export interface ImportedIssueFields {
  creatorId: string | null;
  number?: number;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  canceledAt?: string;
}

/** State timestamps for an imported issue: the source's where it has them, plausible ones if not. */
function importedTimestamps(type: StateType, i: ImportedIssueFields) {
  const now = new Date().toISOString();
  const finished = i.completedAt ?? i.canceledAt ?? i.updatedAt ?? now;
  return {
    startedAt:
      type === 'started' || type === 'completed' ? (i.startedAt ?? i.createdAt ?? now) : null,
    completedAt: type === 'completed' ? (i.completedAt ?? finished) : null,
    canceledAt: type === 'canceled' ? (i.canceledAt ?? finished) : null,
  };
}

// ─── mutations ─────────────────────────────────────────────────────────

/**
 * A create sent again with the id the client chose: true when the caller already made that row
 * (so the retry returns it), 409 when the id belongs to something else.
 */
export async function retriedCreate(
  ctx: Ctx,
  table: typeof issues | typeof comments | typeof issueRelations,
  id: string,
  ownerColumn: AnyPgColumn,
) {
  const [row] = await ctx.tx.select({ owner: ownerColumn }).from(table).where(eq(table.id, id));
  if (!row) return false;
  if (row.owner !== ctx.userId) throw conflict('That id is already in use').as('id_taken');
  return true;
}

/**
 * Creates an issue. Imports pass `imported` to keep the source's creator, timestamps and number;
 * the acting user (the importer) is then neither the creator nor subscribed.
 */
export async function createIssue(
  ctx: Ctx,
  input: CreateIssueInput,
  imported?: ImportedIssueFields,
): Promise<Issue> {
  if (input.id) {
    const retried = await retriedCreate(ctx, issues, input.id, issues.creatorId);
    if (retried) return getIssue(ctx.tx, ctx.access, input.id);
  }
  const team = await teamOf(ctx, input.teamId);
  const state = input.stateId
    ? await stateOf(ctx, team.id, input.stateId)
    : await defaultState(ctx, team);
  if (input.assigneeId) await assertAssignee(ctx, team.id, input.assigneeId, !!imported);
  if (input.projectId) await assertProject(ctx, input.projectId);
  const placed = await projectAndMilestone(
    ctx,
    { projectId: null, milestoneId: null },
    input.projectId,
    input.milestoneId,
  );
  if (input.cycleId) await assertCycle(ctx, team.id, input.cycleId);
  // Leaving the assignee out means "the usual person"; null means nobody. Imports and triage
  // keep what they were given: triage is where someone decides who takes it.
  const assigneeId =
    input.assigneeId !== undefined || imported || state.type === 'triage'
      ? (input.assigneeId ?? null)
      : await defaultAssignee(ctx, team.id, placed.projectId ?? null);
  if (input.parentId) await assertParent(ctx, null, input.parentId);
  const labelIds = [...new Set(input.labelIds ?? [])];
  const cycleId =
    input.cycleId !== undefined || imported || state.type !== 'started'
      ? (input.cycleId ?? null)
      : await cycleForStartedIssue(ctx, team.id);
  await assertLabels(ctx, team.id, labelIds);

  // A kept number moves the counter past it, so later issues don't collide.
  const [{ counter }] = (await ctx.tx
    .update(teams)
    .set({
      issueCounter: imported?.number
        ? sql`greatest(${teams.issueCounter}, ${imported.number})`
        : sql`${teams.issueCounter} + 1`,
    })
    .where(eq(teams.id, team.id))
    .returning({ counter: teams.issueCounter })) as [{ counter: number }];
  const number = imported?.number ?? counter;
  const creatorId = imported ? imported.creatorId : ctx.userId;

  let sortOrder = input.sortOrder;
  if (sortOrder == null) {
    // New issues go to the top of their column.
    const [{ min }] = (await ctx.tx
      .select({ min: sql<number | null>`min(${issues.sortOrder})` })
      .from(issues)
      .where(and(eq(issues.teamId, team.id), eq(issues.stateId, state.id)))) as [
      { min: number | null },
    ];
    sortOrder = min == null ? 0 : min - SORT_GAP;
  }

  const { id } = one(
    await ctx.tx
      .insert(issues)
      .values({
        ...(input.id && { id: input.id }),
        workspaceId: ctx.workspaceId,
        teamId: team.id,
        number,
        title: input.title,
        description: input.description ?? '',
        stateId: state.id,
        priority: input.priority ?? 0,
        assigneeId,
        creatorId,
        projectId: placed.projectId ?? null,
        milestoneId: placed.milestoneId ?? null,
        cycleId,
        parentId: input.parentId ?? null,
        estimate: input.estimate ?? null,
        dueDate: input.dueDate ?? null,
        sortOrder,
        // Imported issues keep their history; an SLA would only mark them breached on arrival.
        slaBreachesAt: imported
          ? null
          : slaDeadline(team.slaHours, input.priority ?? 0, sql`now()`),
        ...(imported
          ? {
              ...importedTimestamps(state.type, imported),
              createdAt: imported.createdAt,
              updatedAt: imported.updatedAt ?? imported.createdAt,
            }
          : stateTimestamps(state.type)),
      })
      .returning({ id: issues.id }),
  );
  await claimAttachments(ctx, id, input.description);
  if (labelIds.length)
    await ctx.tx.insert(issueLabels).values(labelIds.map((labelId) => ({ issueId: id, labelId })));
  await subscribe(ctx, id, [creatorId, assigneeId]);
  await recordHistory(
    ctx,
    id,
    [{ field: 'created', from: null, to: null }],
    imported ? { actorId: creatorId, createdAt: imported.createdAt } : {},
  );
  if (assigneeId) await notify(ctx, { userIds: [assigneeId], type: 'issue_assigned', issueId: id });
  emit(ctx, { kind: 'issue', action: 'created', id, teamId: team.id });
  if (assigneeId && !imported) await onAssigneeChanged(ctx, id, null, assigneeId);
  if (input.parentId)
    emit(ctx, { kind: 'issue', action: 'updated', id: input.parentId, teamId: team.id });
  const created = await getIssue(ctx.tx, ctx.access, id);
  record(ctx, 'issue.created', created, { teamIds: [team.id] });
  if (!imported && state.type === 'triage') {
    await applyTriageRules(ctx, id, team.id);
    return getIssue(ctx.tx, ctx.access, id);
  }
  return created;
}

export async function updateIssue(
  ctx: Ctx,
  issueId: string,
  patch: UpdateIssueInput,
): Promise<Issue> {
  const [current] = await ctx.tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.workspaceId, ctx.workspaceId),
        teamScope(ctx.access, issues.teamId),
      ),
    );
  if (!current) throw notFound('Issue');

  const set: Partial<typeof issues.$inferInsert> = {};
  const changes: HistoryChange[] = [];
  const change = <K extends keyof typeof issues.$inferInsert>(
    field: K,
    historyField: string | null,
    value: (typeof issues.$inferInsert)[K],
  ) => {
    if (value === undefined || value === current[field as keyof typeof current]) return;
    set[field] = value;
    if (historyField)
      changes.push({
        field: historyField,
        from: current[field as keyof typeof current] ?? null,
        to: value ?? null,
      });
  };

  let teamId = current.teamId;
  let stateId = patch.stateId;
  let cycleId = patch.cycleId;

  // Moving to another team: renumber and map the status onto the new team's workflow.
  if (patch.teamId && patch.teamId !== current.teamId) {
    const target = await teamOf(ctx, patch.teamId);
    const [{ counter }] = (await ctx.tx
      .update(teams)
      .set({ issueCounter: sql`${teams.issueCounter} + 1` })
      .where(eq(teams.id, target.id))
      .returning({ counter: teams.issueCounter })) as [{ counter: number }];
    const [oldState] = await ctx.tx
      .select()
      .from(workflowStates)
      .where(eq(workflowStates.id, current.stateId));
    if (!stateId) {
      const candidates = await ctx.tx
        .select()
        .from(workflowStates)
        .where(and(eq(workflowStates.teamId, target.id), eq(workflowStates.type, oldState!.type)))
        .orderBy(asc(workflowStates.position));
      stateId = candidates[0]?.id ?? (await defaultState(ctx, target)).id;
    }
    if (cycleId === undefined) cycleId = null;
    changes.push({ field: 'team', from: current.teamId, to: target.id });
    set.teamId = target.id;
    set.number = counter;
    teamId = target.id;
    // Team-scoped labels from the old team no longer apply.
    await ctx.tx.execute(sql`delete from issue_labels il using labels l
      where il.label_id = l.id and il.issue_id = ${issueId} and l.team_id is not null and l.team_id <> ${target.id}`);
  }

  if (stateId && stateId !== current.stateId) {
    const state = await stateOf(ctx, teamId, stateId);
    set.stateId = state.id;
    Object.assign(set, stateTimestamps(state.type, current));
    changes.push({ field: 'state', from: current.stateId, to: state.id });
    // Cycle automation: work that starts joins the active cycle, unless it's in one already.
    if (state.type === 'started' && cycleId === undefined && !current.cycleId) {
      cycleId = (await cycleForStartedIssue(ctx, teamId)) ?? undefined;
    }
    // Reopening an archived issue brings it back.
    if (current.archivedAt && state.type !== 'completed' && state.type !== 'canceled') {
      set.archivedAt = null;
      changes.push({ field: 'archived', from: true, to: false });
    }
  }

  if (patch.title !== undefined) change('title', 'title', patch.title);
  if (patch.description !== undefined && patch.description !== current.description) {
    set.description = patch.description;
    changes.push({ field: 'description', from: null, to: null });
    await claimAttachments(ctx, issueId, patch.description);
  }
  if (patch.priority !== undefined) change('priority', 'priority', patch.priority);
  // The SLA clock runs from creation; a new priority or team changes the deadline.
  if (set.priority !== undefined || set.teamId !== undefined) {
    const [team] = await ctx.tx
      .select({ slaHours: teams.slaHours })
      .from(teams)
      .where(eq(teams.id, teamId));
    // An SQL expression, which update().set() takes like any value.
    set.slaBreachesAt = slaDeadline(
      team!.slaHours,
      set.priority ?? current.priority,
      sql`"issues"."created_at"`,
    ) as unknown as string | null;
    set.slaNotifiedAt = null;
  }
  if (patch.assigneeId !== undefined) {
    // Re-sending an imported placeholder assignee is fine; choosing one isn't.
    if (patch.assigneeId && patch.assigneeId !== current.assigneeId)
      await assertAssignee(ctx, teamId, patch.assigneeId);
    change('assigneeId', 'assignee', patch.assigneeId);
  }
  const placed = await projectAndMilestone(ctx, current, patch.projectId, patch.milestoneId);
  if (placed.projectId !== undefined) {
    if (placed.projectId) await assertProject(ctx, placed.projectId);
    change('projectId', 'project', placed.projectId);
  }
  if (placed.milestoneId !== undefined) {
    change('milestoneId', 'milestone', placed.milestoneId);
  }
  if (cycleId !== undefined) {
    if (cycleId) await assertCycle(ctx, teamId, cycleId);
    change('cycleId', 'cycle', cycleId);
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId) await assertParent(ctx, issueId, patch.parentId);
    change('parentId', 'parent', patch.parentId);
  }
  if (patch.estimate !== undefined) change('estimate', 'estimate', patch.estimate);
  if (patch.dueDate !== undefined) change('dueDate', 'dueDate', patch.dueDate);
  if (patch.sortOrder !== undefined) change('sortOrder', null, patch.sortOrder);

  // Labels: full replacement, or incremental add/remove (used by bulk edits).
  if (patch.labelIds || patch.addLabelIds || patch.removeLabelIds) {
    const existing = (
      await ctx.tx
        .select({ id: issueLabels.labelId })
        .from(issueLabels)
        .where(eq(issueLabels.issueId, issueId))
    ).map((r) => r.id);
    let next = patch.labelIds ? [...new Set(patch.labelIds)] : [...existing];
    if (patch.addLabelIds) next = [...new Set([...next, ...patch.addLabelIds])];
    if (patch.removeLabelIds) next = next.filter((l) => !patch.removeLabelIds!.includes(l));
    const added = next.filter((l) => !existing.includes(l));
    const removed = existing.filter((l) => !next.includes(l));
    await assertLabels(ctx, teamId, added);
    if (removed.length) {
      await ctx.tx
        .delete(issueLabels)
        .where(and(eq(issueLabels.issueId, issueId), inArray(issueLabels.labelId, removed)));
    }
    if (added.length)
      await ctx.tx.insert(issueLabels).values(added.map((labelId) => ({ issueId, labelId })));
    if (added.length || removed.length) changes.push({ field: 'labels', from: existing, to: next });
  }

  const touched = Object.keys(set).length > 0 || changes.length > 0;
  if (touched) {
    await ctx.tx
      .update(issues)
      .set({ ...set, updatedAt: new Date().toISOString() })
      .where(eq(issues.id, issueId));
    await recordHistory(ctx, issueId, changes);
  }

  // Side effects: subscriptions and notifications.
  if (set.assigneeId !== undefined) {
    await subscribe(ctx, issueId, [set.assigneeId]);
    if (set.assigneeId)
      await notify(ctx, { userIds: [set.assigneeId], type: 'issue_assigned', issueId });
    if (current.assigneeId)
      await notify(ctx, { userIds: [current.assigneeId], type: 'issue_unassigned', issueId });
    await onAssigneeChanged(ctx, issueId, current.assigneeId, set.assigneeId);
  }
  if (set.stateId && set.stateId !== current.stateId) {
    await notify(ctx, {
      userIds: await subscriberIds(ctx, issueId),
      type: 'issue_status_changed',
      issueId,
      data: { from: current.stateId, to: set.stateId },
    });
  }
  if (set.priority === 1) {
    const assignee = set.assigneeId !== undefined ? set.assigneeId : current.assigneeId;
    await notify(ctx, { userIds: [assignee], type: 'issue_priority_urgent', issueId });
  }

  if (touched) {
    const prevTeamId = current.teamId !== teamId ? current.teamId : undefined;
    emit(ctx, { kind: 'issue', action: 'updated', id: issueId, teamId, prevTeamId });
    for (const parent of new Set([current.parentId, set.parentId])) {
      if (parent) emit(ctx, { kind: 'issue', action: 'updated', id: parent, teamId });
    }
  }
  const issue = await getIssue(ctx.tx, ctx.access, issueId);
  // Reordering alone (sort order) isn't news to the outside world.
  if (changes.length)
    record(ctx, 'issue.updated', issue, { teamIds: [current.teamId, teamId], changes });
  return issue;
}

/** What `bulkUpdateIssues` can change: the fields that rewrites of many issues at once touch. */
export interface BulkIssuePatch {
  stateId?: string;
  cycleId?: string | null;
  assigneeId?: string | null;
}

/**
 * Applies one patch to many issues in a few statements: one UPDATE, one batch of history, and an
 * `emit` + `issue.updated` per issue that changed. State timestamps and archive follow
 * `updateIssue`. Meant for rewrites the system does on someone's behalf (deleting a cycle or
 * status, cycle rollover, placeholder merges): it notifies nobody, runs no assignee hooks and does
 * no cycle automation (an issue moved to a started status doesn't join the active cycle), since
 * nobody changed these issues' progress. A person's own edits still go through `updateIssue`.
 * Trashed and archived issues are updated too. Returns the ids that changed.
 */
export async function bulkUpdateIssues(
  ctx: Ctx,
  ids: string[],
  patch: BulkIssuePatch,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await ctx.tx
    .select({
      id: issues.id,
      teamId: issues.teamId,
      stateId: issues.stateId,
      cycleId: issues.cycleId,
      assigneeId: issues.assigneeId,
      parentId: issues.parentId,
      archivedAt: issues.archivedAt,
    })
    .from(issues)
    .where(
      and(
        inArray(issues.id, [...new Set(ids)]),
        eq(issues.workspaceId, ctx.workspaceId),
        teamScope(ctx.access, issues.teamId),
      ),
    );
  if (rows.length === 0) return [];

  // Checked once per team, not per issue. A status belongs to one team, so with `stateId` every
  // issue is in that team (or stateOf throws).
  let state: typeof workflowStates.$inferSelect | undefined;
  for (const teamId of new Set(rows.map((r) => r.teamId))) {
    if (patch.stateId) state = await stateOf(ctx, teamId, patch.stateId);
    if (patch.cycleId) await assertCycle(ctx, teamId, patch.cycleId);
    if (patch.assigneeId) await assertAssignee(ctx, teamId, patch.assigneeId);
  }
  const closed = state?.type === 'completed' || state?.type === 'canceled';

  const changed: { row: (typeof rows)[number]; changes: HistoryChange[] }[] = [];
  for (const row of rows) {
    const changes: HistoryChange[] = [];
    const moves = !!state && row.stateId !== state.id;
    if (moves) {
      changes.push({ field: 'state', from: row.stateId, to: state!.id });
      if (row.archivedAt && !closed) changes.push({ field: 'archived', from: true, to: false });
    }
    if (patch.cycleId !== undefined && patch.cycleId !== row.cycleId)
      changes.push({ field: 'cycle', from: row.cycleId, to: patch.cycleId });
    if (patch.assigneeId !== undefined && patch.assigneeId !== row.assigneeId)
      changes.push({ field: 'assignee', from: row.assigneeId, to: patch.assigneeId });
    if (changes.length) changed.push({ row, changes });
  }
  if (changed.length === 0) return [];
  const changedIds = changed.map((c) => c.row.id);

  // Per-issue values are CASEs on the old row (Postgres evaluates them before the update), so
  // issues already in the target status keep their timestamps.
  const now = new Date().toISOString();
  const set: Record<string, unknown> = { updatedAt: now };
  if (state) {
    const moves = sql`${issues.stateId} <> ${state.id}`;
    const onMove = (value: SQL | null, column: AnyPgColumn) =>
      sql`case when ${moves} then ${value} else ${column} end`;
    const at = sql`${now}::timestamptz`;
    const started = state.type === 'started' || state.type === 'completed';
    set.stateId = state.id;
    set.startedAt = onMove(
      started ? sql`coalesce(${issues.startedAt}, ${at})` : null,
      issues.startedAt,
    );
    set.completedAt = onMove(state.type === 'completed' ? at : null, issues.completedAt);
    set.canceledAt = onMove(state.type === 'canceled' ? at : null, issues.canceledAt);
    if (!closed) set.archivedAt = onMove(null, issues.archivedAt);
  }
  if (patch.cycleId !== undefined) set.cycleId = patch.cycleId;
  if (patch.assigneeId !== undefined) set.assigneeId = patch.assigneeId;
  await ctx.tx.update(issues).set(set).where(inArray(issues.id, changedIds));

  await ctx.tx
    .insert(issueHistory)
    .values(changed.map((c) => ({ issueId: c.row.id, actorId: ctx.userId, changes: c.changes })));
  // The assignee follows what they were given, as with `updateIssue`.
  const assigneeId = patch.assigneeId;
  if (assigneeId)
    await ctx.tx
      .insert(issueSubscribers)
      .values(changedIds.map((issueId) => ({ issueId, userId: assigneeId })))
      .onConflictDoNothing();

  const updated = new Map(
    (await baseQuery(ctx.tx).where(inArray(issues.id, changedIds))).map((r) => [r.id, toIssue(r)]),
  );
  const parents = new Map<string, string>();
  for (const { row, changes } of changed) {
    emit(ctx, { kind: 'issue', action: 'updated', id: row.id, teamId: row.teamId });
    record(ctx, 'issue.updated', updated.get(row.id)!, { teamIds: [row.teamId], changes });
    // A parent counts its finished sub-issues.
    if (row.parentId && changes.some((c) => c.field === 'state'))
      parents.set(row.parentId, row.teamId);
  }
  for (const [id, teamId] of parents) emit(ctx, { kind: 'issue', action: 'updated', id, teamId });
  return changedIds;
}

/**
 * Bookkeeping on issues (the comment-time `updatedAt` bump, SLA announcement marks): sync clients
 * hear about it, but it is no change anyone made, so no history and no `issue.updated` webhook.
 */
export async function touchIssues(
  ctx: Ctx,
  ids: string[],
  set: Pick<Partial<typeof issues.$inferInsert>, 'updatedAt' | 'slaNotifiedAt'>,
) {
  if (ids.length === 0) return;
  const rows = await ctx.tx
    .update(issues)
    .set(set)
    .where(and(inArray(issues.id, ids), eq(issues.workspaceId, ctx.workspaceId)))
    .returning({ id: issues.id, teamId: issues.teamId });
  for (const r of rows) emit(ctx, { kind: 'issue', action: 'updated', id: r.id, teamId: r.teamId });
}

/**
 * Imports link sub-issues once every issue exists (a child can come before its parent). Checked
 * like any parent change, but part of the import rather than a history entry of its own.
 */
export async function setImportedParent(ctx: Ctx, issueId: string, parentId: string) {
  await assertParent(ctx, issueId, parentId);
  const [row] = await ctx.tx
    .update(issues)
    .set({ parentId })
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, ctx.workspaceId)))
    .returning({ teamId: issues.teamId });
  if (row) emit(ctx, { kind: 'issue', action: 'updated', id: issueId, teamId: row.teamId });
}

/** Soft delete: the issue moves to the trash and can be restored. */
/** Archives or unarchives one issue; archived issues leave lists but stay readable. */
export async function setArchived(ctx: Ctx, issueId: string, archived: boolean): Promise<Issue> {
  const issue = await getIssue(ctx.tx, ctx.access, issueId);
  if (!!issue.archivedAt === archived) return issue;
  const archivedAt = archived ? new Date().toISOString() : null;
  await ctx.tx.update(issues).set({ archivedAt }).where(eq(issues.id, issue.id));
  await recordHistory(ctx, issue.id, [{ field: 'archived', from: !archived, to: archived }]);
  emit(ctx, { kind: 'issue', action: 'updated', id: issue.id, teamId: issue.teamId });
  record(
    ctx,
    archived ? 'issue.archived' : 'issue.unarchived',
    { id: issue.id, identifier: issue.identifier, archivedAt },
    { teamIds: [issue.teamId] },
  );
  return { ...issue, archivedAt };
}

/**
 * When a team turns triage off, nobody looks at its triage column any more: the issues waiting
 * there move to the team's default status (or its first backlog one) so they aren't stranded.
 */
export async function releaseTriage(ctx: Ctx, teamId: string) {
  const team = await teamOf(ctx, teamId);
  const states = await ctx.tx
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.teamId, team.id))
    .orderBy(asc(workflowStates.position));
  const open = states.filter((s) => s.type !== 'triage');
  const target =
    open.find((s) => s.id === team.defaultStateId) ??
    open.find((s) => s.type === 'backlog') ??
    open.find((s) => s.type === 'unstarted');
  const triage = states.filter((s) => s.type === 'triage').map((s) => s.id);
  if (!target || triage.length === 0) return 0;
  const waiting = await ctx.tx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(eq(issues.teamId, team.id), inArray(issues.stateId, triage), isNull(issues.deletedAt)),
    );
  const moved = await bulkUpdateIssues(
    ctx,
    waiting.map((i) => i.id),
    { stateId: target.id },
  );
  return moved.length;
}

/**
 * Archives a team's issues that closed (completed or canceled) more than `months` ago, in one
 * statement. Returns how many.
 */
export async function archiveClosedIssues(ctx: Ctx, teamId: string, months: number) {
  const rows = await ctx.tx.execute<{ id: string; number: number; archived_at: string }>(sql`
    update issues set archived_at = now()
    from workflow_states ws
    where ws.id = issues.state_id and issues.team_id = ${teamId}
      and issues.archived_at is null and issues.deleted_at is null
      and ws.type in ('completed', 'canceled')
      and coalesce(issues.completed_at, issues.canceled_at, issues.updated_at)
        < now() - make_interval(months => ${months})
    returning issues.id, issues.number, issues.archived_at`);
  const archived = [...rows];
  if (archived.length === 0) return 0;
  const [team] = await ctx.tx.select({ key: teams.key }).from(teams).where(eq(teams.id, teamId));
  await ctx.tx.insert(issueHistory).values(
    archived.map((r) => ({
      issueId: r.id,
      actorId: ctx.userId,
      changes: [{ field: 'archived', from: false, to: true }],
    })),
  );
  for (const r of archived) {
    emit(ctx, { kind: 'issue', action: 'updated', id: r.id, teamId });
    record(
      ctx,
      'issue.archived',
      { id: r.id, identifier: `${team!.key}-${r.number}`, archivedAt: r.archived_at },
      { teamIds: [teamId] },
    );
  }
  return archived.length;
}

export async function trashIssue(ctx: Ctx, issueId: string, restore = false) {
  const scope = and(
    eq(issues.id, issueId),
    eq(issues.workspaceId, ctx.workspaceId),
    teamScope(ctx.access, issues.teamId),
  );
  // Trashing twice (or restoring what's not in the trash) changes nothing: in particular the
  // trash date stays, so the purge countdown doesn't start over.
  const [row] = await ctx.tx
    .update(issues)
    .set({
      deletedAt: restore ? null : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(and(scope, restore ? isNotNull(issues.deletedAt) : isNull(issues.deletedAt)))
    .returning({ id: issues.id, teamId: issues.teamId, parentId: issues.parentId });
  if (!row) {
    const [found] = await ctx.tx.select({ id: issues.id }).from(issues).where(scope);
    if (!found) throw notFound('Issue');
    return;
  }
  await recordHistory(ctx, issueId, [
    { field: restore ? 'restored' : 'deleted', from: null, to: null },
  ]);
  emit(ctx, {
    kind: 'issue',
    action: restore ? 'updated' : 'deleted',
    id: row.id,
    teamId: row.teamId,
  });
  if (row.parentId)
    emit(ctx, { kind: 'issue', action: 'updated', id: row.parentId, teamId: row.teamId });
  record(
    ctx,
    restore ? 'issue.restored' : 'issue.trashed',
    await getIssue(ctx.tx, ctx.access, row.id),
    {
      teamIds: [row.teamId],
    },
  );
}

export async function purgeIssue(ctx: Ctx, issueId: string) {
  const [row] = await ctx.tx
    .delete(issues)
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.workspaceId, ctx.workspaceId),
        teamScope(ctx.access, issues.teamId),
        isNotNull(issues.deletedAt),
      ),
    )
    .returning({ id: issues.id, teamId: issues.teamId });
  if (!row) throw notFound('Trashed issue');
  // Children keep living as top-level issues.
  const children = await ctx.tx
    .update(issues)
    .set({ parentId: null, updatedAt: new Date().toISOString() })
    .where(eq(issues.parentId, issueId))
    .returning({ id: issues.id, teamId: issues.teamId });
  for (const child of children)
    emit(ctx, { kind: 'issue', action: 'updated', id: child.id, teamId: child.teamId });
  emit(ctx, { kind: 'issue', action: 'deleted', id: row.id, teamId: row.teamId });
  record(ctx, 'issue.deleted', { id: row.id }, { teamIds: [row.teamId] });
}
