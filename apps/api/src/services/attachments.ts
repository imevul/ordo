import { ATTACHMENT_URL_PATTERN, type Attachment, attachmentUrl } from '@ordo/shared';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { attachments, files, issues } from '../db/schema.ts';
import { forbidden, notFound, one } from '../lib/errors.ts';
import { canReadTeam } from './access.ts';
import { forEachIsolated } from './automation.ts';
import { type Ctx, emit } from './context.ts';
import { deleteFile } from './files.ts';

const select = {
  id: attachments.id,
  issueId: attachments.issueId,
  uploaderId: attachments.uploaderId,
  createdAt: attachments.createdAt,
  filename: files.filename,
  contentType: files.contentType,
  size: files.size,
};

const toAttachment = (r: Omit<Attachment, 'url'>): Attachment => ({
  ...r,
  url: attachmentUrl(r.id),
});

export async function listAttachments(db: DbOrTx, issueId: string): Promise<Attachment[]> {
  const rows = await db
    .select(select)
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    .where(eq(attachments.issueId, issueId))
    .orderBy(asc(attachments.createdAt));
  return rows.map(toAttachment);
}

/** Records an uploaded file as an attachment; `issue` is null for uploads into a new issue. */
export async function createAttachment(
  ctx: Ctx,
  fileId: string,
  issue: { id: string; teamId: string } | null,
): Promise<Attachment> {
  const row = one(
    await ctx.tx
      .insert(attachments)
      .values({
        workspaceId: ctx.workspaceId,
        issueId: issue?.id ?? null,
        fileId,
        uploaderId: ctx.userId,
      })
      .returning({ id: attachments.id }),
  );
  if (issue)
    emit(ctx, {
      kind: 'issue',
      action: 'updated',
      id: issue.id,
      teamId: issue.teamId,
      bootstrapUnchanged: true,
    });
  return (await getAttachment(ctx.tx, row.id))!;
}

async function getAttachment(db: DbOrTx, id: string): Promise<Attachment | null> {
  const [row] = await db
    .select(select)
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    .where(eq(attachments.id, id));
  return row ? toAttachment(row) : null;
}

/**
 * Attaches the caller's unclaimed uploads that `markdown` references to the issue. Called when a
 * description or comment is saved, so files pasted into a new issue end up on it.
 */
export async function claimAttachments(ctx: Ctx, issueId: string, markdown: string | undefined) {
  if (!markdown) return;
  const ids = [...new Set([...markdown.matchAll(ATTACHMENT_URL_PATTERN)].map((m) => m[1]!))];
  if (ids.length === 0) return;
  await ctx.tx
    .update(attachments)
    .set({ issueId })
    .where(
      and(
        inArray(attachments.id, ids),
        isNull(attachments.issueId),
        eq(attachments.workspaceId, ctx.workspaceId),
        eq(attachments.uploaderId, ctx.userId),
      ),
    );
}

/** An attachment with what's needed to check access to it, in any workspace. */
export async function loadAttachmentForDownload(db: DbOrTx, id: string) {
  const [row] = await db
    .select({
      workspaceId: attachments.workspaceId,
      issueId: attachments.issueId,
      uploaderId: attachments.uploaderId,
      teamId: issues.teamId,
      file: files,
    })
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    .leftJoin(issues, eq(issues.id, attachments.issueId))
    .where(eq(attachments.id, id));
  return row ?? null;
}

/**
 * Uploaders and workspace or team admins may remove an attachment. Returns the file to delete
 * after commit; if that fails, the sweep picks it up.
 */
export async function deleteAttachment(ctx: Ctx, id: string): Promise<string> {
  const [row] = await ctx.tx
    .select({
      fileId: attachments.fileId,
      issueId: attachments.issueId,
      uploaderId: attachments.uploaderId,
      teamId: issues.teamId,
    })
    .from(attachments)
    .leftJoin(issues, eq(issues.id, attachments.issueId))
    .where(and(eq(attachments.id, id), eq(attachments.workspaceId, ctx.workspaceId)));
  const readable =
    row && (row.teamId ? canReadTeam(ctx.access, row.teamId) : row.uploaderId === ctx.userId);
  if (!row || !readable) throw notFound('Attachment');
  const teamAdmin =
    row.teamId && (ctx.access.isAdmin || ctx.access.adminTeamIds.includes(row.teamId));
  if (row.uploaderId !== ctx.userId && !teamAdmin)
    throw forbidden('Only the uploader or an admin can remove this attachment').as(
      'attachment_remove',
    );
  await ctx.tx.delete(attachments).where(eq(attachments.id, id));
  if (row.issueId && row.teamId)
    emit(ctx, {
      kind: 'issue',
      action: 'updated',
      id: row.issueId,
      teamId: row.teamId,
      bootstrapUnchanged: true,
    });
  return row.fileId;
}

/**
 * Hourly: drops uploads nobody claimed within a day, then the stored files of attachments that
 * are gone (removed, or their issue deleted for good).
 */
export async function sweepAttachments(app: FastifyInstance) {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  await app.db
    .delete(attachments)
    .where(and(isNull(attachments.issueId), lt(attachments.createdAt, dayAgo)));
  const orphans = await app.db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.kind, 'attachment'),
        // Grace period: the file row is written just before its attachment row.
        lt(files.createdAt, new Date(Date.now() - 3_600_000).toISOString()),
        sql`not exists (select 1 from attachments a where a.file_id = "files"."id")`,
      ),
    )
    .limit(500);
  // One file that won't delete mustn't keep the rest around; it's retried on the next sweep.
  await forEachIsolated(
    app,
    'attachments.sweep',
    orphans,
    ({ id }) => ({ fileId: id }),
    ({ id }) => deleteFile(app, id),
  );
}
