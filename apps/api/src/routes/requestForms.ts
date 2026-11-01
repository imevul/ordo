import multipart from '@fastify/multipart';
import {
  REQUEST_FORM_MAX_FILES,
  saveRequestFormSchema,
  submitRequestFormSchema,
} from '@ordo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { badRequest, HttpError, parse } from '../lib/errors.ts';
import { mutate, requestMeta } from '../lib/mutate.ts';
import {
  getRequestForm,
  loadOpenForm,
  maxFormFileMb,
  rotateRequestFormLink,
  saveRequestForm,
  submitRequestForm,
  toPublicForm,
} from '../services/requestForms.ts';

/** Under /api/w/:ws: a team's admins set up its form. */
export async function requestFormRoutes(app: FastifyInstance) {
  app.get('/teams/:teamId/request-form', async (req) => {
    const { teamId } = req.params as { teamId: string };
    return getRequestForm(app.db, requireAccess(req), teamId);
  });

  app.put('/teams/:teamId/request-form', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(saveRequestFormSchema, req.body);
    return mutate(app, req, (ctx) => saveRequestForm(app, ctx, teamId, input));
  });

  app.post('/teams/:teamId/request-form/rotate-link', async (req) => {
    const { teamId } = req.params as { teamId: string };
    return mutate(app, req, (ctx) => rotateRequestFormLink(ctx, teamId));
  });
}

/** The JSON part and the files of a submission; all of it is held in memory, within the limits. */
async function readSubmission(req: FastifyRequest, maxMb: number, allowFiles: boolean) {
  if (!req.isMultipart()) return { payload: req.body, files: [] };
  let payload: unknown;
  const files: { filename: string; body: Buffer }[] = [];
  const parts = req.parts({
    limits: {
      files: REQUEST_FORM_MAX_FILES,
      fileSize: maxMb * 1024 * 1024,
      fields: 1,
      fieldSize: 256 * 1024,
    },
  });
  for await (const part of parts) {
    if (part.type === 'file') {
      if (!allowFiles) throw badRequest('This form does not take attachments');
      let body: Buffer;
      try {
        body = await part.toBuffer();
      } catch {
        throw new HttpError(413, `Attachments can be up to ${maxMb} MB`, 'too_large').as(
          'attachment_too_large',
          { maxMb },
        );
      }
      if (body.length) files.push({ filename: part.filename, body });
    } else if (part.fieldname === 'payload') {
      try {
        payload = JSON.parse(String(part.value));
      } catch {
        throw badRequest('Invalid payload');
      }
    }
  }
  return { payload, files };
}

/**
 * /api/forms/:token: no sign-in, so nothing here may depend on or reveal who's asking. Rate limits
 * count per IP; a form that's off, or a wrong token, gets the same 404.
 */
export async function publicRequestFormRoutes(app: FastifyInstance) {
  app.get(
    '/forms/:token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      reply.header('cache-control', 'no-store');
      return toPublicForm(app, await loadOpenForm(app.db, token));
    },
  );

  // Multipart is only parsed in this scope.
  await app.register(async (uploads) => {
    await uploads.register(multipart);

    uploads.post(
      '/forms/:token',
      { bodyLimit: 256 * 1024, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
      async (req) => {
        const { token } = req.params as { token: string };
        const form = await loadOpenForm(app.db, token);
        const { payload, files } = await readSubmission(
          req,
          maxFormFileMb(app),
          form.allowAttachments,
        );
        const input = parse(submitRequestFormSchema, payload);
        await submitRequestForm(app, form, input, files, requestMeta(req));
        return { ok: true };
      },
    );
  });
}
