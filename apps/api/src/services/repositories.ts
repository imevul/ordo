import type {
  createRepositorySchema,
  Issue,
  Repository,
  updateRepositorySchema,
} from '@ordo/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { DbOrTx } from '../db/client.ts';
import { integrations, projectRepositories, repositories, teams } from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { auditCtx } from './audit.ts';
import { type Ctx, emit } from './context.ts';

/**
 * Where a workspace's code lives. Projects list their repositories and teams name a default, so a
 * run knows what to check out. Only the location is kept: runners bring their own git credentials.
 */

type RepositoryRow = typeof repositories.$inferSelect;

export const toRepository = (r: RepositoryRow): Repository => ({
  id: r.id,
  name: r.name,
  url: r.url,
  defaultBranch: r.defaultBranch,
  integrationId: r.integrationId,
  externalRepo: r.externalRepo,
  createdAt: r.createdAt,
});

/** Workspace-wide, like labels without a team: names and URLs, nothing team-scoped. */
export async function listRepositories(db: DbOrTx, workspaceId: string): Promise<Repository[]> {
  const rows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId))
    .orderBy(asc(repositories.name));
  return rows.map(toRepository);
}

async function loadRepository(ctx: Ctx, id: string) {
  const [row] = await ctx.tx
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, id), eq(repositories.workspaceId, ctx.workspaceId)));
  if (!row) throw notFound('Repository');
  return row;
}

async function assertIntegration(ctx: Ctx, integrationId: string | null | undefined) {
  if (!integrationId) return;
  const [row] = await ctx.tx
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.workspaceId, ctx.workspaceId)));
  if (!row) throw badRequest('Unknown integration');
}

export async function createRepository(
  ctx: Ctx,
  input: z.infer<typeof createRepositorySchema>,
): Promise<Repository> {
  await assertIntegration(ctx, input.integrationId);
  const [row] = await ctx.tx
    .insert(repositories)
    .values({ ...input, workspaceId: ctx.workspaceId, createdById: ctx.userId })
    .returning();
  await auditCtx(ctx, {
    action: 'repository.created',
    targetType: 'repository',
    targetId: row!.id,
    data: { name: input.name, url: input.url },
  });
  emit(ctx, { kind: 'repository', action: 'created', id: row!.id });
  return toRepository(row!);
}

export async function updateRepository(
  ctx: Ctx,
  id: string,
  input: z.infer<typeof updateRepositorySchema>,
): Promise<Repository> {
  await loadRepository(ctx, id);
  await assertIntegration(ctx, input.integrationId);
  const [row] = await ctx.tx
    .update(repositories)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(eq(repositories.id, id))
    .returning();
  await auditCtx(ctx, {
    action: 'repository.updated',
    targetType: 'repository',
    targetId: id,
    data: input,
  });
  emit(ctx, { kind: 'repository', action: 'updated', id });
  return toRepository(row!);
}

/** Projects and teams that used it simply lose it (the foreign keys cascade or clear). */
export async function deleteRepository(ctx: Ctx, id: string) {
  const row = await loadRepository(ctx, id);
  await ctx.tx.delete(repositories).where(eq(repositories.id, id));
  await auditCtx(ctx, {
    action: 'repository.deleted',
    targetType: 'repository',
    targetId: id,
    data: { name: row.name },
  });
  emit(ctx, { kind: 'repository', action: 'deleted', id });
  emit(ctx, { kind: 'project', action: 'updated', id });
}

/** Repositories of this workspace among `ids`; an unknown one is an error. */
export async function assertRepositories(ctx: Ctx, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return;
  const found = await ctx.tx
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.workspaceId, ctx.workspaceId), inArray(repositories.id, wanted)));
  if (found.length !== wanted.length) throw badRequest('Unknown repository');
}

/** Replaces a project's repositories, keeping the given order. */
export async function setProjectRepositories(ctx: Ctx, projectId: string, ids: string[]) {
  await assertRepositories(ctx, ids);
  await ctx.tx.delete(projectRepositories).where(eq(projectRepositories.projectId, projectId));
  const unique = [...new Set(ids)];
  if (unique.length)
    await ctx.tx
      .insert(projectRepositories)
      .values(unique.map((repositoryId, position) => ({ projectId, repositoryId, position })));
}

/** Repository ids per project, in order. */
export async function projectRepositoryIds(db: DbOrTx, projectIds: string[]) {
  const map = new Map<string, string[]>();
  if (projectIds.length === 0) return map;
  const rows = await db
    .select()
    .from(projectRepositories)
    .where(inArray(projectRepositories.projectId, projectIds))
    .orderBy(asc(projectRepositories.position));
  for (const r of rows) map.set(r.projectId, [...(map.get(r.projectId) ?? []), r.repositoryId]);
  return map;
}

/** Where work on an issue happens: its project's repositories, else its team's default. */
export async function repositoriesForIssue(
  db: DbOrTx,
  issue: Pick<Issue, 'projectId' | 'teamId'>,
): Promise<Repository[]> {
  if (issue.projectId) {
    const rows = await db
      .select({ repo: repositories })
      .from(projectRepositories)
      .innerJoin(repositories, eq(repositories.id, projectRepositories.repositoryId))
      .where(eq(projectRepositories.projectId, issue.projectId))
      .orderBy(asc(projectRepositories.position));
    if (rows.length) return rows.map((r) => toRepository(r.repo));
  }
  const [team] = await db
    .select({ repo: repositories })
    .from(teams)
    .innerJoin(repositories, eq(repositories.id, teams.defaultRepositoryId))
    .where(eq(teams.id, issue.teamId));
  return team ? [toRepository(team.repo)] : [];
}
