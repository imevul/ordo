import {
  AGENT_AUTO_RESTARTS,
  AGENT_BRANCH_FORMAT,
  AGENT_LEASE_MS,
  AGENT_OUTPUT_RETENTION_MS,
  AGENT_PROTOCOL_VERSION,
  AGENT_RUN_OPEN,
  type Agent,
  type AgentIdentity,
  type AgentPause,
  type AgentPauseReason,
  type AgentRun,
  type AgentRunContext,
  type AgentRunDetail,
  type AgentRunEventKind,
  type AgentRunFailureReason,
  type AgentRunOutput,
  type AgentRunPullRequest,
  type AgentRunTrigger,
  type AgentRunUsageReport,
  type AgentRunWithIssue,
  type AgentUsageTotal,
  AVATAR_COLORS,
  appendOutput,
  branchName,
  classifyFailure,
  type createAgentSchema,
  DEFAULT_LIMIT_PAUSE_MS,
  monthOf,
  monthRange,
  parseLimitReset,
  type RealtimeEvent,
  type updateAgentSchema,
} from '@ordo/shared';
import {
  type AnyColumn,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DbOrTx } from '../db/client.ts';
import {
  agentRunEvents,
  agentRunOutput,
  agentRuns,
  agents,
  apiKeys,
  comments,
  issueLinks,
  issueRelations,
  issues,
  labels,
  projects,
  teamMembers,
  teams,
  users,
  workflowStates,
  workspaces,
} from '../db/schema.ts';
import { API_KEY_PREFIX } from '../lib/auth.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { badRequest, conflict, notFound, one } from '../lib/errors.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { type Access, teamScope } from './access.ts';
import { auditCtx } from './audit.ts';
import { forEachIsolated } from './automation.ts';
import { createComment } from './comments.ts';
import { type Ctx, emit, record } from './context.ts';
import { getIssue, getIssueDetail } from './issues.ts';
import { fullRepositories, issueRepositoryIds, repositoriesForIssue } from './repositories.ts';
import { joinWorkspace, workspaceSettings } from './workspaces.ts';

/**
 * Agents: members that aren't people. An agent is a `kind: 'agent'` user, a guest of its workspace
 * (so it sees exactly the teams it was added to), and an `agents` row with its settings. Assigning
 * an issue to one queues a run; runners holding the agent's API key claim runs, keep them alive by
 * heartbeat and report how they ended. Ordo never runs anything itself.
 */

/** Claims a run gets before a lapsed lease fails it instead of requeueing it. */
export const MAX_ATTEMPTS = 3;

type CreateAgentInput = z.infer<typeof createAgentSchema>;
type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

async function usernameTaken(tx: DbOrTx, username: string) {
  const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.username, username));
  return !!row;
}

/** Teams of this workspace among `teamIds`; unknown ones are an error, not silently dropped. */
async function assertTeams(ctx: Ctx, teamIds: string[]) {
  const found = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, ctx.workspaceId), inArray(teams.id, teamIds)));
  if (found.length !== new Set(teamIds).size) throw badRequest('Unknown team');
}

export async function listAgents(db: DbOrTx, workspaceId: string): Promise<Agent[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      avatarColor: users.avatarColor,
      disabledAt: users.disabledAt,
      instructions: agents.instructions,
      concurrency: agents.concurrency,
      followPullRequests: agents.followPullRequests,
      waitForBlockers: agents.waitForBlockers,
      pausedUntil: agents.pausedUntil,
      pauseReason: agents.pauseReason,
      monthlyBudgetUsd: agents.monthlyBudgetUsd,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(users.name));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [memberships, keys, spent] = await Promise.all([
    db
      .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(inArray(teamMembers.userId, ids), eq(teams.workspaceId, workspaceId))),
    db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(inArray(apiKeys.userId, ids))
      .orderBy(desc(apiKeys.createdAt)),
    usageTotals(db, workspaceId, monthOf(new Date().toISOString())),
  ]);
  const now = new Date().toISOString();
  return rows.map(({ disabledAt, pausedUntil, pauseReason, ...r }) => ({
    ...r,
    ...(pausedUntil && pausedUntil > now
      ? { pausedUntil, pauseReason }
      : { pausedUntil: null, pauseReason: null }),
    monthCostUsd: spent.get(r.id)?.costUsd ?? 0,
    disabled: !!disabledAt,
    teamIds: memberships.filter((m) => m.userId === r.id).map((m) => m.teamId),
    keys: keys.filter((k) => k.userId === r.id).map(({ userId: _, ...k }) => k),
  }));
}

export async function getAgent(db: DbOrTx, workspaceId: string, agentId: string) {
  const found = (await listAgents(db, workspaceId)).find((a) => a.id === agentId);
  if (!found) throw notFound('Agent');
  return found;
}

export async function createAgent(ctx: Ctx, input: CreateAgentInput): Promise<Agent> {
  await assertTeams(ctx, input.teamIds);
  let username = input.username ?? (slug(input.name) || 'agent');
  if (await usernameTaken(ctx.tx, username)) {
    if (input.username) throw conflict('That username is taken');
    username = `${username.slice(0, 23)}-${randomToken(6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}`.slice(0, 32);
  }
  const user = one(
    await ctx.tx
      .insert(users)
      .values({
        kind: 'agent',
        botWorkspaceId: ctx.workspaceId,
        email: `agent-${randomToken(12).toLowerCase()}@bots.ordo.invalid`,
        name: input.name,
        username,
        passwordHash: null,
        avatarColor:
          input.avatarColor ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
      })
      .returning({ id: users.id }),
  );
  const id = user.id;
  // Guests see only the teams they're on, which is exactly an agent's reach.
  await joinWorkspace(ctx.tx, ctx.workspaceId, id, 'guest', input.teamIds);
  await ctx.tx.insert(agents).values({
    userId: id,
    workspaceId: ctx.workspaceId,
    instructions: input.instructions,
    concurrency: input.concurrency,
    followPullRequests: input.followPullRequests,
    waitForBlockers: input.waitForBlockers,
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    createdById: ctx.userId,
  });
  await auditCtx(ctx, {
    action: 'agent.created',
    targetType: 'user',
    targetId: id,
    data: { name: input.name, teamIds: input.teamIds },
  });
  emit(ctx, { kind: 'member', action: 'created', id });
  for (const teamId of input.teamIds)
    emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
  return getAgent(ctx.tx, ctx.workspaceId, id);
}

export async function updateAgent(ctx: Ctx, agentId: string, input: UpdateAgentInput) {
  const current = await getAgent(ctx.tx, ctx.workspaceId, agentId);
  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) userPatch.name = input.name;
  if (input.avatarColor !== undefined) userPatch.avatarColor = input.avatarColor;
  if (input.disabled !== undefined && input.disabled !== current.disabled)
    userPatch.disabledAt = input.disabled ? new Date().toISOString() : null;
  if (Object.keys(userPatch).length)
    await ctx.tx
      .update(users)
      .set({ ...userPatch, updatedAt: new Date().toISOString() })
      .where(eq(users.id, agentId));
  const budgetChanged =
    input.monthlyBudgetUsd !== undefined && input.monthlyBudgetUsd !== current.monthlyBudgetUsd;
  if (
    input.instructions !== undefined ||
    input.concurrency !== undefined ||
    input.followPullRequests !== undefined ||
    input.waitForBlockers !== undefined ||
    budgetChanged
  )
    await ctx.tx
      .update(agents)
      .set({
        ...(input.instructions !== undefined && { instructions: input.instructions }),
        ...(input.concurrency !== undefined && { concurrency: input.concurrency }),
        ...(input.followPullRequests !== undefined && {
          followPullRequests: input.followPullRequests,
        }),
        ...(input.waitForBlockers !== undefined && { waitForBlockers: input.waitForBlockers }),
        // A new budget holds from now on, whatever "Resume now" waived under the old one.
        ...(budgetChanged && { monthlyBudgetUsd: input.monthlyBudgetUsd, budgetWaivedUntil: null }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agents.userId, agentId));
  // Raising the budget above what it spent lifts a budget pause; lowering it below pauses it.
  if (budgetChanged) await checkBudget(ctx, agentId);
  const changedTeams = new Set<string>();
  if (input.teamIds) {
    await assertTeams(ctx, input.teamIds);
    const removed = current.teamIds.filter((t) => !input.teamIds!.includes(t));
    const added = input.teamIds.filter((t) => !current.teamIds.includes(t));
    if (removed.length)
      await ctx.tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.userId, agentId), inArray(teamMembers.teamId, removed)));
    if (added.length)
      await ctx.tx
        .insert(teamMembers)
        .values(added.map((teamId) => ({ teamId, userId: agentId })))
        .onConflictDoNothing();
    for (const t of [...removed, ...added]) changedTeams.add(t);
  }
  // A disabled agent's queue is abandoned; nobody can claim it any more.
  if (input.disabled)
    await cancelOpenRuns(ctx, eq(agentRuns.agentId, agentId), 'The agent was disabled');
  await auditCtx(ctx, {
    action: input.disabled ? 'agent.disabled' : 'agent.updated',
    targetType: 'user',
    targetId: agentId,
    data: { ...input, instructions: input.instructions === undefined ? undefined : '(changed)' },
  });
  emit(ctx, { kind: 'member', action: 'updated', id: agentId });
  for (const teamId of changedTeams)
    emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
  return getAgent(ctx.tx, ctx.workspaceId, agentId);
}

/** A new key for the agent. The token is returned once and stored only as a hash. */
export async function createAgentKey(ctx: Ctx, agentId: string, name: string) {
  await getAgent(ctx.tx, ctx.workspaceId, agentId);
  const token = `${API_KEY_PREFIX}${randomToken(24)}`;
  const row = one(
    await ctx.tx
      .insert(apiKeys)
      .values({ userId: agentId, name, tokenHash: sha256(token), prefix: token.slice(0, 12) })
      .returning({ id: apiKeys.id }),
  );
  await auditCtx(ctx, {
    action: 'agent.key_created',
    targetType: 'user',
    targetId: agentId,
    data: { name, keyId: row.id },
  });
  return { id: row.id, token };
}

export async function revokeAgentKey(ctx: Ctx, agentId: string, keyId: string) {
  await getAgent(ctx.tx, ctx.workspaceId, agentId);
  const [removed] = await ctx.tx
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, agentId)))
    .returning({ name: apiKeys.name });
  if (!removed) throw notFound('Key');
  await auditCtx(ctx, {
    action: 'api_key.revoked',
    targetType: 'api_key',
    targetId: keyId,
    data: { name: removed.name, agentId },
  });
}

/** The caller as an agent of this workspace, for the runner endpoints. */
export async function describeAgent(db: DbOrTx, access: Access): Promise<AgentIdentity> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      wsId: workspaces.id,
      wsSlug: workspaces.slug,
      wsName: workspaces.name,
      pausedUntil: agents.pausedUntil,
      pauseReason: agents.pauseReason,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .where(and(eq(agents.userId, access.userId), eq(agents.workspaceId, access.workspaceId)));
  if (!row) throw notFound('Agent');
  const teamRows = access.teamIds.length
    ? await db
        .select({ id: teams.id, key: teams.key, name: teams.name })
        .from(teams)
        .where(inArray(teams.id, access.teamIds))
        .orderBy(asc(teams.key))
    : [];
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    workspace: { id: row.wsId, slug: row.wsSlug, name: row.wsName },
    teams: teamRows,
    ...(row.pausedUntil && row.pausedUntil > new Date().toISOString()
      ? { pausedUntil: row.pausedUntil, pauseReason: row.pauseReason }
      : { pausedUntil: null, pauseReason: null }),
  };
}

// --- Runs -----------------------------------------------------------------------------------

type RunRow = typeof agentRuns.$inferSelect;

export const toAgentRun = (r: RunRow): AgentRun => ({
  id: r.id,
  issueId: r.issueId,
  agentId: r.agentId,
  status: r.status,
  attempts: r.attempts,
  runnerName: r.runnerName,
  sessionUrl: r.sessionUrl,
  summary: r.summary,
  error: r.error,
  failureReason: r.failureReason,
  retryAt: r.retryAt,
  retryOfId: r.retryOfId,
  dismissedAt: r.dismissedAt,
  progress:
    r.progressStep && r.progressAt
      ? { step: r.progressStep, percent: r.progressPercent, at: r.progressAt }
      : null,
  ignoreBlockers: r.ignoreBlockers,
  // Filled in by withBlockers where runs are listed for people.
  blockedBy: [],
  usage: r.usageAt
    ? {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
      }
    : null,
  question: r.question,
  resume: r.resume,
  trigger: r.trigger,
  triggerCommentId: r.triggerCommentId,
  triggerDetail: r.triggerDetail ?? null,
  requestedById: r.requestedById,
  leaseExpiresAt: r.leaseExpiresAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  createdAt: r.createdAt,
});

async function teamOfIssue(tx: DbOrTx, issueId: string) {
  const [row] = await tx
    .select({ teamId: issues.teamId })
    .from(issues)
    .where(eq(issues.id, issueId));
  return row?.teamId;
}

async function changed(ctx: Ctx, run: RunRow) {
  const teamId = await teamOfIssue(ctx.tx, run.issueId);
  emit(ctx, { kind: 'agentRun', action: 'updated', id: run.id, issueId: run.issueId, teamId });
  record(ctx, 'agent_run.updated', toAgentRun(run), { teamIds: [teamId] });
}

/** A step in the run's timeline, by `ctx`'s user unless `actorId` says otherwise. */
async function logRun(
  ctx: Ctx,
  runId: string,
  kind: AgentRunEventKind,
  data: Record<string, unknown> = {},
  actorId: string | null = ctx.userId,
) {
  await ctx.tx.insert(agentRunEvents).values({ runId, kind, data, actorId });
}

/** Whether `userId` is an enabled agent of this workspace. */
export async function isActiveAgent(tx: DbOrTx, workspaceId: string, userId: string) {
  const [row] = await tx
    .select({ id: agents.userId })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(eq(agents.userId, userId), eq(agents.workspaceId, workspaceId), isNull(users.disabledAt)),
    );
  return !!row;
}

/**
 * A run for the agent on the issue, unless one already covers it: a queued or waiting run will
 * see whatever prompted this. A run that's working right now covers it too, except for a
 * `followUp` (a mention made meanwhile), which queues one more to start after it.
 */
export async function queueRun(
  ctx: Ctx,
  issueId: string,
  agentId: string,
  trigger: {
    kind: AgentRunTrigger;
    commentId?: string;
    pullRequest?: AgentRunPullRequest;
  } = { kind: 'assigned' },
  opts: { followUp?: boolean; retryOfId?: string } = {},
) {
  const open = await ctx.tx
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.issueId, issueId),
        eq(agentRuns.agentId, agentId),
        inArray(agentRuns.status, [...AGENT_RUN_OPEN]),
      ),
    );
  const pending = open.find((r) => r.status === 'queued' || r.status === 'waiting');
  if (pending) return pending;
  if (open[0] && !opts.followUp) return open[0];
  const run = one(
    await ctx.tx
      .insert(agentRuns)
      .values({
        workspaceId: ctx.workspaceId,
        issueId,
        agentId,
        requestedById: ctx.userId,
        trigger: trigger.kind,
        triggerCommentId: trigger.commentId ?? null,
        triggerDetail: trigger.pullRequest ?? null,
        retryOfId: opts.retryOfId ?? null,
      })
      .returning(),
  );
  await logRun(ctx, run.id, 'queued', opts.retryOfId ? { retryOfId: opts.retryOfId } : {});
  await changed(ctx, run);
  return run;
}

async function cancelOpenRuns(ctx: Ctx, where: ReturnType<typeof eq>, reason: string) {
  const cancelled = await ctx.tx
    .update(agentRuns)
    .set({
      status: 'cancelled',
      error: reason,
      leaseExpiresAt: null,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(and(where, inArray(agentRuns.status, [...AGENT_RUN_OPEN])))
    .returning();
  for (const run of cancelled) {
    await logRun(ctx, run.id, 'cancelled', { reason });
    await changed(ctx, run);
  }
}

/**
 * Called by `createIssue`/`updateIssue` when the assignee changes: an agent that's handed the issue
 * gets a run; one that loses it stops working on it.
 */
export async function onAssigneeChanged(
  ctx: Ctx,
  issueId: string,
  prev: string | null,
  next: string | null,
  trigger: AgentRunTrigger = 'assigned',
) {
  if (prev === next) return;
  if (prev)
    await cancelOpenRuns(
      ctx,
      and(
        eq(agentRuns.issueId, issueId),
        eq(agentRuns.agentId, prev),
        // An agent handing the issue on itself is still finishing the run it does that from;
        // let it report. Anything else it had queued or waiting there stops.
        prev === ctx.userId ? inArray(agentRuns.status, ['queued', 'waiting']) : undefined,
      )!,
      'Unassigned',
    );
  if (next && (await isActiveAgent(ctx.tx, ctx.workspaceId, next)))
    await queueRun(ctx, issueId, next, { kind: trigger });
}

/** "Run again": a new run for the issue's agent, e.g. after review feedback in a comment. */
export async function requestRun(ctx: Ctx, issueIdOrIdentifier: string): Promise<AgentRun> {
  const issue = await getIssue(ctx.tx, ctx.access, issueIdOrIdentifier);
  if (!issue.assigneeId || !(await isActiveAgent(ctx.tx, ctx.workspaceId, issue.assigneeId)))
    throw badRequest('Assign the issue to an agent first');
  const run = await queueRun(ctx, issue.id, issue.assigneeId, { kind: 'rerun' });
  // A run waiting on a question resumes, answered or not.
  if (run.status === 'waiting')
    return toAgentRun((await resumeRuns(ctx, eq(agentRuns.id, run.id)))[0]!);
  return toAgentRun(run);
}

/**
 * Waiting runs matching `where` go back in the queue; lapsed-lease counting starts over.
 * `commentId`: the reply that answered them.
 */
async function resumeRuns(ctx: Ctx, where: ReturnType<typeof eq>, commentId?: string) {
  const resumed = await ctx.tx
    .update(agentRuns)
    .set({ status: 'queued', attempts: 0, updatedAt: new Date().toISOString() })
    .where(and(where, eq(agentRuns.status, 'waiting')))
    .returning();
  for (const run of resumed) {
    await logRun(ctx, run.id, 'resumed', commentId ? { commentId } : {});
    await changed(ctx, run);
  }
  return resumed;
}

/**
 * Called after every comment: a person's comment answers whatever the issue's agents asked, so
 * their waiting runs go back in the queue. Agents' and integrations' comments don't.
 */
export async function onComment(
  ctx: Ctx,
  issueId: string,
  authorId: string | null,
  comment: { id: string; mentioned: string[] },
) {
  if (!authorId) return;
  const [waiting] = await ctx.tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.issueId, issueId), eq(agentRuns.status, 'waiting')))
    .limit(1);
  const mentioned = comment.mentioned.filter((id) => id !== authorId);
  if (!waiting && mentioned.length === 0) return;
  const [author] = await ctx.tx
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, authorId));
  // Agents mentioning agents would start each other forever; they hand work on by assigning.
  if (author?.kind !== 'human') return;
  if (waiting) await resumeRuns(ctx, eq(agentRuns.issueId, issueId), comment.id);
  // A person @mentioning an agent asks it for something, whether or not the issue is its own.
  for (const id of mentioned)
    if (await isActiveAgent(ctx.tx, ctx.workspaceId, id))
      await queueRun(
        ctx,
        issueId,
        id,
        { kind: 'mention', commentId: comment.id },
        { followUp: true },
      );
}

/**
 * The agent asks something and pauses: the question is posted on the issue, mentioning whoever
 * asked for the run (else the issue's creator), and the run waits, holding no lease and taking
 * no concurrency, until a person comments.
 */
export async function askQuestion(ctx: Ctx, runId: string, question: string): Promise<AgentRun> {
  const run = await ownRun(ctx, runId);
  if (run.status !== 'claimed' && run.status !== 'running')
    throw conflict(`This run is ${run.status}`);
  const [saved] = await ctx.tx
    .update(agentRuns)
    .set({
      status: 'waiting',
      question,
      leaseExpiresAt: null,
      startedAt: run.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentRuns.id, runId))
    .returning();
  const [issue] = await ctx.tx
    .select({ creatorId: issues.creatorId })
    .from(issues)
    .where(eq(issues.id, run.issueId));
  const asker = await humanUsername(ctx, run.requestedById, issue?.creatorId ?? null);
  await createComment(ctx, run.issueId, {
    body: `${asker ? `@${asker} ` : ''}${question}`.slice(0, 50_000),
  });
  await logRun(ctx, runId, 'asked', { question });
  await changed(ctx, saved!);
  return toAgentRun(saved!);
}

/** The username of the first of `ids` that is a person, for a mention. */
async function humanUsername(ctx: Ctx, ...ids: (string | null)[]) {
  for (const id of ids) {
    if (!id || id === ctx.userId) continue;
    const [u] = await ctx.tx
      .select({ username: users.username, kind: users.kind })
      .from(users)
      .where(eq(users.id, id));
    if (u?.kind === 'human') return u.username;
  }
  return null;
}

/** A run of an issue `ctx` can read. */
/**
 * True while an open issue (not done, cancelled or trashed) blocks the run's issue. Correlated on
 * "agent_runs" by name, as the selects it goes in leave their columns unqualified.
 */
const blockedNow = sql`exists (
  select 1 from issue_relations r
  join issues b on b.id = r.issue_id
  join workflow_states s on s.id = b.state_id
  where r.related_issue_id = "agent_runs"."issue_id" and r.type = 'blocks'
    and b.deleted_at is null and s.type not in ('completed', 'canceled')
)`;

/**
 * Adds `blockedBy` to queued runs that wait for their issue's blockers: the open blocking issues
 * `access` can see. Runs of agents that don't wait, or that someone told to run anyway, get none.
 */
async function withBlockers<T extends AgentRun>(
  db: DbOrTx,
  access: Access,
  runs: T[],
): Promise<T[]> {
  const queued = runs.filter((r) => r.status === 'queued' && !r.ignoreBlockers);
  if (!queued.length) return runs;
  const waiting = new Set(
    (
      await db
        .select({ id: agents.userId })
        .from(agents)
        .where(
          and(
            inArray(agents.userId, [...new Set(queued.map((r) => r.agentId))]),
            eq(agents.waitForBlockers, true),
          ),
        )
    ).map((a) => a.id),
  );
  const issueIds = [...new Set(queued.filter((r) => waiting.has(r.agentId)).map((r) => r.issueId))];
  if (!issueIds.length) return runs;
  const rows = await db
    .select({
      blockedId: issueRelations.relatedIssueId,
      id: issues.id,
      number: issues.number,
      title: issues.title,
      teamKey: teams.key,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.issueId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(
      and(
        inArray(issueRelations.relatedIssueId, issueIds),
        eq(issueRelations.type, 'blocks'),
        isNull(issues.deletedAt),
        not(inArray(workflowStates.type, ['completed', 'canceled'])),
        teamScope(access, issues.teamId),
      ),
    )
    .orderBy(asc(issues.number));
  const byIssue = new Map<string, AgentRun['blockedBy']>();
  for (const r of rows)
    byIssue.set(r.blockedId, [
      ...(byIssue.get(r.blockedId) ?? []),
      { id: r.id, identifier: `${r.teamKey}-${r.number}`, title: r.title },
    ]);
  return runs.map((r) =>
    r.status === 'queued' && !r.ignoreBlockers && waiting.has(r.agentId)
      ? { ...r, blockedBy: byIssue.get(r.issueId) ?? [] }
      : r,
  );
}

async function loadRun(ctx: Ctx, runId: string) {
  const [row] = await ctx.tx
    .select({ run: agentRuns })
    .from(agentRuns)
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.workspaceId, ctx.workspaceId),
        teamScope(ctx.access, issues.teamId),
      ),
    );
  if (!row) throw notFound('Run');
  return row.run;
}

/** "Run anyway": a queued run stops waiting for its issue's blockers. */
export async function runAnyway(ctx: Ctx, runId: string): Promise<AgentRun> {
  const run = await loadRun(ctx, runId);
  if (run.status !== 'queued') throw conflict(`This run is ${run.status}`);
  const [saved] = await ctx.tx
    .update(agentRuns)
    .set({ ignoreBlockers: true, updatedAt: new Date().toISOString() })
    .where(eq(agentRuns.id, run.id))
    .returning();
  await logRun(ctx, run.id, 'ran_anyway');
  await changed(ctx, saved!);
  return toAgentRun(saved!);
}

export async function cancelRun(ctx: Ctx, runId: string): Promise<AgentRun> {
  const run = await loadRun(ctx, runId);
  await cancelOpenRuns(ctx, eq(agentRuns.id, run.id), 'Cancelled');
  return toAgentRun(await loadRun(ctx, runId));
}

/**
 * Restart: the same agent on the same issue, for the same reason (the mention, the pull request),
 * as a new run that points back at this one. An open run of the agent there already covers it.
 */
export async function restartRun(ctx: Ctx, runId: string): Promise<AgentRun> {
  return toAgentRun(await restart(ctx, await loadRun(ctx, runId)));
}

async function restart(ctx: Ctx, run: RunRow) {
  if (run.status !== 'failed' && run.status !== 'cancelled')
    throw conflict(`This run is ${run.status}`);
  if (!(await isActiveAgent(ctx.tx, ctx.workspaceId, run.agentId)))
    throw badRequest('That agent is disabled or no longer exists');
  return queueRun(
    ctx,
    run.issueId,
    run.agentId,
    {
      kind: run.trigger,
      commentId: run.triggerCommentId ?? undefined,
      pullRequest: run.triggerDetail ?? undefined,
    },
    { followUp: true, retryOfId: run.id },
  );
}

/** Sets a failed run aside: it leaves the open runs without being restarted. */
export async function dismissRun(ctx: Ctx, runId: string): Promise<AgentRun> {
  const run = await loadRun(ctx, runId);
  if (AGENT_RUN_OPEN.includes(run.status)) throw conflict(`This run is ${run.status}`);
  const [saved] = await ctx.tx
    .update(agentRuns)
    .set({ dismissedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(agentRuns.id, run.id))
    .returning();
  await logRun(ctx, run.id, 'dismissed');
  await changed(ctx, saved!);
  return toAgentRun(saved!);
}

/** Agents of the workspace whose claims are on hold right now. */
export async function listPauses(db: DbOrTx, workspaceId: string): Promise<AgentPause[]> {
  const rows = await db
    .select({ agentId: agents.userId, pausedUntil: agents.pausedUntil, reason: agents.pauseReason })
    .from(agents)
    .where(
      and(eq(agents.workspaceId, workspaceId), gt(agents.pausedUntil, new Date().toISOString())),
    );
  return rows.map((r) => ({ agentId: r.agentId, pausedUntil: r.pausedUntil!, reason: r.reason }));
}

/**
 * "Resume now": lifts an agent's pause and restarts the runs that failed on its usage limit
 * straight away, instead of at the reset time. A budget pause stays lifted for the rest of the
 * month: the budget doesn't pause it again until it's changed.
 */
export async function unpauseAgent(ctx: Ctx, agentId: string) {
  const now = new Date().toISOString();
  const [current] = await ctx.tx
    .select({ pausedUntil: agents.pausedUntil, pauseReason: agents.pauseReason })
    .from(agents)
    .where(and(eq(agents.userId, agentId), eq(agents.workspaceId, ctx.workspaceId)))
    .for('update');
  if (!current) throw notFound('Agent');
  const budget =
    current.pauseReason === 'budget' && !!current.pausedUntil && current.pausedUntil > now;
  await ctx.tx
    .update(agents)
    .set({
      pausedUntil: null,
      pauseReason: null,
      ...(budget && { budgetWaivedUntil: monthRange(monthOf(now)).end }),
      updatedAt: now,
    })
    .where(eq(agents.userId, agentId));
  for (const run of await limitFailures(ctx.tx, eq(agentRuns.agentId, agentId)))
    await restart(ctx, run);
  // Wakes the agent's runners, which wait on member and run events.
  emit(ctx, { kind: 'member', action: 'updated', id: agentId });
  await auditCtx(ctx, {
    action: 'agent.unpaused',
    targetType: 'user',
    targetId: agentId,
    data: { reason: current.pauseReason },
  });
  return { ok: true };
}

/**
 * Failed runs waiting to restart after a usage limit (oldest first): not dismissed, not covered
 * by a newer run of the agent on the issue, and still owed an automatic restart.
 */
async function limitFailures(db: DbOrTx, where: ReturnType<typeof eq>) {
  return db
    .select()
    .from(agentRuns)
    .where(
      and(
        where,
        eq(agentRuns.status, 'failed'),
        eq(agentRuns.failureReason, 'usage_limit'),
        sql`${agentRuns.retryAt} is not null`,
        isNull(agentRuns.dismissedAt),
        notSuperseded,
      ),
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(200);
}

/** No newer run of the same agent on the same issue: nobody restarted or re-ran it since. */
const notSuperseded = sql`not exists (select 1 from agent_runs later where later.issue_id = "agent_runs"."issue_id" and later.agent_id = "agent_runs"."agent_id" and later.created_at > "agent_runs"."created_at")`;

/**
 * Every minute: runs that failed on a usage limit restart once their reset time has passed and
 * their agent isn't paused any more. Each restarts as its agent, so it reads as its own.
 */
export async function restartAfterLimits(app: FastifyInstance) {
  const now = new Date().toISOString();
  const due = await app.db
    .select({ run: agentRuns })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.userId, agentRuns.agentId))
    .where(
      and(
        eq(agentRuns.status, 'failed'),
        eq(agentRuns.failureReason, 'usage_limit'),
        lte(agentRuns.retryAt, now),
        isNull(agentRuns.dismissedAt),
        notSuperseded,
        or(isNull(agents.pausedUntil), lte(agents.pausedUntil, now)),
      ),
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(100);
  await forEachIsolated(
    app,
    'agents.restart',
    due.map((r) => r.run),
    (run) => ({ runId: run.id, workspaceId: run.workspaceId }),
    (run) =>
      runInWorkspace(
        app,
        { workspaceId: run.workspaceId, actorId: run.agentId, source: 'system' },
        async (ctx) => {
          const [current] = await ctx.tx
            .select()
            .from(agentRuns)
            .where(and(eq(agentRuns.id, run.id), notSuperseded))
            .for('update', { skipLocked: true });
          if (current?.status === 'failed' && current.retryAt && !current.dismissedAt)
            await restart(ctx, current);
        },
      ),
  );
}

/** Usage-limit failures in a row, `run`'s predecessors included: when to stop restarting. */
async function limitStreak(tx: DbOrTx, retryOfId: string | null) {
  let streak = 1;
  for (let id = retryOfId; id && streak < AGENT_AUTO_RESTARTS; streak++) {
    const [prev] = await tx
      .select({ retryOfId: agentRuns.retryOfId, reason: agentRuns.failureReason })
      .from(agentRuns)
      .where(eq(agentRuns.id, id));
    if (prev?.reason !== 'usage_limit') break;
    id = prev.retryOfId;
  }
  return streak;
}

export async function listRuns(db: DbOrTx, access: Access, issueIdOrIdentifier: string) {
  const issue = await getIssue(db, access, issueIdOrIdentifier);
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.issueId, issue.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
  return withBlockers(db, access, rows.map(toAgentRun));
}

/** One run of an issue `access` can read, with its timeline and restarts: the run's page. */
export async function getRunDetail(
  db: DbOrTx,
  access: Access,
  runId: string,
): Promise<AgentRunDetail> {
  const [row] = await db
    .select({
      run: agentRuns,
      number: issues.number,
      title: issues.title,
      stateId: issues.stateId,
      teamId: issues.teamId,
      teamKey: teams.key,
    })
    .from(agentRuns)
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.workspaceId, access.workspaceId),
        teamScope(access, issues.teamId),
      ),
    );
  if (!row) throw notFound('Run');
  const { run } = row;
  const [[withBlocked], events, restartedBy, [triggerComment], held] = await Promise.all([
    withBlockers(db, access, [toAgentRun(run)]),
    db
      .select()
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, run.id))
      // The newest, should a chatty agent have reported very many steps.
      .orderBy(desc(agentRunEvents.id))
      .limit(1000),
    db
      .select({ id: agentRuns.id, status: agentRuns.status, createdAt: agentRuns.createdAt })
      .from(agentRuns)
      .where(eq(agentRuns.retryOfId, run.id))
      .orderBy(asc(agentRuns.createdAt)),
    run.triggerCommentId
      ? db
          .select({ id: comments.id, authorId: comments.authorId, body: comments.body })
          .from(comments)
          .where(and(eq(comments.id, run.triggerCommentId), eq(comments.issueId, run.issueId)))
      : Promise.resolve([]),
    heldByRepository(db, access.workspaceId, run.status === 'queued' ? [run.issueId] : []),
  ]);
  return {
    ...withBlocked!,
    waitingForRepository: held.get(run.issueId) ?? null,
    issue: {
      id: run.issueId,
      identifier: `${row.teamKey}-${row.number}`,
      title: row.title,
      stateId: row.stateId,
      teamId: row.teamId,
    },
    prompt: run.prompt,
    triggerComment: triggerComment ?? null,
    restartedBy,
    events: events.reverse().map((e) => ({
      id: String(e.id),
      kind: e.kind,
      data: e.data,
      actorId: e.actorId,
      at: e.createdAt,
    })),
  };
}

/**
 * Runs across the workspace, on issues `access` can read, by when they last changed: active ones
 * (waiting included), finished ones, or `open`: the active ones plus failed runs nobody has
 * restarted, re-run or dismissed yet.
 */
export async function listWorkspaceRuns(
  db: DbOrTx,
  access: Access,
  opts: { status: 'open' | 'active' | 'finished' | 'all'; agentId?: string; limit: number },
): Promise<AgentRunWithIssue[]> {
  const open = inArray(agentRuns.status, [...AGENT_RUN_OPEN]);
  const unhandled = and(
    eq(agentRuns.status, 'failed'),
    isNull(agentRuns.dismissedAt),
    notSuperseded,
  );
  const status = {
    open: or(open, unhandled),
    active: open,
    finished: not(open),
    all: undefined,
  }[opts.status];
  const rows = await db
    .select({
      run: agentRuns,
      number: issues.number,
      title: issues.title,
      stateId: issues.stateId,
      teamId: issues.teamId,
      teamKey: teams.key,
    })
    .from(agentRuns)
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(
      and(
        eq(agentRuns.workspaceId, access.workspaceId),
        teamScope(access, issues.teamId),
        opts.agentId ? eq(agentRuns.agentId, opts.agentId) : undefined,
        status,
      ),
    )
    .orderBy(desc(agentRuns.updatedAt))
    .limit(opts.limit);
  const held = await heldByRepository(
    db,
    access.workspaceId,
    rows.filter((r) => r.run.status === 'queued').map((r) => r.run.issueId),
  );
  return withBlockers(
    db,
    access,
    rows.map((r) => ({
      ...toAgentRun(r.run),
      issue: {
        id: r.run.issueId,
        identifier: `${r.teamKey}-${r.number}`,
        title: r.title,
        stateId: r.stateId,
        teamId: r.teamId,
      },
      waitingForRepository: (r.run.status === 'queued' && held.get(r.run.issueId)) || null,
    })),
  );
}

/** For each of these issues whose repository is at its run limit, that repository. */
async function heldByRepository(db: DbOrTx, workspaceId: string, issueIds: string[]) {
  const held = new Map<string, { id: string; name: string }>();
  if (issueIds.length === 0) return held;
  const full = await fullRepositories(db, workspaceId);
  if (full.length === 0) return held;
  const byId = new Map(full.map((r) => [r.id, r]));
  const ids = sql.join(
    [...new Set(issueIds)].map((id) => sql`${id}`),
    sql`, `,
  );
  const pairs = (await db.execute(sql`
    select i.id as issue_id, repo.repository_id from issues i
      cross join lateral (${issueRepositoryIds(sql`i.id`)}) repo
      where i.id in (${ids})`)) as unknown as { issue_id: string; repository_id: string }[];
  for (const p of pairs) {
    const repo = byId.get(p.repository_id);
    if (repo && !held.has(p.issue_id)) held.set(p.issue_id, repo);
  }
  return held;
}

/** How many runs `listWorkspaceRuns` would call active: the sidebar's Agent runs chip. */
export async function countActiveRuns(db: DbOrTx, access: Access): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(agentRuns)
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(
      and(
        eq(agentRuns.workspaceId, access.workspaceId),
        teamScope(access, issues.teamId),
        inArray(agentRuns.status, [...AGENT_RUN_OPEN]),
      ),
    );
  return row?.n ?? 0;
}

/** The runs an agent holds now (claimed or running), oldest first. */
export async function heldRuns(db: DbOrTx, agentId: string) {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.status, ['claimed', 'running'])))
    .orderBy(asc(agentRuns.createdAt));
  return rows.map(toAgentRun);
}

/**
 * Takes the agent's oldest queued run, if it has room under its concurrency, and leases it to
 * the caller. The agent's row is locked meanwhile, so concurrent claims count each other's runs.
 */
async function takeRun(ctx: Ctx, runnerName: string | null): Promise<RunRow | null> {
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  if (workspaceSettings(ws!).agentRunsPaused) return null;
  const [agent] = await ctx.tx
    .select({
      concurrency: agents.concurrency,
      pausedUntil: agents.pausedUntil,
      waitForBlockers: agents.waitForBlockers,
    })
    .from(agents)
    .where(eq(agents.userId, ctx.userId))
    .for('update');
  if (!agent) throw notFound('Agent');
  if (agent.pausedUntil && agent.pausedUntil > new Date().toISOString()) return null;
  const [{ busy }] = (await ctx.tx
    .select({ busy: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.agentId, ctx.userId), inArray(agentRuns.status, ['claimed', 'running'])),
    )) as [{ busy: number }];
  if (busy >= agent.concurrency) return null;
  // Runs in a repository at its limit wait, so agents don't work over each other's files.
  const full = await fullRepositories(ctx.tx, ctx.workspaceId, { lock: true });
  const [next] = await ctx.tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agentId, ctx.userId),
        eq(agentRuns.status, 'queued'),
        // One run per issue at a time: a follow-up waits for the agent's run there to finish.
        sql`not exists (select 1 from agent_runs busy where busy.issue_id = "agent_runs"."issue_id" and busy.agent_id = "agent_runs"."agent_id" and busy.status in ('claimed', 'running'))`,
        // A blocked issue waits for its blockers, unless someone said to run anyway.
        agent.waitForBlockers ? or(eq(agentRuns.ignoreBlockers, true), not(blockedNow)) : undefined,
        full.length
          ? sql`not exists (select 1 from (${issueRepositoryIds(sql`"agent_runs"."issue_id"`)}) repo where repo.repository_id in (${sql.join(
              full.map((r) => sql`${r.id}`),
              sql`, `,
            )}))`
          : undefined,
      ),
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(1);
  if (!next) return null;
  const [run] = await ctx.tx
    .update(agentRuns)
    .set({
      status: 'claimed',
      attempts: sql`${agentRuns.attempts} + 1`,
      leaseExpiresAt: new Date(Date.now() + AGENT_LEASE_MS).toISOString(),
      runnerName,
      error: null,
      // A new pickup starts over; an earlier attempt's progress no longer says anything.
      progressStep: null,
      progressPercent: null,
      progressAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentRuns.id, next.id))
    .returning();
  // Deleted since the select (its issue went away): nothing to claim this time.
  if (run) {
    await logRun(ctx, run.id, 'claimed', { runner: runnerName, attempt: run.attempts });
    // Like progress: what an earlier pickup printed doesn't describe this one.
    await ctx.tx.delete(agentRunOutput).where(eq(agentRunOutput.runId, run.id));
  }
  return run ?? null;
}

/**
 * Claims a run for the calling agent and describes it, or returns null when there's nothing to
 * do. Runs whose issue the agent can no longer see (trashed, moved to another team) are cancelled.
 */
export async function claimRun(
  app: FastifyInstance,
  access: Access,
  runnerName: string | null,
  /** The runner's own instructions (its runner file), put before the agent's. Not stored. */
  runnerInstructions = '',
): Promise<AgentRunContext | null> {
  for (;;) {
    const result = await runInWorkspace(
      app,
      { workspaceId: access.workspaceId, actorId: access.userId, access, source: 'api' },
      async (ctx) => {
        const run = await takeRun(ctx, runnerName);
        if (!run) return { done: true as const, context: null };
        try {
          const { context, prompt } = await runContext(app, ctx, run, runnerInstructions);
          await ctx.tx.update(agentRuns).set({ prompt }).where(eq(agentRuns.id, run.id));
          await changed(ctx, run);
          return { done: true as const, context };
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode !== 404) throw err;
          await cancelOpenRuns(
            ctx,
            eq(agentRuns.id, run.id),
            'The agent can no longer see the issue',
          );
          return { done: false as const, context: null };
        }
      },
    );
    if (result.done) return result.context;
  }
}

/** A runner's run, as long as it's still open. */
async function ownRun(ctx: Ctx, runId: string) {
  const [run] = await ctx.tx
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.agentId, ctx.userId)))
    .for('update');
  if (!run) throw notFound('Run');
  return run;
}

/**
 * The agent says how far it got. Only the newest note is kept, and it isn't an event for webhooks
 * (agents may send many); clients refetch the run. A claimed run is running once it reports.
 */
export async function reportProgress(
  ctx: Ctx,
  runId: string,
  input: { step: string; percent?: number | null },
): Promise<AgentRun> {
  const run = await ownRun(ctx, runId);
  if (run.status !== 'claimed' && run.status !== 'running')
    throw conflict(`This run is ${run.status}`);
  const now = new Date().toISOString();
  const [saved] = await ctx.tx
    .update(agentRuns)
    .set({
      progressStep: input.step,
      progressPercent: input.percent ?? null,
      progressAt: now,
      ...(run.status === 'claimed' && {
        status: 'running' as const,
        startedAt: run.startedAt ?? now,
      }),
      updatedAt: now,
    })
    .where(eq(agentRuns.id, runId))
    .returning();
  if (run.status === 'claimed') await logRun(ctx, runId, 'started');
  await logRun(ctx, runId, 'progress', { step: input.step, percent: input.percent ?? null });
  const teamId = await teamOfIssue(ctx.tx, run.issueId);
  emit(ctx, { kind: 'agentRun', action: 'updated', id: run.id, issueId: run.issueId, teamId });
  return toAgentRun(saved!);
}

/**
 * Lines the run's command printed, added to the tail Ordo keeps (capped, see `appendOutput`).
 * Only while it works: a cancelled run's runner may send a last batch, which is dropped. Viewers
 * hear of it by an event of its own, so run lists don't refetch every few seconds.
 */
export async function appendRunOutput(ctx: Ctx, runId: string, lines: string[]) {
  const run = await ownRun(ctx, runId);
  if (run.status !== 'claimed' && run.status !== 'running') return { accepted: false };
  const [kept] = await ctx.tx.select().from(agentRunOutput).where(eq(agentRunOutput.runId, runId));
  const next = appendOutput(kept?.lines ?? [], lines);
  const total = (kept?.total ?? 0) + lines.length;
  const now = new Date().toISOString();
  await ctx.tx
    .insert(agentRunOutput)
    .values({ runId, lines: next, total, updatedAt: now })
    .onConflictDoUpdate({
      target: agentRunOutput.runId,
      set: { lines: next, total, updatedAt: now },
    });
  const teamId = await teamOfIssue(ctx.tx, run.issueId);
  emit(ctx, { kind: 'agentRunOutput', action: 'updated', id: runId, issueId: run.issueId, teamId });
  return { accepted: true };
}

/** The run's output tail, for anyone who can see its issue (output can hold secrets). */
export async function getRunOutput(
  db: DbOrTx,
  access: Access,
  runId: string,
): Promise<AgentRunOutput> {
  const [row] = await db
    .select({
      lines: agentRunOutput.lines,
      total: agentRunOutput.total,
      at: agentRunOutput.updatedAt,
    })
    .from(agentRuns)
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .leftJoin(agentRunOutput, eq(agentRunOutput.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.workspaceId, access.workspaceId),
        teamScope(access, issues.teamId),
      ),
    );
  if (!row) throw notFound('Run');
  return { lines: row.lines ?? [], total: row.total ?? 0, updatedAt: row.at };
}

/** Hourly: output nobody added to for `AGENT_OUTPUT_RETENTION_MS` goes, so it isn't kept forever. */
export async function pruneRunOutput(app: FastifyInstance) {
  const cutoff = new Date(Date.now() - AGENT_OUTPUT_RETENTION_MS).toISOString();
  await app.db.delete(agentRunOutput).where(lt(agentRunOutput.updatedAt, cutoff));
}

/** Keeps a claim alive. Tells the runner when a person cancelled the run, so it can stop. */
export async function heartbeat(ctx: Ctx, runId: string) {
  const run = await ownRun(ctx, runId);
  // Asking ends the pickup but not the run: stop working, it's not cancelled.
  if (run.status === 'waiting') return { cancelled: false, waiting: true, status: run.status };
  if (!AGENT_RUN_OPEN.includes(run.status) || run.status === 'queued')
    return { cancelled: true, status: run.status };
  const leaseExpiresAt = new Date(Date.now() + AGENT_LEASE_MS).toISOString();
  await ctx.tx.update(agentRuns).set({ leaseExpiresAt }).where(eq(agentRuns.id, runId));
  return { cancelled: false, status: run.status, leaseExpiresAt };
}

/**
 * The runner's report: started, or finished with a summary. A finished run's summary (or, for a
 * failure without one, the error) becomes a comment by the agent, so it's where people look.
 */
export async function reportRun(
  ctx: Ctx,
  runId: string,
  input: {
    status?: 'running' | 'waiting' | 'succeeded' | 'failed';
    sessionUrl?: string | null;
    summary?: string | null;
    error?: string | null;
    failureReason?: AgentRunFailureReason;
    question?: string;
    resume?: string | null;
    usage?: AgentRunUsageReport;
  },
): Promise<AgentRun> {
  let run = await ownRun(ctx, runId);
  const usage = addUsage(input.usage);
  const used = Object.keys(usage).length > 0;
  // The command usually exits after asking; whatever its runner says then changes nothing but
  // the links it can hand on, and what the pickup used. A cancelled run's runner can still say
  // what it used before it stopped.
  const onlyUsage = Object.entries(input).every(([k, v]) => k === 'usage' || v === undefined);
  if (run.status === 'waiting' || (run.status === 'cancelled' && used && onlyUsage)) {
    const links = run.status === 'waiting' && {
      ...(input.sessionUrl !== undefined && { sessionUrl: input.sessionUrl }),
      ...(input.resume !== undefined && { resume: input.resume }),
    };
    if (!used && !(links && Object.keys(links).length)) return toAgentRun(run);
    const [kept] = await ctx.tx
      .update(agentRuns)
      .set({ ...links, ...usage })
      .where(eq(agentRuns.id, runId))
      .returning();
    if (used) await afterUsage(ctx, kept!);
    return toAgentRun(kept!);
  }
  if (run.status !== 'claimed' && run.status !== 'running')
    throw conflict(`This run is ${run.status}`);
  if (input.status === 'waiting') {
    if (!input.question) throw badRequest('Say what you are asking (question)');
    if (input.sessionUrl !== undefined || input.resume !== undefined || used)
      [run] = await ctx.tx
        .update(agentRuns)
        .set({
          ...(input.sessionUrl !== undefined && { sessionUrl: input.sessionUrl }),
          ...(input.resume !== undefined && { resume: input.resume }),
          ...usage,
        })
        .where(eq(agentRuns.id, runId))
        .returning();
    const asked = await askQuestion(ctx, runId, input.question);
    if (used) await afterUsage(ctx, run, { emitted: true });
    return asked;
  }
  const now = new Date().toISOString();
  const final = input.status === 'succeeded' || input.status === 'failed';
  const failure = input.status === 'failed' ? await failureOf(ctx, run, input) : null;
  const [saved] = await ctx.tx
    .update(agentRuns)
    .set({
      ...(input.status && { status: input.status }),
      ...(input.sessionUrl !== undefined && { sessionUrl: input.sessionUrl }),
      ...(input.summary !== undefined && { summary: input.summary }),
      ...(input.error !== undefined && { error: input.error }),
      ...(input.resume !== undefined && { resume: input.resume }),
      ...(input.status === 'running' && !run.startedAt && { startedAt: now }),
      ...(final && { finishedAt: now, leaseExpiresAt: null, startedAt: run.startedAt ?? now }),
      ...(failure && { failureReason: failure.reason, retryAt: failure.retryAt }),
      ...usage,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, runId))
    .returning();
  if (input.status === 'running' && run.status === 'claimed') await logRun(ctx, runId, 'started');
  if (input.status === 'succeeded') await logRun(ctx, runId, 'succeeded');
  if (failure) await logRun(ctx, runId, 'failed', { reason: failure.reason, error: saved!.error });
  if (failure?.reason === 'usage_limit') await pauseAgent(ctx, run.agentId, failure.pauseUntil);
  // A failure is reported as one, even when the runner kept some output as the summary.
  const body =
    input.status === 'succeeded'
      ? saved!.summary?.trim()
      : failure && (await failureComment(ctx, saved!, failure));
  if (body) await createComment(ctx, run.issueId, { body: body.slice(0, 50_000) });
  if (used) await afterUsage(ctx, saved!, { emitted: true });
  await changed(ctx, saved!);
  return toAgentRun(saved!);
}

const USAGE_COLUMNS = {
  inputTokens: agentRuns.inputTokens,
  outputTokens: agentRuns.outputTokens,
  cacheReadTokens: agentRuns.cacheReadTokens,
  cacheWriteTokens: agentRuns.cacheWriteTokens,
  costUsd: agentRuns.costUsd,
  durationMs: agentRuns.durationMs,
} as const;

/** The update that adds a report's usage to the run's (empty when it reported none). */
function addUsage(usage: AgentRunUsageReport | undefined) {
  const set: Partial<Record<keyof typeof USAGE_COLUMNS, SQL>> & { usageAt?: string } = {};
  for (const [key, column] of Object.entries(USAGE_COLUMNS) as [
    keyof typeof USAGE_COLUMNS,
    (typeof USAGE_COLUMNS)[keyof typeof USAGE_COLUMNS],
  ][]) {
    const value = usage?.[key];
    if (value !== undefined) set[key] = sql`coalesce(${column}, 0) + ${value}`;
  }
  if (Object.keys(set).length) set.usageAt = new Date().toISOString();
  return set;
}

/**
 * After a run's usage grew: the agent pauses if that spent its budget, and says so on the issue.
 * Without `emitted`, the run's own change is announced here too.
 */
async function afterUsage(ctx: Ctx, run: RunRow, opts: { emitted?: boolean } = {}) {
  if (!opts.emitted) {
    const teamId = await teamOfIssue(ctx.tx, run.issueId);
    emit(ctx, { kind: 'agentRun', action: 'updated', id: run.id, issueId: run.issueId, teamId });
  }
  const reached = await checkBudget(ctx, run.agentId);
  if (!reached) return;
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  const zone = workspaceSettings(ws!).timezone ?? 'UTC';
  await createComment(ctx, run.issueId, {
    body: `I've spent my monthly budget ($${reached.spent.toFixed(2)} of $${reached.budget.toFixed(2)}), so I'm paused until ${formatInZone(reached.until, zone)}. An admin can raise the budget in Settings → Agents, or resume me from Agent runs.`,
  });
}

/**
 * Holds the agent while this month's runs cost at least its budget (unless "Resume now" waived
 * it), and lifts a budget pause once they don't. Returns what it spent when it just paused it.
 */
async function checkBudget(ctx: Ctx, agentId: string) {
  const [agent] = await ctx.tx
    .select({
      budget: agents.monthlyBudgetUsd,
      waivedUntil: agents.budgetWaivedUntil,
      pausedUntil: agents.pausedUntil,
      pauseReason: agents.pauseReason,
    })
    .from(agents)
    .where(eq(agents.userId, agentId))
    .for('update');
  if (!agent) return null;
  const now = new Date().toISOString();
  const month = monthOf(now);
  const pausedForBudget =
    agent.pauseReason === 'budget' && !!agent.pausedUntil && agent.pausedUntil > now;
  if (agent.budget === null) {
    if (pausedForBudget) await liftPause(ctx, agentId);
    return null;
  }
  const spent =
    (await usageTotals(ctx.tx, ctx.workspaceId, month, { agentId })).get(agentId)?.costUsd ?? 0;
  const over = spent >= agent.budget && !(agent.waivedUntil && agent.waivedUntil > now);
  if (!over) {
    if (pausedForBudget) await liftPause(ctx, agentId);
    return null;
  }
  if (pausedForBudget) return null;
  const until = monthRange(month).end;
  await pauseAgent(ctx, agentId, until, 'budget');
  return { spent, budget: agent.budget, until };
}

async function liftPause(ctx: Ctx, agentId: string) {
  await ctx.tx
    .update(agents)
    .set({ pausedUntil: null, pauseReason: null, updatedAt: new Date().toISOString() })
    .where(eq(agents.userId, agentId));
  emit(ctx, { kind: 'member', action: 'updated', id: agentId });
}

/**
 * Usage of the workspace's runs in a calendar month (UTC), per agent: by when it was reported.
 * With `access`, only runs on issues it can read count.
 */
async function usageTotals(
  db: DbOrTx,
  workspaceId: string,
  month: string,
  opts: { access?: Access; agentId?: string } = {},
) {
  const { start, end } = monthRange(month);
  const total = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::float8`;
  const query = db
    .select({
      agentId: agentRuns.agentId,
      runs: sql<number>`count(*)::int`,
      inputTokens: total(agentRuns.inputTokens),
      outputTokens: total(agentRuns.outputTokens),
      cacheReadTokens: total(agentRuns.cacheReadTokens),
      cacheWriteTokens: total(agentRuns.cacheWriteTokens),
      costUsd: total(agentRuns.costUsd),
      durationMs: total(agentRuns.durationMs),
    })
    .from(agentRuns);
  const scoped = opts.access ? query.innerJoin(issues, eq(issues.id, agentRuns.issueId)) : query;
  const rows = await scoped
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        gte(agentRuns.usageAt, start),
        lt(agentRuns.usageAt, end),
        opts.agentId ? eq(agentRuns.agentId, opts.agentId) : undefined,
        opts.access ? teamScope(opts.access, issues.teamId) : undefined,
      ),
    )
    .groupBy(agentRuns.agentId);
  return new Map(rows.map((r) => [r.agentId, r]));
}

/**
 * `GET /agent-usage`: each agent's tokens, cost and working time in a month, on issues `access`
 * can read, with its budget. Agents with neither usage nor a budget are left out.
 */
export async function listAgentUsage(
  db: DbOrTx,
  access: Access,
  month = monthOf(new Date().toISOString()),
): Promise<AgentUsageTotal[]> {
  const [totals, budgets] = await Promise.all([
    usageTotals(db, access.workspaceId, month, { access }),
    db
      .select({ agentId: agents.userId, budget: agents.monthlyBudgetUsd })
      .from(agents)
      .where(eq(agents.workspaceId, access.workspaceId)),
  ]);
  return budgets
    .filter((b) => totals.has(b.agentId) || b.budget !== null)
    .map((b) => {
      const t = totals.get(b.agentId);
      return {
        agentId: b.agentId,
        month,
        runs: t?.runs ?? 0,
        inputTokens: t?.inputTokens ?? 0,
        outputTokens: t?.outputTokens ?? 0,
        cacheReadTokens: t?.cacheReadTokens ?? 0,
        cacheWriteTokens: t?.cacheWriteTokens ?? 0,
        costUsd: t?.costUsd ?? 0,
        durationMs: t?.durationMs ?? 0,
        budgetUsd: b.budget,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Why a run failed: what its runner says, else what its output says. A usage limit pauses the
 * agent until the limit resets (or an hour, when the output doesn't say), and the run restarts
 * then, unless it's the `AGENT_AUTO_RESTARTS`th limit in a row.
 */
async function failureOf(
  ctx: Ctx,
  run: RunRow,
  input: { error?: string | null; summary?: string | null; failureReason?: AgentRunFailureReason },
) {
  const text = [input.error, input.summary].filter(Boolean).join('\n');
  const reason = input.failureReason ?? classifyFailure(text) ?? 'error';
  if (reason !== 'usage_limit') return { reason, retryAt: null, pauseUntil: null };
  const pauseUntil =
    parseLimitReset(text) ?? new Date(Date.now() + DEFAULT_LIMIT_PAUSE_MS).toISOString();
  const restarts = (await limitStreak(ctx.tx, run.retryOfId)) < AGENT_AUTO_RESTARTS;
  return { reason, retryAt: restarts ? pauseUntil : null, pauseUntil };
}

/**
 * Holds the agent's claims until `until`; a later pause already in place stays, with its reason.
 */
async function pauseAgent(
  ctx: Ctx,
  agentId: string,
  until: string | null,
  reason: AgentPauseReason = 'usage_limit',
) {
  if (!until) return;
  await ctx.tx
    .update(agents)
    .set({
      pausedUntil: sql`greatest(coalesce(${agents.pausedUntil}, ${until}::timestamptz), ${until}::timestamptz)`,
      pauseReason: sql`case when ${agents.pausedUntil} is null or ${agents.pausedUntil} <= ${until}::timestamptz then ${reason} else ${agents.pauseReason} end`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agents.userId, agentId));
  emit(ctx, { kind: 'member', action: 'updated', id: agentId });
}

async function failureComment(
  ctx: Ctx,
  run: RunRow,
  failure: { reason: AgentRunFailureReason; retryAt: string | null; pauseUntil: string | null },
) {
  const error = run.error ?? run.summary;
  const detail = error ? `\n\n\`\`\`\n${error.slice(-2000)}\n\`\`\`` : '';
  if (failure.reason !== 'usage_limit') return `This run failed${detail ? `:${detail}` : '.'}`;
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  const zone = workspaceSettings(ws!).timezone ?? 'UTC';
  const until = formatInZone(failure.pauseUntil!, zone);
  return failure.retryAt
    ? `I hit my usage limit, so I'm paused until ${until}. This run restarts by itself then.${detail}`
    : `I hit my usage limit again, so I'm paused until ${until}. This run has failed on the limit ${AGENT_AUTO_RESTARTS} times in a row, so it won't restart by itself: restart it from Agent runs when the limit is raised.${detail}`;
}

const formatInZone = (iso: string, zone: string) =>
  `${new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso))} (${zone})`;

/**
 * Every minute: runs whose runner went quiet go back in the queue for another runner, or fail
 * after `MAX_ATTEMPTS` claims. Acts as the agent, so the failure comment reads as its own.
 */
export async function reapLeases(app: FastifyInstance) {
  const lapsed = await app.db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ['claimed', 'running']),
        lt(agentRuns.leaseExpiresAt, new Date().toISOString()),
      ),
    )
    .limit(100);
  await forEachIsolated(
    app,
    'agents.leases',
    lapsed,
    (run) => ({ runId: run.id, workspaceId: run.workspaceId }),
    (run) => reapLease(app, run),
  );
}

async function reapLease(app: FastifyInstance, run: typeof agentRuns.$inferSelect) {
  await runInWorkspace(
    app,
    { workspaceId: run.workspaceId, actorId: run.agentId, source: 'system' },
    async (ctx) => {
      const [current] = await ctx.tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, run.id))
        .for('update', { skipLocked: true });
      if (
        !current ||
        (current.status !== 'claimed' && current.status !== 'running') ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt > new Date().toISOString()
      )
        return;
      const failed = current.attempts >= MAX_ATTEMPTS;
      const error = `The runner${current.runnerName ? ` (${current.runnerName})` : ''} stopped responding`;
      const [saved] = await ctx.tx
        .update(agentRuns)
        .set(
          failed
            ? {
                status: 'failed',
                error,
                failureReason: 'runner_lost',
                leaseExpiresAt: null,
                finishedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }
            : {
                status: 'queued',
                error,
                leaseExpiresAt: null,
                runnerName: null,
                updatedAt: new Date().toISOString(),
              },
        )
        .where(eq(agentRuns.id, run.id))
        .returning();
      // Ordo noticed, not the agent.
      await logRun(
        ctx,
        run.id,
        'lapsed',
        { runner: current.runnerName, attempt: current.attempts, failed },
        null,
      );
      if (failed) await logRun(ctx, run.id, 'failed', { reason: 'runner_lost', error }, null);
      if (failed)
        await createComment(ctx, run.issueId, {
          body: `This run failed after ${current.attempts} attempts: ${error.toLowerCase()}.`,
        }).catch(() => {});
      await changed(ctx, saved!);
    },
  );
}

/**
 * Waits until something happens to one of the agent's runs (or `ms` passes, or `signal` aborts),
 * through the realtime fan-out, so it hears about runs queued on any API instance.
 */
export function waitForRuns(
  app: FastifyInstance,
  access: Access,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let remove = () => {};
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      remove();
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    remove = app.realtime.add({
      userId: access.userId,
      workspaceId: access.workspaceId,
      access,
      send: (data) => {
        const e = JSON.parse(data) as RealtimeEvent;
        // A workspace change, or one to the agent itself, may be a pause lifting; an issue
        // change may be a blocker finishing, and a repository change a run limit going up.
        if (
          e.kind === 'agentRun' ||
          e.kind === 'issue' ||
          e.kind === 'workspace' ||
          e.kind === 'repository' ||
          (e.kind === 'member' && e.id === access.userId)
        )
          done();
      },
    });
  });
}

// --- What a runner gets ----------------------------------------------------------------------

/**
 * What the runner gets, and the prompt Ordo keeps: the same, without instructions, parent or
 * related issues. Anyone who sees the issue sees the run's page, while the runner's instructions
 * may hold expanded environment variables, the agent's are for admins only, and the parent and
 * relations are filtered by the agent's teams, not the viewer's.
 */
async function runContext(
  app: FastifyInstance,
  ctx: Ctx,
  run: RunRow,
  runnerInstructions: string,
): Promise<{ context: AgentRunContext; prompt: string }> {
  const detail = await getIssueDetail(ctx.tx, ctx.access, run.issueId);
  const [[agent], [ws], [team], commentRows, states, labelRows] = await Promise.all([
    ctx.tx
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        instructions: agents.instructions,
      })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .where(eq(agents.userId, run.agentId)),
    ctx.tx
      .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)),
    ctx.tx
      .select({ id: teams.id, key: teams.key, name: teams.name })
      .from(teams)
      .where(eq(teams.id, detail.teamId)),
    ctx.tx
      .select({
        id: comments.id,
        issueId: comments.issueId,
        authorId: comments.authorId,
        parentId: comments.parentId,
        body: comments.body,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        editedAt: comments.editedAt,
        author: users.name,
      })
      .from(comments)
      .leftJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.issueId, run.issueId))
      .orderBy(asc(comments.createdAt)),
    ctx.tx
      .select({ id: workflowStates.id, name: workflowStates.name, type: workflowStates.type })
      .from(workflowStates)
      .where(eq(workflowStates.teamId, detail.teamId))
      .orderBy(asc(workflowStates.position)),
    detail.labelIds.length
      ? ctx.tx.select({ name: labels.name }).from(labels).where(inArray(labels.id, detail.labelIds))
      : Promise.resolve([] as { name: string }[]),
  ]);
  const [project] = detail.projectId
    ? await ctx.tx
        .select({ id: projects.id, name: projects.name, description: projects.description })
        .from(projects)
        .where(eq(projects.id, detail.projectId))
    : [];
  const branch = branchName(AGENT_BRANCH_FORMAT, {
    identifier: detail.identifier,
    title: detail.title,
    username: agent!.username,
  });
  // Branches already pushed for the issue, newest first: the work continues there.
  const pushed = await ctx.tx
    .select({ externalId: issueLinks.externalId, data: issueLinks.data })
    .from(issueLinks)
    .where(and(eq(issueLinks.issueId, run.issueId), eq(issueLinks.kind, 'branch')))
    .orderBy(desc(issueLinks.updatedAt));
  const pullRequests = detail.links
    .filter((l) => l.kind === 'pull_request' && l.pullRequest)
    .map((l) => ({ ...l.pullRequest!, url: l.url, title: l.title, state: l.state }))
    .reverse();
  const open = pullRequests.filter((p) => p.state !== 'merged' && p.state !== 'closed');
  const repoList = await repositoriesForIssue(ctx.tx, detail);
  // Work on a pull request continues on its branch; a lone repository takes a lone open PR's.
  const prBranch = (externalRepo: string | null) =>
    open.find((p) => externalRepo && p.repo === externalRepo)?.branch ??
    (repoList.length === 1 && open.length === 1 ? open[0]!.branch : null);
  const pushedBranch = (externalRepo: string | null) => {
    const found = pushed.find(
      (b) =>
        (externalRepo && (b.data as { repo?: string }).repo === externalRepo) ||
        (repoList.length === 1 && pushed.length === 1),
    );
    // externalId is "<repo>:<branch>"; repos have no ":".
    return found ? found.externalId.slice(found.externalId.indexOf(':') + 1) : null;
  };
  const repositories = repoList.map((r) => ({
    ...r,
    suggestedBranch: prBranch(r.externalRepo) ?? pushedBranch(r.externalRepo) ?? branch,
  }));
  const url = `${app.env.publicUrl}/${ws!.slug}/issue/${detail.identifier}`;
  const context: Omit<AgentRunContext, 'prompt'> = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    run: toAgentRun(run),
    workspace: ws!,
    agent: {
      ...agent!,
      instructions: [runnerInstructions, agent!.instructions]
        .map((x) => x.trim())
        .filter(Boolean)
        .join('\n\n'),
    },
    issue: { ...detail, url, team: team! },
    comments: commentRows.map((c) => ({ ...c, reactions: [] })),
    project: project ?? null,
    repositories,
    pullRequests,
    states,
    trigger: {
      kind: run.trigger,
      pullRequest: run.triggerDetail ?? null,
      comment: (() => {
        const c = run.triggerCommentId
          ? commentRows.find((x) => x.id === run.triggerCommentId)
          : undefined;
        return c ? { id: c.id, author: c.author, body: c.body } : null;
      })(),
    },
    assigned: detail.assigneeId === run.agentId,
  };
  const extra = {
    state: states.find((s) => s.id === detail.stateId)?.name ?? '',
    labels: labelRows.map((l) => l.name),
  };
  return {
    context: { ...context, prompt: renderPrompt(context, extra) },
    prompt: renderPrompt(
      {
        ...context,
        agent: { ...context.agent, instructions: '' },
        issue: { ...context.issue, parent: null, relations: [] },
      },
      extra,
    ),
  };
}

function pullRequestReason(pr: AgentRunPullRequest) {
  const ref = `${pr.repo}#${pr.number} (${pr.url}, branch \`${pr.branch}\`)`;
  switch (pr.event) {
    case 'ready_for_review':
      return `Pull request ${ref} is ready for review, and you are this project's pull request agent. Handle it as your instructions say.`;
    case 'checks_failed':
      return `Checks are failing on pull request ${ref}. Find out why, fix it and push to the same branch. Don't open a new pull request.`;
    case 'changes_requested':
      return `A reviewer requested changes on pull request ${ref}. Read the review on the forge, address it and push to the same branch. Don't open a new pull request.`;
  }
}

const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

/** The run as one Markdown prompt. Runners are free to build their own from the context. */
export function renderPrompt(
  c: Omit<AgentRunContext, 'prompt'>,
  extra: { state: string; labels: string[] },
): string {
  const { issue } = c;
  const out: string[] = [];
  const intro = `You are ${c.agent.name} (@${c.agent.username}), an agent on the ${c.workspace.name} workspace in Ordo, an issue tracker.`;
  out.push(
    c.assigned
      ? `${intro} You have been assigned ${issue.identifier}. Work on it, and report back on the issue.`
      : `${intro} Someone asked for your help on ${issue.identifier}, which isn't assigned to you.`,
  );
  out.push(`# ${issue.identifier}: ${issue.title}`);
  const meta = [
    `Team: ${issue.team.name} (${issue.team.key})`,
    `Status: ${extra.state}`,
    `Priority: ${PRIORITY_NAMES[issue.priority] ?? issue.priority}`,
    extra.labels.length ? `Labels: ${extra.labels.join(', ')}` : null,
    c.project ? `Project: ${c.project.name}` : null,
    issue.dueDate ? `Due: ${issue.dueDate}` : null,
    `Link: ${issue.url}`,
  ].filter(Boolean);
  out.push(meta.map((m) => `- ${m}`).join('\n'));
  out.push(issue.description.trim() || '_No description._');
  if (issue.parent) out.push(`Parent issue: ${issue.parent.identifier} ${issue.parent.title}`);
  if (issue.relations.length)
    out.push(
      `## Related issues\n${issue.relations.map((r) => `- ${r.type}: ${r.issue.identifier} ${r.issue.title}`).join('\n')}`,
    );
  if (c.comments.length)
    out.push(
      `## Comments\n${c.comments
        .map(
          (m) =>
            `**${m.author ?? 'Deleted user'}** (${m.createdAt.slice(0, 16).replace('T', ' ')}):\n${m.body}`,
        )
        .join('\n\n')}`,
    );
  if (c.pullRequests.length)
    out.push(
      `## Pull requests\n${c.pullRequests
        .map((p) => {
          const signals = [
            p.state,
            p.checks && `checks ${p.checks}`,
            p.review?.replace('_', ' '),
          ].filter(Boolean);
          return `- ${p.repo}#${p.number} (${signals.join(', ')}), branch \`${p.branch}\`: ${p.url}`;
        })
        .join('\n')}`,
    );
  if (c.repositories.length)
    out.push(
      `## Repositories\n${c.repositories
        .map((r) => `- ${r.name}: ${r.url} (default branch ${r.defaultBranch})`)
        .join(
          '\n',
        )}\n\nWork on a branch named \`${c.repositories[0]!.suggestedBranch}\`, and mention ${issue.identifier} in commit messages and pull requests so they link to the issue.`,
    );
  if (c.project?.description?.trim())
    out.push(`## About the project\n${c.project.description.trim()}`);
  if (c.agent.instructions.trim()) out.push(`## Instructions\n${c.agent.instructions.trim()}`);
  const asked = c.trigger.kind === 'mention' ? c.trigger.comment : null;
  if (asked)
    out.push(
      `## Why you're here\n${asked.author ?? 'Someone'} mentioned you in a comment:\n\n${asked.body
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')}\n\n${
        c.assigned
          ? 'Do what it asks as part of your work on the issue.'
          : "Do what it asks and answer in a comment. The issue isn't yours: don't change its status or assignee, or take on the work itself, unless the comment asks you to."
      }`,
    );
  const pr = c.trigger.kind === 'pull_request' ? c.trigger.pullRequest : null;
  if (pr) out.push(`## Why you're here\n${pullRequestReason(pr)}`);
  if (c.trigger.kind === 'scheduled')
    out.push(
      "## Why you're here\nA recurring schedule created this issue and assigned it to you. Its description is your task for this occurrence: do it now. The schedule creates a new issue next time, so finish this one instead of waiting for later.",
    );
  if (c.run.question)
    out.push(
      `## You asked\n${c.run.question}\n\nThe answer is in the comments after your question. Continue from there.`,
    );
  out.push(
    `## Reporting\nIf you need an answer before you can continue, ask it with the \`ask_question\` tool of the Ordo MCP server or \`ordo agent ask "<question>"\`, then stop: the run pauses, and it resumes when someone replies. At each new step of the work, say what you are doing with the \`report_progress\` tool (a few words, and a rough percentage if you can tell); people watching the run see the latest one. When you are done, end with a short summary of what you did and anything a reviewer should check; it is posted on the issue.`,
  );
  return out.join('\n\n');
}
