import type { SearchResults } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { queryIssues } from '../services/issues.ts';
import { listProjects } from '../services/projects.ts';

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', async (req): Promise<SearchResults> => {
    const { q = '' } = req.query as { q?: string };
    const term = q.trim().slice(0, 200);
    if (!term) return { issues: [], projects: [] };
    const access = requireAccess(req);
    const needle = term.toLowerCase();
    const [issueRows, visibleProjects] = await Promise.all([
      queryIssues(app.db, access, { q: term }, 50),
      listProjects(app.db, access),
    ]);
    const projectRows = visibleProjects
      .filter((p) => p.name.toLowerCase().includes(needle))
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, color: p.color }));
    return { issues: issueRows, projects: projectRows };
  });
}
