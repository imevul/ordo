import multipart from '@fastify/multipart';
import { attachmentUploadQuerySchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { authInfo, authorizeWorkspace, requireAccess, requireUser } from '../lib/auth.ts';
import { badRequest, HttpError, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { canReadTeam } from '../services/access.ts';
import {
  createAttachment,
  deleteAttachment,
  loadAttachmentForDownload,
} from '../services/attachments.ts';
import { deleteFile, saveFile, sendStoredFile } from '../services/files.ts';
import { getIssue } from '../services/issues.ts';

/** Under /api/w/:ws: uploading and removing attachments. */
export async function attachmentRoutes(app: FastifyInstance) {
  // Multipart is only parsed in this scope; the size limit is an instance setting, checked per file.
  await app.register(async (uploads) => {
    await uploads.register(multipart, { limits: { files: 1, fileSize: 1024 * 1024 * 1024 } });

    /** POST /attachments?issueId= — without an issue, the upload waits for a description to claim it. */
    uploads.post('/attachments', async (req) => {
      const access = requireAccess(req);
      const { issueId } = parse(attachmentUploadQuerySchema, req.query);
      const issue = issueId ? await getIssue(app.db, access, issueId) : null;
      const maxMb = app.settings.get('maxAttachmentMb');
      const file = await req.file({ limits: { fileSize: maxMb * 1024 * 1024 } });
      if (!file) throw badRequest('No file uploaded').as('no_file');
      let body: Buffer;
      try {
        body = await file.toBuffer();
      } catch {
        body = Buffer.alloc(0);
      }
      if (file.file.truncated || body.length > maxMb * 1024 * 1024)
        throw new HttpError(413, `Attachments can be up to ${maxMb} MB`, 'too_large').as(
          'attachment_too_large',
          { maxMb },
        );
      if (body.length === 0) throw badRequest('The file is empty').as('file_empty');
      const saved = await saveFile(app, {
        workspaceId: access.workspaceId,
        ownerId: access.userId,
        kind: 'attachment',
        filename: file.filename,
        body,
      });
      try {
        return await mutate(app, req, (ctx) =>
          createAttachment(ctx, saved.id, issue && { id: issue.id, teamId: issue.teamId }),
        );
      } catch (err) {
        await deleteFile(app, saved.id);
        throw err;
      }
    });
  });

  app.delete('/attachments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const fileId = await mutate(app, req, (ctx) => deleteAttachment(ctx, id));
    await deleteFile(app, fileId);
    return { ok: true };
  });
}

/**
 * GET /api/attachments/:id — the stable URL used in Markdown. Needs a session or API key that can
 * read the issue (or, before it's claimed, the uploader's). Unreadable looks like missing.
 */
export async function attachmentDownloadRoutes(app: FastifyInstance) {
  app.get('/attachments/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const row = /^[0-9a-f-]{36}$/.test(id) ? await loadAttachmentForDownload(app.db, id) : null;
    if (!row) throw notFound('Attachment');
    const ws = await authorizeWorkspace(app.db, user, { id: row.workspaceId }, authInfo(req));
    const readable = row.teamId
      ? canReadTeam(ws.access, row.teamId)
      : !row.issueId && row.uploaderId === user.id;
    if (!readable) throw notFound('Attachment');
    // Short, private caching: losing access to the issue takes effect within minutes.
    return sendStoredFile(app, reply, row.file, 300);
  });
}
