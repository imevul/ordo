import { randomBytes } from 'node:crypto';
import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import type { DbOrTx } from '../db/client.ts';
import { passkeys, recoveryCodes, users } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';
import { secretAad } from '../lib/encryptedColumns.ts';
import type { Keyring } from '../lib/secrets.ts';

const ISSUER = 'Ordo';

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
    .set({ totpSecret: keyring.encrypt(secret, secretAad.totpSecret(user.id)) })
    .where(eq(users.id, user.id));
  return { secret, uri: totp(secret, user.email).toString() };
}

export function verifyTotp(
  keyring: Keyring,
  user: { id: string; email: string; totpSecret: string | null },
  code: string,
) {
  return totpStep(keyring, user, code) !== null;
}

/** The 30-second step a code belongs to, or null when it's wrong. */
function totpStep(
  keyring: Keyring,
  user: { id: string; email: string; totpSecret: string | null },
  code: string,
) {
  if (!user.totpSecret) return null;
  const secret = keyring.decrypt(user.totpSecret, secretAad.totpSecret(user.id));
  const generator = totp(secret, user.email);
  // One step either side tolerates a little clock drift.
  const delta = generator.validate({ token: code.replace(/\s/g, ''), window: 1 });
  return delta === null ? null : generator.counter() + delta;
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
  if (user.totpEnabledAt && /^\d{6}$/.test(code.trim())) {
    const step = totpStep(keyring, user, code);
    if (step === null) return false;
    // Each code signs in once: one seen over a shoulder or phished is spent already.
    const claimed = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(
        and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
      )
      .returning({ id: users.id });
    return claimed.length > 0;
  }
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
