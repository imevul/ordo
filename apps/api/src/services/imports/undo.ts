import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { importItems, imports, issues } from '../../db/schema.ts';
import { badRequest } from '../../lib/errors.ts';
import { enqueue, type JobContext } from '../../lib/jobs/index.ts';
import { runInWorkspace } from '../../lib/mutate.ts';
import { audit } from '../audit.ts';
import type { RequestMeta } from '../context.ts';
import { trashIssue } from '../issues.ts';
import { bumpEpoch, publishChanges } from '../sync.ts';
import { importLimits } from './engine.ts';
import type { ImportRow } from './types.ts';

/**
 * Undoing an import moves the issues it created to the trash, where each can still be restored.
 * Teams, labels, projects and placeholders it made stay: removing them would take labels and
 * projects off the trashed issues too. Runs as a job, a page per transaction, like the import.
 */

const PAGE = 200;
/** Statuses after which an import may have created something. */
const UNDOABLE = ['completed', 'failed', 'canceled'];

function publish(app: FastifyInstance, row: ImportRow) {
  return publishChanges(app, [
    { kind: 'import', action: 'updated', id: row.id, workspaceId: row.workspaceId },
  ]);
}

/** The import's issues that aren't in the trash yet. */
const remaining = (app: FastifyInstance, importId: string, limit?: number) => {
  const query = app.db
    .select({ id: issues.id })
    .from(importItems)
    .innerJoin(issues, eq(issues.id, importItems.entityId))
    .where(
      and(
        eq(importItems.importId, importId),
        eq(importItems.kind, 'issue'),
        isNull(issues.deletedAt),
      ),
    );
  return limit ? query.limit(limit) : query;
};

export async function startUndo(
  app: FastifyInstance,
  row: ImportRow,
  opts: { actorId: string; meta: RequestMeta | null },
) {
  if (!UNDOABLE.includes(row.status)) throw badRequest('Only an import that ran can be undone');
  const total = (await remaining(app, row.id)).length;
  await app.db.transaction(async (tx) => {
    await tx
      .update(imports)
      .set({
        status: 'undoing',
        // Who undoes it: the trashing is theirs, not the importer's.
        cursor: { undoneBy: opts.actorId },
        progress: { phase: 'undo', done: 0, total },
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(imports.id, row.id));
    await enqueue(
      tx,
      'import.undo',
      { importId: row.id },
      { orderingKey: `import:${row.id}`, maxAttempts: 4 },
    );
    await audit(
      tx,
      {
        workspaceId: row.workspaceId,
        actorId: opts.actorId,
        action: 'import.undone',
        targetType: 'import',
        targetId: row.id,
        data: { source: row.source, name: row.name, issues: total },
      },
      opts.meta,
    );
  });
  await publish(app, row);
}

export async function runUndo(
  app: FastifyInstance,
  { importId }: { importId: string },
  job: JobContext,
) {
  const deadline = Date.now() + importLimits.timeBudgetMs;
  for (;;) {
    const [row] = await app.db.select().from(imports).where(eq(imports.id, importId));
    if (row?.status !== 'undoing') return;
    const actorId = (row.cursor as { undoneBy?: string } | null)?.undoneBy ?? row.createdById;
    if (!actorId) throw new Error('Nobody to undo the import as');
    const page = await remaining(app, row.id, PAGE);
    const done = page.length < PAGE;
    await runInWorkspace(
      app,
      { workspaceId: row.workspaceId, actorId, source: 'import', silent: true },
      async (ctx) => {
        for (const { id } of page) await trashIssue(ctx, id);
        if (done) await bumpEpoch(ctx.tx, row.workspaceId);
        const progress = row.progress ?? { phase: 'undo', done: 0, total: page.length };
        await ctx.tx
          .update(imports)
          .set({
            progress: { ...progress, done: progress.done + page.length },
            updatedAt: new Date().toISOString(),
            ...(done && { status: 'undone' }),
          })
          .where(eq(imports.id, row.id));
      },
    );
    await publish(app, row);
    if (done) return;
    if (Date.now() > deadline) {
      await enqueue(
        app.db,
        'import.undo',
        { importId },
        {
          orderingKey: `import:${row.id}`,
          dedupeKey: `undo:${row.id}:${job.jobId}`,
          maxAttempts: 4,
        },
      );
      return;
    }
  }
}
