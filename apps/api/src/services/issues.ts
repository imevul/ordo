import {
  type CreateIssueInput,
  type HistoryChange,
  ISSUE_IDENTIFIER_PATTERN,
  type Issue,
  type IssueDetail,
  type IssueFilter,
  type IssueRef,
  type IssueRelation,
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
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  cycles,
  issueHistory,
  issueLabels,
  issueRelations,
  issueSubscribers,
  issues,
  labels,
  projects,
  teamKeyAliases,
  teams,
  workflowStates,
} from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import {
  type Access,
  assertTeamAccess,
  canReadTeam,
  teamScope,
  usersWithTeamAccess,
} from './access.ts';
import { claimAttachments, listAttachments } from './attachments.ts';
import { type Ctx, emit, record } from './context.ts';
import { listIssueLinks } from './links.ts';
import { notify, subscribe, subscriberIds } from './notifications.ts';
import { isWorkspacePlaceholder } from './placeholders.ts';
import { matchingIssueIds, textQuery, textRank } from './search.ts';

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
    col: typeof issues.assigneeId | typeof issues.projectId | typeof issues.cycleId,
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
  };
}

// ─── validation helpers ────────────────────────────────────────────────

async function teamOf(ctx: Ctx, teamId: string) {
  const [team] = await ctx.tx
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!team) throw badRequest('Unknown team');
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
export async function assertAssignee(ctx: Ctx, teamId: string, userId: string, imported = false) {
  const [ok] = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, teamId, [userId]);
  if (ok || (imported && (await isWorkspacePlaceholder(ctx.tx, ctx.workspaceId, userId)))) return;
  throw badRequest("Assignee isn't a member of this workspace, or can't access this team");
}

export async function assertProject(ctx: Ctx, projectId: string) {
  const [p] = await ctx.tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, ctx.workspaceId)));
  if (!p) throw badRequest('Unknown project');
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
    throw badRequest('Unknown label for this team');
  }
}

async function assertParent(ctx: Ctx, issueId: string | null, parentId: string) {
  if (issueId === parentId) throw badRequest('An issue cannot be its own parent');
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
    if (!row || row.workspaceId !== ctx.workspaceId) throw badRequest('Unknown parent issue');
    // The parent itself must be visible; ancestors beyond it are only walked to detect loops.
    if (depth === 0 && !canReadTeam(ctx.access, row.teamId))
      throw badRequest('Unknown parent issue');
    if (issueId && row.parentId === issueId) throw badRequest('That would create a sub-issue loop');
    cursor = row.parentId;
  }
}

function stateTimestamps(type: StateType, prev?: { startedAt: string | null }) {
  const now = new Date().toISOString();
  return {
    startedAt: type === 'started' || type === 'completed' ? (prev?.startedAt ?? now) : null,
    completedAt: type === 'completed' ? now : null,
    canceledAt: type === 'canceled' ? now : null,
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
 * Creates an issue. Imports pass `imported` to keep the source's creator, timestamps and number;
 * the acting user (the importer) is then neither the creator nor subscribed.
 */
export async function createIssue(
  ctx: Ctx,
  input: CreateIssueInput,
  imported?: ImportedIssueFields,
): Promise<Issue> {
  const team = await teamOf(ctx, input.teamId);
  const state = input.stateId
    ? await stateOf(ctx, team.id, input.stateId)
    : await defaultState(ctx, team);
  if (input.assigneeId) await assertAssignee(ctx, team.id, input.assigneeId, !!imported);
  if (input.projectId) await assertProject(ctx, input.projectId);
  if (input.cycleId) await assertCycle(ctx, team.id, input.cycleId);
  if (input.parentId) await assertParent(ctx, null, input.parentId);
  const labelIds = [...new Set(input.labelIds ?? [])];
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

  const [row] = await ctx.tx
    .insert(issues)
    .values({
      workspaceId: ctx.workspaceId,
      teamId: team.id,
      number,
      title: input.title,
      description: input.description ?? '',
      stateId: state.id,
      priority: input.priority ?? 0,
      assigneeId: input.assigneeId ?? null,
      creatorId,
      projectId: input.projectId ?? null,
      cycleId: input.cycleId ?? null,
      parentId: input.parentId ?? null,
      estimate: input.estimate ?? null,
      dueDate: input.dueDate ?? null,
      sortOrder,
      ...(imported
        ? {
            ...importedTimestamps(state.type, imported),
            createdAt: imported.createdAt,
            updatedAt: imported.updatedAt ?? imported.createdAt,
          }
        : stateTimestamps(state.type)),
    })
    .returning({ id: issues.id });
  const id = row!.id;
  await claimAttachments(ctx, id, input.description);
  if (labelIds.length)
    await ctx.tx.insert(issueLabels).values(labelIds.map((labelId) => ({ issueId: id, labelId })));
  await subscribe(ctx, id, [creatorId, input.assigneeId]);
  await recordHistory(
    ctx,
    id,
    [{ field: 'created', from: null, to: null }],
    imported ? { actorId: creatorId, createdAt: imported.createdAt } : {},
  );
  if (input.assigneeId)
    await notify(ctx, { userIds: [input.assigneeId], type: 'issue_assigned', issueId: id });
  emit(ctx, { kind: 'issue', action: 'created', id, teamId: team.id });
  if (input.parentId)
    emit(ctx, { kind: 'issue', action: 'updated', id: input.parentId, teamId: team.id });
  const issue = await getIssue(ctx.tx, ctx.access, id);
  record(ctx, 'issue.created', issue, { teamIds: [team.id] });
  return issue;
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
  }

  if (patch.title !== undefined) change('title', 'title', patch.title);
  if (patch.description !== undefined && patch.description !== current.description) {
    set.description = patch.description;
    changes.push({ field: 'description', from: null, to: null });
    await claimAttachments(ctx, issueId, patch.description);
  }
  if (patch.priority !== undefined) change('priority', 'priority', patch.priority);
  if (patch.assigneeId !== undefined) {
    // Re-sending an imported placeholder assignee is fine; choosing one isn't.
    if (patch.assigneeId && patch.assigneeId !== current.assigneeId)
      await assertAssignee(ctx, teamId, patch.assigneeId);
    change('assigneeId', 'assignee', patch.assigneeId);
  }
  if (patch.projectId !== undefined) {
    if (patch.projectId) await assertProject(ctx, patch.projectId);
    change('projectId', 'project', patch.projectId);
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
    emit(ctx, { kind: 'issue', action: 'updated', id: issueId, teamId });
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
export async function trashIssue(ctx: Ctx, issueId: string, restore = false) {
  const [row] = await ctx.tx
    .update(issues)
    .set({
      deletedAt: restore ? null : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.workspaceId, ctx.workspaceId),
        teamScope(ctx.access, issues.teamId),
      ),
    )
    .returning({ id: issues.id, teamId: issues.teamId, parentId: issues.parentId });
  if (!row) throw notFound('Issue');
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
  await ctx.tx.update(issues).set({ parentId: null }).where(eq(issues.parentId, issueId));
  emit(ctx, { kind: 'issue', action: 'deleted', id: row.id, teamId: row.teamId });
  record(ctx, 'issue.deleted', { id: row.id }, { teamIds: [row.teamId] });
}
