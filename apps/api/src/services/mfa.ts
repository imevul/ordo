import { randomBytes } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import type { DbOrTx } from '../db/client.ts';
import { passkeys, recoveryCodes, users } from '../db/schema.ts';
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

/** A TOTP code (when the authenticator app is on), or failing that an unused recovery code. */
export async function verifySecondFactor(
  db: DbOrTx,
  keyring: Keyring,
  user: { id: string; email: string; totpSecret: string | null; totpEnabledAt: string | null },
  code: string,
) {
  if (user.totpEnabledAt && /^\d{6}$/.test(code.trim()) && verifyTotp(keyring, user, code))
    return true;
  return useRecoveryCode(db, user.id, code);
}

export type SecondFactor = 'totp' | 'passkey' | 'recovery';

/**
 * How someone can prove it's them after their password. An authenticator app or a passkey turns
 * two-factor on; recovery codes are the way back in when the device is lost, never on their own.
 */
export async function secondFactors(
  db: DbOrTx,
  user: { id: string; totpEnabledAt: string | null },
): Promise<SecondFactor[]> {
  const [keys] = await db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, user.id));
  const factors: SecondFactor[] = [];
  if (user.totpEnabledAt) factors.push('totp');
  if ((keys?.n ?? 0) > 0) factors.push('passkey');
  if (!factors.length) return [];
  const [codes] = await db
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt)));
  if ((codes?.n ?? 0) > 0) factors.push('recovery');
  return factors;
}

export const hasSecondFactor = async (
  db: DbOrTx,
  user: { id: string; totpEnabledAt: string | null },
) => (await secondFactors(db, user)).length > 0;

/** Whether the person has recovery codes left (a first passkey hands them out otherwise). */
export async function hasRecoveryCodes(db: DbOrTx, userId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return (row?.n ?? 0) > 0;
}
