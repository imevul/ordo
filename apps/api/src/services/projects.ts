import type { Project, ProjectHealth } from '@ordo/shared';
import { and, asc, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { projects, projectTeams, projectUpdates } from '../db/schema.ts';
import { type Access, canReadTeam } from './access.ts';
import { progressBy } from './progress.ts';
import { toProject } from './serialize.ts';

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
  const [links, progress, updates] = await Promise.all([
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
    ),
  );
}
