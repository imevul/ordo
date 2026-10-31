import type {
  CreateMilestoneInput,
  CreateProjectInput,
  Milestone,
  Project,
  ProjectHealth,
  UpdateMilestoneInput,
} from '@ordo/shared';
import { and, asc, desc, eq, exists, inArray, max, min, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  projectMilestones,
  projects,
  projectTeams,
  projectUpdates,
  teams,
  workspaceMembers,
} from '../db/schema.ts';
import { badRequest, forbidden, notFound, one } from '../lib/errors.ts';
import { type Access, assertCan, canReadTeam } from './access.ts';
import { type Ctx, emit, record } from './context.ts';
import { assertInitiative } from './initiatives.ts';
import { progressBy } from './progress.ts';
import { canTakePullRequests } from './pullRequests.ts';
import { projectRepositoryIds, setProjectRepositories } from './repositories.ts';
import { toMilestone, toProject } from './serialize.ts';

export async function assertProjectTeams(ctx: Ctx, teamIds: string[]) {
  const rows = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, ctx.workspaceId), inArray(teams.id, teamIds)));
  if (rows.length !== new Set(teamIds).size || teamIds.some((t) => !canReadTeam(ctx.access, t))) {
    throw badRequest('Unknown team').as('unknown_team');
  }
}

/** Throws unless `userId` is a member of the workspace (people and agents alike). */
export async function assertProjectLead(
  ctx: Ctx,
  leadId: string | null | undefined,
  what = 'Lead',
) {
  if (!leadId) return;
  const [m] = await ctx.tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, leadId)),
    );
  if (!m) throw badRequest(`${what} is not a workspace member`);
}

/** A project's `defaultAssignee` input as its two columns; a member must be in the workspace. */
export async function defaultAssigneeColumns(
  ctx: Ctx,
  value: string | undefined,
): Promise<
  Pick<Partial<typeof projects.$inferInsert>, 'defaultAssigneeMode' | 'defaultAssigneeId'>
> {
  if (value === undefined) return {};
  if (value === 'workspace' || value === 'none')
    return { defaultAssigneeMode: value as 'workspace' | 'none', defaultAssigneeId: null };
  await assertProjectLead(ctx, value, 'Default assignee');
  return { defaultAssigneeMode: 'member', defaultAssigneeId: value };
}

/**
 * Sets who gets the project's pull requests. Admins only; the agent must work in one of the
 * project's teams, so call it after the teams are saved.
 */
export async function setPullRequestAgent(
  ctx: Ctx,
  projectId: string,
  input: Pick<CreateProjectInput, 'pullRequestAgentId' | 'pullRequestScope'>,
) {
  if (input.pullRequestAgentId === undefined && input.pullRequestScope === undefined) return;
  if (!ctx.access.isAdmin) throw forbidden('Only admins can choose a pull request agent');
  if (
    input.pullRequestAgentId &&
    !(await canTakePullRequests(ctx, projectId, input.pullRequestAgentId))
  )
    throw badRequest("The pull request agent must be an agent in one of the project's teams");
  await ctx.tx
    .update(projects)
    .set({
      ...(input.pullRequestAgentId !== undefined && {
        pullRequestAgentId: input.pullRequestAgentId,
      }),
      ...(input.pullRequestScope !== undefined && { pullRequestScope: input.pullRequestScope }),
    })
    .where(eq(projects.id, projectId));
}

/** Creates a project at the top of the list; returns its id. */
export async function createProject(ctx: Ctx, input: CreateProjectInput): Promise<string> {
  assertCan(ctx.access, 'projects.create', 'Guests cannot create projects');
  await assertProjectTeams(ctx, input.teamIds);
  await assertProjectLead(ctx, input.leadId);
  await assertInitiative(ctx, input.initiativeId);
  const [{ first }] = (await ctx.tx
    .select({ first: min(projects.sortOrder) })
    .from(projects)
    .where(eq(projects.workspaceId, ctx.workspaceId))) as [{ first: number | null }];
  const { teamIds, repositoryIds, defaultAssignee, pullRequestAgentId, pullRequestScope, ...rest } =
    input;
  const row = one(
    await ctx.tx
      .insert(projects)
      .values({
        ...rest,
        ...(await defaultAssigneeColumns(ctx, defaultAssignee)),
        workspaceId: ctx.workspaceId,
        createdBy: ctx.userId,
        sortOrder: (first ?? 0) - 1024,
      })
      .returning({ id: projects.id }),
  );
  await ctx.tx
    .insert(projectTeams)
    .values(teamIds.map((teamId) => ({ projectId: row.id, teamId })));
  if (repositoryIds?.length) await setProjectRepositories(ctx, row.id, repositoryIds);
  await setPullRequestAgent(ctx, row.id, { pullRequestAgentId, pullRequestScope });
  emit(ctx, { kind: 'project', action: 'created', id: row.id });
  const [project] = await listProjects(ctx.tx, ctx.access, row.id);
  record(ctx, 'project.created', project!, { teamIds: project!.teamIds });
  return row.id;
}

/**
 * Projects visible to `access`: those linked to at least one readable team. Linked teams the
 * viewer can't see are left out of `teamIds`, and progress counts only visible issues.
 */
export async function listProjects(
  db: DbOrTx,
  access: Access,
  onlyId?: string,
): Promise<Project[]> {
  const visible = access.isAdmin
    ? undefined
    : access.teamIds.length
      ? exists(
          db
            .select({ one: sql`1` })
            .from(projectTeams)
            .where(
              and(
                sql`${projectTeams.projectId} = "projects"."id"`,
                inArray(projectTeams.teamId, access.teamIds),
              ),
            ),
        )
      : sql`false`;
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, access.workspaceId),
        onlyId ? eq(projects.id, onlyId) : undefined,
        visible,
      ),
    )
    .orderBy(asc(projects.sortOrder), asc(projects.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((p) => p.id);
  const [links, progress, updates, milestoneRows, milestoneProgress, repos] = await Promise.all([
    db.select().from(projectTeams).where(inArray(projectTeams.projectId, ids)),
    progressBy(db, 'project_id', access),
    db
      .selectDistinctOn([projectUpdates.projectId], {
        projectId: projectUpdates.projectId,
        health: projectUpdates.health,
      })
      .from(projectUpdates)
      .where(inArray(projectUpdates.projectId, ids))
      .orderBy(projectUpdates.projectId, desc(projectUpdates.createdAt)),
    db
      .select()
      .from(projectMilestones)
      .where(inArray(projectMilestones.projectId, ids))
      .orderBy(
        sql`${projectMilestones.targetDate} asc nulls last`,
        asc(projectMilestones.sortOrder),
        asc(projectMilestones.createdAt),
      ),
    progressBy(db, 'milestone_id', access),
    projectRepositoryIds(db, ids),
  ]);
  const health = new Map<string, ProjectHealth>(updates.map((u) => [u.projectId, u.health]));
  return rows.map((p) =>
    toProject(
      p,
      links
        .filter((l) => l.projectId === p.id && canReadTeam(access, l.teamId))
        .map((l) => l.teamId),
      progress.get(p.id),
      health.get(p.id),
      milestoneRows
        .filter((m) => m.projectId === p.id)
        .map((m) => toMilestone(m, milestoneProgress.get(m.id))),
      repos.get(p.id),
    ),
  );
}

/**
 * A project the caller can see and change: visible through one of its teams, and not a guest.
 * With `plan`, an agent (a guest of its teams) may too, for planning work such as milestones.
 */
export async function loadProject(ctx: Ctx, id: string, opts: { plan?: boolean } = {}) {
  const [visible] = await listProjects(ctx.tx, ctx.access, id);
  if (!visible) throw notFound('Project');
  if (ctx.access.isGuest && !(opts.plan && ctx.access.isAgent))
    throw forbidden('Guests cannot change projects').as('guests_projects');
  const [p] = await ctx.tx.select().from(projects).where(eq(projects.id, id));
  return p!;
}

// Milestones are part of their project: changes come back as the project (and reach webhooks as
// project.updated).

export async function projectChanged(ctx: Ctx, projectId: string) {
  emit(ctx, { kind: 'project', action: 'updated', id: projectId });
  const [project] = await listProjects(ctx.tx, ctx.access, projectId);
  record(ctx, 'project.updated', project!, { teamIds: project!.teamIds });
  return project!;
}

export async function loadMilestone(ctx: Ctx, id: string) {
  const [m] = await ctx.tx.select().from(projectMilestones).where(eq(projectMilestones.id, id));
  if (!m) throw notFound('Milestone');
  await loadProject(ctx, m.projectId, { plan: true });
  return m;
}

/** Adds a milestone at the end of the project's list. */
export async function createMilestone(
  ctx: Ctx,
  projectId: string,
  input: CreateMilestoneInput,
): Promise<{ milestone: Milestone; project: Project }> {
  await loadProject(ctx, projectId, { plan: true });
  const [{ last }] = (await ctx.tx
    .select({ last: max(projectMilestones.sortOrder) })
    .from(projectMilestones)
    .where(eq(projectMilestones.projectId, projectId))) as [{ last: number | null }];
  const row = one(
    await ctx.tx
      .insert(projectMilestones)
      .values({ ...input, projectId, sortOrder: (last ?? 0) + 1024 })
      .returning(),
  );
  const project = await projectChanged(ctx, projectId);
  return { milestone: project.milestones.find((m) => m.id === row.id)!, project };
}

export async function updateMilestone(ctx: Ctx, id: string, input: UpdateMilestoneInput) {
  const m = await loadMilestone(ctx, id);
  await ctx.tx.update(projectMilestones).set(input).where(eq(projectMilestones.id, id));
  return projectChanged(ctx, m.projectId);
}
