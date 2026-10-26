import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import type { DbOrTx } from '../db/client.ts';
import { recoveryCodes, users } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';
import type { Keyring } from '../lib/secrets.ts';

const ISSUER = 'Ordo';
const aad = (userId: string) => `users:${userId}:totp_secret`;

function totp(secret: string, label: string) {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

/** Starts enrolment: stores a new (not yet enabled) secret and returns what the authenticator app needs. */
export async function beginTotp(db: DbOrTx, keyring: Keyring, user: { id: string; email: string }) {
  const secret = new Secret({ size: 20 }).base32;
  await db
    .update(users)
    .set({ totpSecret: keyring.encrypt(secret, aad(user.id)) })
    .where(eq(users.id, user.id));
  return { secret, uri: totp(secret, user.email).toString() };
}

export function verifyTotp(
  keyring: Keyring,
  user: { id: string; email: string; totpSecret: string | null },
  code: string,
) {
  if (!user.totpSecret) return false;
  const secret = keyring.decrypt(user.totpSecret, aad(user.id));
  // One step either side tolerates a little clock drift.
  return totp(secret, user.email).validate({ token: code.replace(/\s/g, ''), window: 1 }) !== null;
}

/** Ten fresh single-use recovery codes (replacing any old ones); only hashes are stored. */
export async function regenerateRecoveryCodes(db: DbOrTx, userId: string) {
  const codes = Array.from({ length: 10 }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db.insert(recoveryCodes).values(codes.map((c) => ({ userId, codeHash: sha256(c) })));
  return codes;
}

export async function useRecoveryCode(db: DbOrTx, userId: string, code: string) {
  const [row] = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date().toISOString() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, sha256(code.trim().toLowerCase())),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning();
  return !!row;
}

/** A TOTP code, or failing that an unused recovery code. */
export async function verifySecondFactor(
  db: DbOrTx,
  keyring: Keyring,
  user: { id: string; email: string; totpSecret: string | null },
  code: string,
) {
  if (/^\d{6}$/.test(code.trim()) && verifyTotp(keyring, user, code)) return true;
  return useRecoveryCode(db, user.id, code);
}
