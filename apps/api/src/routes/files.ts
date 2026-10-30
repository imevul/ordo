import { signedFileQuerySchema } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { files } from '../db/schema.ts';
import { notFound, tryParse } from '../lib/errors.ts';
import { sendStoredFile, verifyFileSignature } from '../services/files.ts';

/**
 * GET /api/files/:id?exp=&sig= — serves an uploaded file. The signature (issued with the file's
 * URL in an API response) is the permission; files are never listable or guessable.
 */
export async function fileRoutes(app: FastifyInstance) {
  app.get('/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    // A malformed query is a 404 like a bad signature, so neither says whether the file exists.
    const query = tryParse(signedFileQuerySchema, req.query);
    if (!query || !verifyFileSignature(app, id, query.exp, query.sig)) throw notFound('File');
    const { exp } = query;
    const [file] = await app.db.select().from(files).where(eq(files.id, id));
    if (!file) throw notFound('File');
    return sendStoredFile(app, reply, file, Math.max(0, exp - Math.floor(Date.now() / 1000)));
  });
}
