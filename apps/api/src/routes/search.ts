import type { SearchResults } from '@ordo/shared';
import { and, eq, ilike } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { projects } from '../db/schema.ts';
import { requireUser, requireWorkspace } from '../lib/auth.ts';
import { queryIssues } from '../services/issues.ts';

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', async (req): Promise<SearchResults> => {
    const { q = '' } = req.query as { q?: string };
    const term = q.trim().slice(0, 200);
    if (!term) return { issues: [], projects: [] };
    const ws = requireWorkspace(req);
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const [issueRows, projectRows] = await Promise.all([
      queryIssues(app.db, ws.id, requireUser(req).id, { q: term }, 50),
      app.db
        .select({ id: projects.id, name: projects.name, color: projects.color })
        .from(projects)
        .where(and(eq(projects.workspaceId, ws.id), ilike(projects.name, like)))
        .limit(10),
    ]);
    return { issues: issueRows, projects: projectRows };
  });
}
