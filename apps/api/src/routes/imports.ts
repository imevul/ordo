import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import { createApiImportSchema, type ImportSource, updateImportSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { importItems, imports } from '../db/schema.ts';
import { requireAdmin, requireUser } from '../lib/auth.ts';
import { badRequest, conflict, notFound, one, parse } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import { deleteFile, saveFile } from '../services/files.ts';
import {
  importAdapter,
  isBusy,
  listImports,
  startAnalysis,
  startRun,
  suggestMapping,
} from '../services/imports/engine.ts';
import { importSecretsAad } from '../services/imports/secrets.ts';
import type { StartedImport } from '../services/imports/types.ts';
import { startUndo } from '../services/imports/undo.ts';
import { publishChanges } from '../services/sync.ts';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Sources that start from an uploaded file. */
const FILE_SOURCES: ImportSource[] = ['csv'];

/** Imports, managed by workspace admins. The work happens in jobs (`services/imports`). */
export async function importRoutes(app: FastifyInstance) {
  const { db } = app;

  const load = async (workspaceId: string, id: string) => {
    const [row] = await db
      .select()
      .from(imports)
      .where(and(eq(imports.id, id), eq(imports.workspaceId, workspaceId)));
    if (!row) throw notFound('Import');
    return row;
  };
  const show = async (workspaceId: string, id: string) =>
    (await listImports(db, workspaceId, id))[0]!;
  const idle = (row: typeof imports.$inferSelect) => {
    if (isBusy(row))
      throw conflict('The import is working; wait for it or cancel it').as('import_busy');
  };

  app.get('/imports', async (req) => listImports(db, requireAdmin(req).id));

  app.get('/imports/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    await load(ws.id, id);
    return show(ws.id, id);
  });

  // New settings (CSV columns) mean a fresh analysis; a new mapping is just saved.
  app.patch('/imports/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const input = parse(updateImportSchema, req.body);
    const row = await load(ws.id, id);
    idle(row);
    if (input.config) {
      if (row.source !== 'csv') throw badRequest('Only CSV imports have column settings');
      const [updated] = await db
        .update(imports)
        .set({ config: { ...row.config, ...input.config }, mapping: input.mapping ?? row.mapping })
        .where(eq(imports.id, id))
        .returning();
      await startAnalysis(app, updated!);
    } else if (input.mapping) {
      if (!row.summary) throw badRequest('The import has not been analyzed yet');
      // Fill in anything the client left out, so every source team, person and label is mapped.
      const mapping = await suggestMapping(db, ws.id, row.summary, input.mapping);
      await db
        .update(imports)
        .set({ mapping, updatedAt: new Date().toISOString() })
        .where(eq(imports.id, id));
    }
    return show(ws.id, id);
  });

  for (const dryRun of [true, false]) {
    app.post(`/imports/:id/${dryRun ? 'dry-run' : 'run'}`, async (req) => {
      const ws = requireAdmin(req);
      const { id } = req.params as { id: string };
      const row = await load(ws.id, id);
      idle(row);
      await startRun(app, row, { dryRun, actorId: requireUser(req).id, meta: requestMeta(req) });
      return show(ws.id, id);
    });
  }

  // Moves what the import created to the trash, in a job.
  app.post('/imports/:id/undo', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const row = await load(ws.id, id);
    idle(row);
    await startUndo(app, row, { actorId: requireUser(req).id, meta: requestMeta(req) });
    return show(ws.id, id);
  });

  app.post('/imports/:id/cancel', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const row = await load(ws.id, id);
    if (!isBusy(row)) throw badRequest('The import is not working on anything');
    await db.transaction(async (tx) => {
      // The job notices at its next step; what it already imported stays.
      await tx
        .update(imports)
        .set({ status: 'canceled', updatedAt: new Date().toISOString() })
        .where(eq(imports.id, id));
      if (row.status === 'running') {
        await audit(
          tx,
          {
            workspaceId: ws.id,
            actorId: requireUser(req).id,
            action: 'import.canceled',
            targetType: 'import',
            targetId: id,
            data: { source: row.source, name: row.name },
          },
          requestMeta(req),
        );
      }
    });
    await publishChanges(app, [{ kind: 'import', action: 'updated', id, workspaceId: ws.id }]);
    return show(ws.id, id);
  });

  // Forgets the import (and its file); what it imported stays.
  app.delete('/imports/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const row = await load(ws.id, id);
    idle(row);
    await db.delete(importItems).where(eq(importItems.importId, id));
    await db.delete(imports).where(eq(imports.id, id));
    if (row.fileId) await deleteFile(app, row.fileId);
    await publishChanges(app, [{ kind: 'import', action: 'deleted', id, workspaceId: ws.id }]);
    return { ok: true };
  });

  /** Another tracker's API: check the key works, keep it encrypted, analyze. */
  async function startApiImport(req: FastifyRequest) {
    const ws = requireAdmin(req);
    const user = requireUser(req);
    const input = parse(createApiImportSchema, req.body);
    if (!app.keyring.available)
      throw badRequest('Set ORDO_SECRET_KEY before importing from an API');
    let started: StartedImport;
    try {
      started = await importAdapter(input.source)!.start!(app, input);
    } catch (err) {
      // Bad credentials, missing repositories, an unreachable server: say what the source said.
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    const id = randomUUID();
    const row = one(
      await db
        .insert(imports)
        .values({
          id,
          workspaceId: ws.id,
          source: input.source,
          name: started.name.slice(0, 200),
          config: started.config,
          secrets: app.keyring.encrypt(JSON.stringify(started.secrets), importSecretsAad(id)),
          createdById: user.id,
        })
        .returning(),
    );
    await startAnalysis(app, row);
    return show(ws.id, id);
  }

  // Files are multipart, and multipart is only parsed in this scope; API sources send JSON.
  await app.register(async (uploads) => {
    await uploads.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
    uploads.post('/imports', async (req) => {
      if (!req.isMultipart()) return startApiImport(req);
      const ws = requireAdmin(req);
      const user = requireUser(req);
      const file = await req.file();
      if (!file) throw badRequest('No file uploaded').as('no_file');
      const field = file.fields.source as { value?: unknown } | undefined;
      const source = String(field?.value ?? 'csv') as ImportSource;
      if (!FILE_SOURCES.includes(source)) throw badRequest(`Unknown file source ${source}`);
      const body = await file.toBuffer();
      if (file.file.truncated)
        throw badRequest('The file is larger than 25 MB').as('file_too_large');
      const saved = await saveFile(app, {
        workspaceId: ws.id,
        ownerId: user.id,
        kind: 'import',
        filename: file.filename,
        body,
      });
      const row = one(
        await db
          .insert(imports)
          .values({
            workspaceId: ws.id,
            source,
            name: file.filename.slice(0, 200) || 'Import',
            fileId: saved.id,
            createdById: user.id,
          })
          .returning(),
      );
      await startAnalysis(app, row);
      return show(ws.id, row.id);
    });
  });
}
