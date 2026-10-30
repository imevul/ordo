import type { AgentRunPullRequest, PullRequestRunEvent } from '@ordo/shared';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  issueLinks,
  issues,
  projectRepositories,
  projects,
  projectTeams,
  repositories,
  teamMembers,
  teams,
  workflowStates,
} from '../db/schema.ts';
import type { IntegrationContext } from '../integrations/types.ts';
import { isActiveAgent, queueRun } from './agents.ts';
import { createComment } from './comments.ts';
import type { Ctx } from './context.ts';
import type { ForgePullRequest, PullRequestState } from './forge.ts';
import { createIssue, updateIssue } from './issues.ts';
import type { PullRequestData } from './links.ts';

/**
 * Who hears about a pull request. Two rules, and nothing that knows about roles or pipelines:
 *
 * - A project can name a pull request agent. When one of its pull requests becomes ready for
 *   review, the issue goes to that agent (or, if a person has it, the agent gets a run beside
 *   them), once per pull request. With scope `all`, a pull request that links no issue gets one.
 * - The issue's assignee, if it's an agent, gets a run when checks start failing or a reviewer
 *   requests changes — up to `MAX_FOLLOW_UPS` in a row, so two bots can't loop forever.
 *
 * What an agent does with the pull request (review, merge, fix) is up to its instructions.
 */

export const MAX_FOLLOW_UPS = 3;

const isReady = (state: PullRequestState | string | null | undefined) =>
  state === 'open' || state === 'review';

/** Projects that list the pull request's repository, in their order. */
async function projectsWithRepo(ctx: Ctx, integrationId: string, repo: string) {
  return ctx.tx
    .selectDistinct({
      id: projects.id,
      agentId: projects.pullRequestAgentId,
      scope: projects.pullRequestScope,
      sortOrder: projects.sortOrder,
    })
    .from(projects)
    .innerJoin(projectRepositories, eq(projectRepositories.projectId, projects.id))
    .innerJoin(repositories, eq(repositories.id, projectRepositories.repositoryId))
    .where(
      and(
        eq(projects.workspaceId, ctx.workspaceId),
        sql`lower(${repositories.externalRepo}) = lower(${repo})`,
        or(eq(repositories.integrationId, integrationId), isNull(repositories.integrationId)),
      ),
    )
    .orderBy(asc(projects.sortOrder));
}

/** The first of the project's teams the agent works in. */
async function teamForAgent(ctx: Ctx, projectId: string, agentId: string) {
  const [row] = await ctx.tx
    .select({ id: teams.id })
    .from(projectTeams)
    .innerJoin(teams, eq(teams.id, projectTeams.teamId))
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, agentId)))
    .where(eq(projectTeams.projectId, projectId))
    .orderBy(asc(teams.key));
  return row?.id ?? null;
}

/** Whether `agentId` can take the project's pull requests: an active agent in one of its teams. */
export async function canTakePullRequests(ctx: Ctx, projectId: string, agentId: string) {
  return (
    (await isActiveAgent(ctx.tx, ctx.workspaceId, agentId)) &&
    !!(await teamForAgent(ctx, projectId, agentId))
  );
}

/**
 * For scope `all`: an issue for a pull request that links none, assigned to the project's
 * agent. Null when no project wants it.
 */
export async function issueForPullRequest(
  ctx: Ctx,
  ictx: IntegrationContext,
  pr: ForgePullRequest,
) {
  if (!isReady(pr.state)) return null;
  for (const project of await projectsWithRepo(ctx, ictx.integration.id, pr.repo)) {
    if (project.scope !== 'all' || !project.agentId) continue;
    if (!(await isActiveAgent(ctx.tx, ctx.workspaceId, project.agentId))) continue;
    const teamId = await teamForAgent(ctx, project.id, project.agentId);
    if (!teamId) continue;
    const by = pr.author ? ` by ${pr.author.login}` : '';
    const issue = await createIssue(ctx, {
      teamId,
      projectId: project.id,
      title: `${pr.repo}#${pr.number}: ${pr.title}`.slice(0, 500),
      description: `Pull request [${pr.repo}#${pr.number}](${pr.url}), opened${by} outside Ordo.`,
      assigneeId: project.agentId,
    });
    return { issue, agentId: project.agentId };
  }
  return null;
}

/** Turns the run an assignment just queued into the pull request run it really is. */
export async function tagQueuedRun(
  ctx: Ctx,
  issueId: string,
  agentId: string,
  pullRequest: AgentRunPullRequest,
) {
  await ctx.tx
    .update(agentRuns)
    .set({ trigger: 'pull_request', triggerDetail: pullRequest })
    .where(
      and(
        eq(agentRuns.issueId, issueId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.status, 'queued'),
        eq(agentRuns.trigger, 'assigned'),
      ),
    );
}

interface IssueState {
  id: string;
  assigneeId: string | null;
  projectId: string | null;
  done: boolean;
}

async function issueState(ctx: Ctx, issueId: string): Promise<IssueState | null> {
  const [row] = await ctx.tx
    .select({
      id: issues.id,
      assigneeId: issues.assigneeId,
      projectId: issues.projectId,
      type: workflowStates.type,
    })
    .from(issues)
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)));
  if (!row) return null;
  return { ...row, done: row.type === 'completed' || row.type === 'canceled' };
}

export interface PullRequestChange {
  issueId: string;
  linkId: string;
  url: string;
  data: PullRequestData;
  state: PullRequestState | string | null;
  prevState: string | null;
  prevChecks: string | null;
  /** A review that just came in. */
  reviewed?: boolean;
}

/** Called for each issue a pull request event touched, after its link is saved. */
export async function onPullRequestChange(
  ctx: Ctx,
  ictx: IntegrationContext,
  c: PullRequestChange,
) {
  if (!isReady(c.state)) return;
  const issue = await issueState(ctx, c.issueId);
  if (!issue || issue.done) return;
  const detail = (event: PullRequestRunEvent): AgentRunPullRequest => ({
    event,
    repo: c.data.repo,
    number: c.data.number,
    url: c.url,
    branch: c.data.branch,
  });
  if (!isReady(c.prevState) && !c.data.handedOffTo) {
    if (await handOff(ctx, ictx, issue, c, detail('ready_for_review'))) return;
  }
  if (c.data.checks === 'failing' && c.prevChecks !== 'failing')
    await followUp(ctx, issue, c, detail('checks_failed'));
  else if (c.reviewed && c.data.review === 'changes_requested')
    await followUp(ctx, issue, c, detail('changes_requested'));
}

async function markHandedOff(ctx: Ctx, linkId: string, agentId: string) {
  await ctx.tx
    .update(issueLinks)
    .set({ data: sql`${issueLinks.data} || ${JSON.stringify({ handedOffTo: agentId })}::jsonb` })
    .where(eq(issueLinks.id, linkId));
}

/** The project's pull request agent takes over. True if one did. */
async function handOff(
  ctx: Ctx,
  ictx: IntegrationContext,
  issue: IssueState,
  c: PullRequestChange,
  pullRequest: AgentRunPullRequest,
) {
  if (!issue.projectId) return false;
  const project = (await projectsWithRepo(ctx, ictx.integration.id, c.data.repo)).find(
    (p) => p.id === issue.projectId,
  );
  const agentId = project?.agentId;
  if (!agentId || !(await isActiveAgent(ctx.tx, ctx.workspaceId, agentId))) return false;
  await markHandedOff(ctx, c.linkId, agentId);
  const assignee = issue.assigneeId;
  const assigneeIsAgent = !!assignee && (await isAgent(ctx, assignee));
  if (assignee === agentId) {
    await queueRun(ctx, issue.id, agentId, { kind: 'pull_request', pullRequest });
  } else if (!assignee || assigneeIsAgent) {
    await updateIssue(ctx, issue.id, { assigneeId: agentId });
    await tagQueuedRun(ctx, issue.id, agentId, pullRequest);
  } else {
    // A person has it: they keep it, and the agent helps.
    await queueRun(ctx, issue.id, agentId, { kind: 'pull_request', pullRequest });
  }
  return true;
}

async function isAgent(ctx: Ctx, userId: string) {
  const [row] = await ctx.tx
    .select({ id: agents.userId })
    .from(agents)
    .where(eq(agents.userId, userId));
  return !!row;
}

/** The assignee hears about failing checks or requested changes, if it's an agent that wants to. */
async function followUp(
  ctx: Ctx,
  issue: IssueState,
  c: PullRequestChange,
  pullRequest: AgentRunPullRequest,
) {
  const agentId = issue.assigneeId;
  if (!agentId || !(await isActiveAgent(ctx.tx, ctx.workspaceId, agentId))) return;
  const [settings] = await ctx.tx
    .select({ follow: agents.followPullRequests })
    .from(agents)
    .where(eq(agents.userId, agentId));
  if (!settings?.follow) return;
  const recent = await ctx.tx
    .select({ id: agentRuns.id, trigger: agentRuns.trigger, detail: agentRuns.triggerDetail })
    .from(agentRuns)
    .where(eq(agentRuns.issueId, issue.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(MAX_FOLLOW_UPS);
  const isFollowUp = (r: (typeof recent)[number]) =>
    r.trigger === 'pull_request' && r.detail?.event !== 'ready_for_review';
  // A queued follow-up already covers this; one more would only repeat it.
  const pending = await ctx.tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.issueId, issue.id),
        eq(agentRuns.agentId, agentId),
        inArray(agentRuns.status, ['queued', 'waiting']),
      ),
    );
  if (!pending.length && recent.length === MAX_FOLLOW_UPS && recent.every(isFollowUp)) {
    // Say so once per streak: the newest run is the one we stopped after.
    if (c.data.stoppedAfter === recent[0]!.id) return;
    await ctx.tx
      .update(issueLinks)
      .set({
        data: sql`${issueLinks.data} || ${JSON.stringify({ stoppedAfter: recent[0]!.id })}::jsonb`,
      })
      .where(eq(issueLinks.id, c.linkId));
    const what =
      pullRequest.event === 'checks_failed' ? 'Checks are failing' : 'Changes were requested';
    await createComment(ctx, issue.id, {
      body: `${what} on [${pullRequest.repo}#${pullRequest.number}](${pullRequest.url}) again. Stopped asking the agent after ${MAX_FOLLOW_UPS} tries in a row; run it again or mention it to continue.`,
    });
    return;
  }
  await queueRun(ctx, issue.id, agentId, { kind: 'pull_request', pullRequest });
}
