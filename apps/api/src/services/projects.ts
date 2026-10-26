import type { Project, ProjectHealth } from '@ordo/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { projects, projectTeams, projectUpdates } from '../db/schema.ts';
import { progressBy } from './progress.ts';
import { toProject } from './serialize.ts';

export async function listProjects(
  db: DbOrTx,
  workspaceId: string,
  onlyId?: string,
): Promise<Project[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(
      onlyId
        ? and(eq(projects.workspaceId, workspaceId), eq(projects.id, onlyId))
        : eq(projects.workspaceId, workspaceId),
    )
    .orderBy(asc(projects.sortOrder), asc(projects.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((p) => p.id);
  const [links, progress, updates] = await Promise.all([
    db.select().from(projectTeams).where(inArray(projectTeams.projectId, ids)),
    progressBy(db, 'project_id', workspaceId),
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
      links.filter((l) => l.projectId === p.id).map((l) => l.teamId),
      progress.get(p.id),
      health.get(p.id),
    ),
  );
}
