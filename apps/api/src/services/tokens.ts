import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { authTokens } from '../db/schema.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { badRequest } from '../lib/errors.ts';

type TokenKind = (typeof authTokens.$inferSelect)['kind'];

/** Creates a single-use token. Only its hash is stored; the raw value goes into an email or response. */
export async function createToken(
  db: DbOrTx,
  userId: string,
  kind: TokenKind,
  ttlMinutes: number,
  data: Record<string, unknown> = {},
  opts: {
    /** A caller-made token, e.g. a short code people type; it must be unguessable within its TTL. */
    token?: string;
    /** Only replace older tokens with the same value under this `data` key (one per integration). */
    replaceSame?: string;
  } = {},
) {
  const token = opts.token ?? randomToken();
  // A new token of the same kind replaces older unused ones (e.g. a second reset request).
  await db
    .delete(authTokens)
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.kind, kind),
        isNull(authTokens.usedAt),
        opts.replaceSame
          ? sql`${authTokens.data}->>${opts.replaceSame} = ${String(data[opts.replaceSame])}`
          : undefined,
      ),
    );
  await db.insert(authTokens).values({
    userId,
    kind,
    tokenHash: sha256(token),
    data,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
  });
  return token;
}

/** Marks a token used and returns it; throws the same error for unknown, used and expired tokens. */
export async function consumeToken(db: DbOrTx, kind: TokenKind, token: string) {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(
      and(
        eq(authTokens.tokenHash, sha256(token)),
        eq(authTokens.kind, kind),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date().toISOString()),
      ),
    )
    .returning();
  if (!row) throw badRequest('This link is invalid or has expired');
  return row;
}

export async function purgeExpiredTokens(db: DbOrTx) {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  await db
    .delete(authTokens)
    .where(or(lt(authTokens.expiresAt, new Date().toISOString()), lt(authTokens.usedAt, dayAgo)));
}
