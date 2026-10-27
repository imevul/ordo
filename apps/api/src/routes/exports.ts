import { createExportSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { workspaceExports } from '../db/schema.ts';
import { requireAdmin, requireUser } from '../lib/auth.ts';
import { badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { deleteExport, listExports, startExport } from '../services/exports.ts';
import { publishChanges } from '../services/sync.ts';

/** Workspace exports, made by admins. The file is written by a job (`services/exports.ts`). */
export async function exportRoutes(app: FastifyInstance) {
  app.get('/exports', async (req) => listExports(app, requireAdmin(req).id));

  app.post('/exports', async (req) => {
    const ws = requireAdmin(req);
    const { format } = parse(createExportSchema, req.body);
    if (!app.keyring.available) throw badRequest('Set ORDO_SECRET_KEY before exporting');
    const row = await startExport(app, {
      workspaceId: ws.id,
      userId: requireUser(req).id,
      format,
      meta: requestMeta(req),
    });
    await publishChanges(app, [
      { kind: 'export', action: 'created', id: row.id, workspaceId: ws.id },
    ]);
    return (await listExports(app, ws.id, row.id))[0];
  });

  app.delete('/exports/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(workspaceExports)
      .where(and(eq(workspaceExports.id, id), eq(workspaceExports.workspaceId, ws.id)));
    if (!row) throw notFound('Export');
    if (row.status === 'running')
      throw conflict('The export is still being made').as('export_not_ready');
    await deleteExport(app, row);
    await publishChanges(app, [{ kind: 'export', action: 'deleted', id, workspaceId: ws.id }]);
    return { ok: true };
  });
}
