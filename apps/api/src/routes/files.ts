import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { files } from '../db/schema.ts';
import { notFound } from '../lib/errors.ts';
import { sendStoredFile, verifyFileSignature } from '../services/files.ts';

/**
 * GET /api/files/:id?exp=&sig= — serves an uploaded file. The signature (issued with the file's
 * URL in an API response) is the permission; files are never listable or guessable.
 */
export async function fileRoutes(app: FastifyInstance) {
  app.get('/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!sig || !verifyFileSignature(app, id, Number(exp), sig)) throw notFound('File');
    const [file] = await app.db.select().from(files).where(eq(files.id, id));
    if (!file) throw notFound('File');
    return sendStoredFile(
      app,
      reply,
      file,
      Math.max(0, Number(exp) - Math.floor(Date.now() / 1000)),
    );
  });
}
