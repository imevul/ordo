import { createDocumentSchema, type ProjectDocument, updateDocumentSchema } from '@ordo/shared';
import { and, asc, eq, max } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { projectDocuments } from '../db/schema.ts';
import { requireAccess } from '../lib/auth.ts';
import { conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import type { Access } from '../services/access.ts';
import { type Ctx, emit } from '../services/context.ts';
import { listProjects } from '../services/projects.ts';

const toDocument = (
  d: typeof projectDocuments.$inferSelect,
  withContent = true,
): ProjectDocument => ({
  id: d.id,
  projectId: d.projectId,
  title: d.title,
  ...(withContent && { content: d.content }),
  createdById: d.createdById,
  updatedById: d.updatedById,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/** Documents belong to their project: readable by whoever sees it, written by all but guests. */
async function visibleProject(db: FastifyInstance['db'], access: Access, projectId: string) {
  const [project] = await listProjects(db, access, projectId);
  if (!project) throw notFound('Project');
  return project;
}

export async function documentRoutes(app: FastifyInstance) {
  const { db } = app;

  const load = async (req: FastifyRequest, id: string) => {
    const access = requireAccess(req);
    const [doc] = await db
      .select()
      .from(projectDocuments)
      .where(
        and(eq(projectDocuments.id, id), eq(projectDocuments.workspaceId, access.workspaceId)),
      );
    if (!doc) throw notFound('Document');
    await visibleProject(db, access, doc.projectId);
    return doc;
  };
  const writable = (ctx: Ctx) => {
    if (ctx.access.isGuest) throw forbidden('Guests cannot change documents');
  };

  app.get('/projects/:id/documents', async (req) => {
    const { id } = req.params as { id: string };
    await visibleProject(db, requireAccess(req), id);
    const rows = await db
      .select()
      .from(projectDocuments)
      .where(eq(projectDocuments.projectId, id))
      .orderBy(asc(projectDocuments.sortOrder), asc(projectDocuments.createdAt));
    return rows.map((d) => toDocument(d, false));
  });

  app.get('/documents/:id', async (req) => {
    const { id } = req.params as { id: string };
    return toDocument(await load(req, id));
  });

  app.post('/projects/:id/documents', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createDocumentSchema, req.body);
    await visibleProject(db, requireAccess(req), id);
    return mutate(app, req, async (ctx) => {
      writable(ctx);
      const [{ last }] = (await ctx.tx
        .select({ last: max(projectDocuments.sortOrder) })
        .from(projectDocuments)
        .where(eq(projectDocuments.projectId, id))) as [{ last: number | null }];
      const [row] = await ctx.tx
        .insert(projectDocuments)
        .values({
          ...input,
          workspaceId: ctx.workspaceId,
          projectId: id,
          sortOrder: (last ?? 0) + 1024,
          createdById: ctx.userId,
          updatedById: ctx.userId,
        })
        .returning();
      emit(ctx, { kind: 'document', action: 'created', id: row!.id });
      return toDocument(row!);
    });
  });

  app.patch('/documents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { baseUpdatedAt, ...input } = parse(updateDocumentSchema, req.body);
    const before = await load(req, id);
    return mutate(app, req, async (ctx) => {
      writable(ctx);
      // Two people editing at once: the second save would silently undo the first.
      if (baseUpdatedAt && Date.parse(baseUpdatedAt) !== Date.parse(before.updatedAt))
        throw conflict('Someone else saved this document while you were editing');
      const [row] = await ctx.tx
        .update(projectDocuments)
        .set({ ...input, updatedById: ctx.userId, updatedAt: new Date().toISOString() })
        .where(eq(projectDocuments.id, id))
        .returning();
      emit(ctx, { kind: 'document', action: 'updated', id });
      return toDocument(row!);
    });
  });

  app.delete('/documents/:id', async (req) => {
    const { id } = req.params as { id: string };
    await load(req, id);
    return mutate(app, req, async (ctx) => {
      writable(ctx);
      await ctx.tx.delete(projectDocuments).where(eq(projectDocuments.id, id));
      emit(ctx, { kind: 'document', action: 'deleted', id });
      return { ok: true };
    });
  });
}
