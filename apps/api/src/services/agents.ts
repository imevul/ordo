import {
  AGENT_PROTOCOL_VERSION,
  AGENT_RUN_OPEN,
  type Agent,
  type AgentIdentity,
  type AgentRun,
  type AgentRunContext,
  type AgentRunTrigger,
  type AgentRunWithIssue,
  AVATAR_COLORS,
  branchName,
  type createAgentSchema,
  DEFAULT_BRANCH_FORMAT,
  type RealtimeEvent,
  type updateAgentSchema,
} from '@ordo/shared';
import { and, asc, desc, eq, inArray, isNull, lt, not, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DbOrTx } from '../db/client.ts';
import {
  agentRuns,
  agents,
  apiKeys,
  comments,
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
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { type Access, teamScope } from './access.ts';
import { auditCtx } from './audit.ts';
import { createComment } from './comments.ts';
import { type Ctx, emit, record } from './context.ts';
import { getIssue, getIssueDetail } from './issues.ts';
import { repositoriesForIssue } from './repositories.ts';
import { joinWorkspace } from './workspaces.ts';

/**
 * Agents: members that aren't people. An agent is a `kind: 'agent'` user, a guest of its workspace
 * (so it sees exactly the teams it was added to), and an `agents` row with its settings. Assigning
 * an issue to one queues a run; runners holding the agent's API key claim runs, keep them alive by
 * heartbeat and report how they ended. Ordo never runs anything itself.
 */

/** How long a claim holds without a heartbeat. */
export const LEASE_MS = 5 * 60_000;
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
      createdAt: agents.createdAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(users.name));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [memberships, keys] = await Promise.all([
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
  ]);
  return rows.map(({ disabledAt, ...r }) => ({
    ...r,
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
  const [user] = await ctx.tx
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
    .returning({ id: users.id });
  const id = user!.id;
  // Guests see only the teams they're on, which is exactly an agent's reach.
  await joinWorkspace(ctx.tx, ctx.workspaceId, id, 'guest', input.teamIds);
  await ctx.tx.insert(agents).values({
    userId: id,
    workspaceId: ctx.workspaceId,
    instructions: input.instructions,
    concurrency: input.concurrency,
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
  if (input.instructions !== undefined || input.concurrency !== undefined)
    await ctx.tx
      .update(agents)
      .set({
        ...(input.instructions !== undefined && { instructions: input.instructions }),
        ...(input.concurrency !== undefined && { concurrency: input.concurrency }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agents.userId, agentId));
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
  const [row] = await ctx.tx
    .insert(apiKeys)
    .values({ userId: agentId, name, tokenHash: sha256(token), prefix: token.slice(0, 12) })
    .returning({ id: apiKeys.id });
  await auditCtx(ctx, {
    action: 'agent.key_created',
    targetType: 'user',
    targetId: agentId,
    data: { name, keyId: row!.id },
  });
  return { id: row!.id, token };
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
  question: r.question,
  resume: r.resume,
  trigger: r.trigger,
  triggerCommentId: r.triggerCommentId,
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

/** Whether `userId` is an enabled agent of this workspace. */
async function isActiveAgent(tx: DbOrTx, workspaceId: string, userId: string) {
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
async function queueRun(
  ctx: Ctx,
  issueId: string,
  agentId: string,
  trigger: { kind: AgentRunTrigger; commentId?: string } = { kind: 'assigned' },
  opts: { followUp?: boolean } = {},
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
  const [run] = await ctx.tx
    .insert(agentRuns)
    .values({
      workspaceId: ctx.workspaceId,
      issueId,
      agentId,
      requestedById: ctx.userId,
      trigger: trigger.kind,
      triggerCommentId: trigger.commentId ?? null,
    })
    .returning();
  await changed(ctx, run!);
  return run!;
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
  for (const run of cancelled) await changed(ctx, run);
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
    await queueRun(ctx, issueId, next);
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

/** Waiting runs matching `where` go back in the queue; lapsed-lease counting starts over. */
async function resumeRuns(ctx: Ctx, where: ReturnType<typeof eq>) {
  const resumed = await ctx.tx
    .update(agentRuns)
    .set({ status: 'queued', attempts: 0, updatedAt: new Date().toISOString() })
    .where(and(where, eq(agentRuns.status, 'waiting')))
    .returning();
  for (const run of resumed) await changed(ctx, run);
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
  if (waiting) await resumeRuns(ctx, eq(agentRuns.issueId, issueId));
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

export async function cancelRun(ctx: Ctx, runId: string): Promise<AgentRun> {
  const run = await loadRun(ctx, runId);
  await cancelOpenRuns(ctx, eq(agentRuns.id, run.id), 'Cancelled');
  return toAgentRun(await loadRun(ctx, runId));
}

export async function listRuns(db: DbOrTx, access: Access, issueIdOrIdentifier: string) {
  const issue = await getIssue(db, access, issueIdOrIdentifier);
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.issueId, issue.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
  return rows.map(toAgentRun);
}

/**
 * Runs across the workspace, on issues `access` can read: active ones (open, waiting included)
 * first by when they last changed, or finished ones, newest first.
 */
export async function listWorkspaceRuns(
  db: DbOrTx,
  access: Access,
  opts: { status: 'active' | 'finished' | 'all'; agentId?: string; limit: number },
): Promise<AgentRunWithIssue[]> {
  const open = inArray(agentRuns.status, [...AGENT_RUN_OPEN]);
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
        opts.status === 'active' ? open : opts.status === 'finished' ? not(open) : undefined,
      ),
    )
    .orderBy(desc(agentRuns.updatedAt))
    .limit(opts.limit);
  return rows.map((r) => ({
    ...toAgentRun(r.run),
    issue: {
      id: r.run.issueId,
      identifier: `${r.teamKey}-${r.number}`,
      title: r.title,
      stateId: r.stateId,
      teamId: r.teamId,
    },
  }));
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
  const [agent] = await ctx.tx
    .select({ concurrency: agents.concurrency })
    .from(agents)
    .where(eq(agents.userId, ctx.userId))
    .for('update');
  if (!agent) throw notFound('Agent');
  const [{ busy }] = (await ctx.tx
    .select({ busy: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.agentId, ctx.userId), inArray(agentRuns.status, ['claimed', 'running'])),
    )) as [{ busy: number }];
  if (busy >= agent.concurrency) return null;
  const [next] = await ctx.tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agentId, ctx.userId),
        eq(agentRuns.status, 'queued'),
        // One run per issue at a time: a follow-up waits for the agent's run there to finish.
        sql`not exists (select 1 from agent_runs busy where busy.issue_id = "agent_runs"."issue_id" and busy.agent_id = "agent_runs"."agent_id" and busy.status in ('claimed', 'running'))`,
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
      leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      runnerName,
      error: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentRuns.id, next.id))
    .returning();
  return run!;
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
          const context = await runContext(app, ctx, run, runnerInstructions);
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

/** Keeps a claim alive. Tells the runner when a person cancelled the run, so it can stop. */
export async function heartbeat(ctx: Ctx, runId: string) {
  const run = await ownRun(ctx, runId);
  // Asking ends the pickup but not the run: stop working, it's not cancelled.
  if (run.status === 'waiting') return { cancelled: false, waiting: true, status: run.status };
  if (!AGENT_RUN_OPEN.includes(run.status) || run.status === 'queued')
    return { cancelled: true, status: run.status };
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
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
    question?: string;
    resume?: string | null;
  },
): Promise<AgentRun> {
  let run = await ownRun(ctx, runId);
  // The command usually exits after asking; whatever its runner says then changes nothing but
  // the links it can hand on.
  if (run.status === 'waiting') {
    if (input.sessionUrl === undefined && input.resume === undefined) return toAgentRun(run);
    const [kept] = await ctx.tx
      .update(agentRuns)
      .set({
        ...(input.sessionUrl !== undefined && { sessionUrl: input.sessionUrl }),
        ...(input.resume !== undefined && { resume: input.resume }),
      })
      .where(eq(agentRuns.id, runId))
      .returning();
    return toAgentRun(kept!);
  }
  if (run.status !== 'claimed' && run.status !== 'running')
    throw conflict(`This run is ${run.status}`);
  if (input.status === 'waiting') {
    if (!input.question) throw badRequest('Say what you are asking (question)');
    if (input.sessionUrl !== undefined || input.resume !== undefined)
      [run] = await ctx.tx
        .update(agentRuns)
        .set({
          ...(input.sessionUrl !== undefined && { sessionUrl: input.sessionUrl }),
          ...(input.resume !== undefined && { resume: input.resume }),
        })
        .where(eq(agentRuns.id, runId))
        .returning();
    return askQuestion(ctx, runId, input.question);
  }
  const now = new Date().toISOString();
  const final = input.status === 'succeeded' || input.status === 'failed';
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
      updatedAt: now,
    })
    .where(eq(agentRuns.id, runId))
    .returning();
  if (final) {
    const body = saved!.summary?.trim()
      ? saved!.summary.trim()
      : input.status === 'failed'
        ? `This run failed${saved!.error ? `:\n\n\`\`\`\n${saved!.error.slice(-2000)}\n\`\`\`` : '.'}`
        : null;
    if (body) await createComment(ctx, run.issueId, { body: body.slice(0, 50_000) });
  }
  await changed(ctx, saved!);
  return toAgentRun(saved!);
}

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
  for (const run of lapsed) {
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
                  leaseExpiresAt: null,
                  finishedAt: new Date().toISOString(),
                }
              : { status: 'queued', error, leaseExpiresAt: null, runnerName: null },
          )
          .where(eq(agentRuns.id, run.id))
          .returning();
        if (failed)
          await createComment(ctx, run.issueId, {
            body: `This run failed after ${current.attempts} attempts: ${error.toLowerCase()}.`,
          }).catch(() => {});
        await changed(ctx, saved!);
      },
    );
  }
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
        if (e.kind === 'agentRun') done();
      },
    });
  });
}

// --- What a runner gets ----------------------------------------------------------------------

async function runContext(
  app: FastifyInstance,
  ctx: Ctx,
  run: RunRow,
  runnerInstructions: string,
): Promise<AgentRunContext> {
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
  const branch = branchName(DEFAULT_BRANCH_FORMAT, {
    identifier: detail.identifier,
    title: detail.title,
    username: agent!.username,
  });
  const repositories = (await repositoriesForIssue(ctx.tx, detail)).map((r) => ({
    ...r,
    suggestedBranch: branch,
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
    states,
    trigger: {
      kind: run.trigger,
      comment: (() => {
        const c = run.triggerCommentId
          ? commentRows.find((x) => x.id === run.triggerCommentId)
          : undefined;
        return c ? { id: c.id, author: c.author, body: c.body } : null;
      })(),
    },
    assigned: detail.assigneeId === run.agentId,
  };
  const stateName = states.find((s) => s.id === detail.stateId)?.name ?? '';
  return {
    ...context,
    prompt: renderPrompt(context, {
      state: stateName,
      labels: labelRows.map((l) => l.name),
    }),
  };
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
  if (c.run.question)
    out.push(
      `## You asked\n${c.run.question}\n\nThe answer is in the comments after your question. Continue from there.`,
    );
  out.push(
    `## Reporting\nIf you need an answer before you can continue, ask it with the \`ask_question\` tool of the Ordo MCP server or \`ordo agent ask "<question>"\`, then stop: the run pauses, and it resumes when someone replies. When you are done, end with a short summary of what you did and anything a reviewer should check; it is posted on the issue.`,
  );
  return out.join('\n\n');
}
