import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { files } from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { storageKey } from '../lib/storage/index.ts';

type FileKind = (typeof files.$inferSelect)['kind'];

const IMAGE_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** The content type, judged from the bytes for images; never trusted from the client. */
export function sniffImage(body: Buffer): string | null {
  for (const [type, test] of Object.entries(IMAGE_TYPES)) if (test(body)) return type;
  return null;
}

export const isImageType = (type: string) => type in IMAGE_TYPES;

export async function saveFile(
  app: FastifyInstance,
  input: {
    workspaceId: string | null;
    ownerId: string;
    kind: FileKind;
    filename: string;
    body: Buffer;
    imagesOnly?: boolean;
  },
) {
  const image = sniffImage(input.body);
  if (input.imagesOnly && !image) throw badRequest('Upload a PNG, JPEG, GIF or WebP image');
  const contentType = image ?? 'application/octet-stream';
  const id = randomUUID();
  const key = storageKey(input.kind, new Date().toISOString().slice(0, 7), id);
  await app.storage.put(key, input.body, contentType);
  const [row] = await app.db
    .insert(files)
    .values({
      id,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      kind: input.kind,
      storageKey: key,
      filename: input.filename.slice(0, 255) || 'file',
      contentType,
      size: input.body.length,
    })
    .returning();
  return row!;
}

export async function deleteFile(app: FastifyInstance, id: string) {
  const [row] = await app.db.delete(files).where(eq(files.id, id)).returning();
  if (row)
    await app.storage
      .delete(row.storageKey)
      .catch((err) => app.log.warn({ err }, 'deleting stored file failed'));
}

/**
 * Sends a stored file. Only sniffed image types render inline; everything else downloads, and
 * the CSP sandbox stops anything unexpected from running scripts on this origin.
 */
export async function sendStoredFile(
  app: FastifyInstance,
  reply: FastifyReply,
  file: typeof files.$inferSelect,
  maxAge: number,
) {
  const body = await app.storage.get(file.storageKey);
  if (!body) throw notFound('File');
  const image = isImageType(file.contentType);
  return reply
    .header('content-type', image ? file.contentType : 'application/octet-stream')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; img-src 'self'; sandbox")
    .header(
      'content-disposition',
      `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    )
    .header('cache-control', `private, max-age=${maxAge}`)
    .send(body);
}

const DAY = 86_400;

/**
 * A signed, expiring URL for a file. Expiry is rounded to whole days so the URL stays stable
 * (and cacheable) for a day, then valid for one more.
 */
export function signedFileUrl(
  app: FastifyInstance,
  fileId: string | null | undefined,
): string | null {
  if (!fileId || !app.keyring.available) return null;
  const exp = (Math.floor(Date.now() / 1000 / DAY) + 2) * DAY;
  return `/api/files/${fileId}?exp=${exp}&sig=${sign(app, fileId, exp)}`;
}

export function verifyFileSignature(
  app: FastifyInstance,
  fileId: string,
  exp: number,
  sig: string,
) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(app, fileId, exp));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sign(app: FastifyInstance, fileId: string, exp: number) {
  return createHmac('sha256', app.keyring.subkey('file-url'))
    .update(`${fileId}.${exp}`)
    .digest('base64url');
}
