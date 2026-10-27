import {
  type SyncIssuePage,
  type SyncSnapshot,
  syncChangesQuerySchema,
  syncIssuesSchema,
} from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess, requireWorkspace } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { queryIssuePage } from '../services/issues.ts';
import { changesSince, syncCursor } from '../services/syncFeed.ts';
import { loadBootstrap } from './workspaces.ts';

/**
 * For clients that keep their own copy of the workspace: load it once (snapshot, then issues a
 * page at a time), then follow the change log.
 */
export async function syncRoutes(app: FastifyInstance) {
  /**
   * The cursor is read before the data, so anything that changes while the client loads is in
   * the changes after it: seen twice at worst, never missed.
   */
  app.get('/sync/snapshot', async (req): Promise<SyncSnapshot> => {
    const ws = requireWorkspace(req);
    const { seq, epoch } = await syncCursor(app.db, ws.id);
    return { seq, epoch, bootstrap: await loadBootstrap(app, req) };
  });

  app.post('/sync/issues', async (req): Promise<SyncIssuePage> => {
    const { after, limit } = parse(syncIssuesSchema, req.body);
    const issues = await queryIssuePage(app.db, requireAccess(req), {}, after ?? null, limit);
    return { issues, next: issues.length === limit ? issues.at(-1)!.id : null };
  });

  app.get('/sync/changes', async (req) =>
    changesSince(app.db, requireAccess(req), parse(syncChangesQuerySchema, req.query)),
  );
}
