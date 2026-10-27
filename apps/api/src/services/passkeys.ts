import type { Passkey } from '@ordo/shared';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { passkeys, webauthnChallenges } from '../db/schema.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest } from '../lib/errors.ts';

/**
 * Passkeys (WebAuthn): sign-in without a password, or a second factor after one. The relying
 * party is this instance's public URL: its hostname is the RP ID, so passkeys are tied to it, and
 * moving the instance to another hostname leaves them behind.
 */

const CHALLENGE_MINUTES = 5;

export function relyingParty(app: FastifyInstance) {
  const url = new URL(app.env.publicUrl);
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  return {
    id: url.hostname,
    origin: url.origin,
    name: 'Ordo',
    // Browsers only offer WebAuthn in secure contexts.
    usable: url.protocol === 'https:' || local,
  };
}

/** The WebAuthn user handle: the user's id, opaque to everyone else. */
const userHandle = (userId: string) => isoUint8Array.fromUTF8String(userId);

export const passkeyFailed = () =>
  badRequest("That passkey couldn't be verified").as('passkey_failed');

async function storeChallenge(
  db: DbOrTx,
  challenge: string,
  purpose: 'register' | 'login' | 'mfa',
  userId: string | null,
) {
  const id = randomToken(18);
  await db.insert(webauthnChallenges).values({
    id,
    challenge,
    purpose,
    userId,
    expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString(),
  });
  return id;
}

/** Takes a challenge out of the store; each is good for one attempt. */
async function takeChallenge(
  db: DbOrTx,
  id: string,
  purpose: 'register' | 'login' | 'mfa',
  userId: string | null,
) {
  const [row] = await db
    .delete(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.id, id),
        eq(webauthnChallenges.purpose, purpose),
        gt(webauthnChallenges.expiresAt, new Date().toISOString()),
      ),
    )
    .returning();
  if (!row || (userId !== null && row.userId !== userId)) throw passkeyFailed();
  return row.challenge;
}

export async function purgeExpiredChallenges(db: DbOrTx) {
  await db
    .delete(webauthnChallenges)
    .where(lt(webauthnChallenges.expiresAt, new Date().toISOString()));
}

export const toPasskey = (row: typeof passkeys.$inferSelect): Passkey => ({
  id: row.id,
  name: row.name,
  backedUp: row.backedUp,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

export async function listPasskeys(db: DbOrTx, userId: string) {
  return db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt));
}

/** Options for adding a passkey, excluding the ones the person already has on this device. */
export async function registrationOptions(
  app: FastifyInstance,
  user: { id: string; email: string; name: string },
) {
  const rp = relyingParty(app);
  const existing = await listPasskeys(app.db, user.id);
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name,
    userID: userHandle(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    // Discoverable, so it can sign in without typing an email first.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = await storeChallenge(app.db, options.challenge, 'register', user.id);
  return { challengeId, options };
}

export async function addPasskey(
  app: FastifyInstance,
  db: DbOrTx,
  userId: string,
  input: { challengeId: string; response: unknown; name?: string },
) {
  const rp = relyingParty(app);
  const challenge = await takeChallenge(db, input.challengeId, 'register', userId);
  let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
  try {
    const result = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
    if (!result.verified) throw passkeyFailed();
    info = result.registrationInfo;
  } catch {
    throw passkeyFailed();
  }
  const [row] = await db
    .insert(passkeys)
    .values({
      userId,
      credentialId: info.credential.id,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      backedUp: info.credentialBackedUp,
      name: input.name?.trim() || 'Passkey',
    })
    .onConflictDoNothing()
    .returning();
  // The same credential registered twice: excludeCredentials normally prevents it.
  if (!row) throw passkeyFailed();
  return row;
}

/**
 * Options for signing in. Without `userId` (passwordless) any of the person's discoverable
 * passkeys will do and must verify the user; as a second factor, only that user's passkeys.
 */
export async function authenticationOptions(
  app: FastifyInstance,
  purpose: 'login' | 'mfa',
  userId: string | null,
) {
  const rp = relyingParty(app);
  const allow = userId ? await listPasskeys(app.db, userId) : [];
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: allow.map((p) => ({ id: p.credentialId, transports: p.transports })),
    userVerification: purpose === 'login' ? 'required' : 'preferred',
  });
  const challengeId = await storeChallenge(app.db, options.challenge, purpose, userId);
  return { challengeId, options };
}

/**
 * Checks a sign-in with a passkey and returns whose it is. A passwordless sign-in must verify
 * the user (PIN, biometrics), which makes the passkey two factors on its own.
 */
export async function verifyPasskey(
  app: FastifyInstance,
  db: DbOrTx,
  input: { challengeId: string; response: unknown },
  purpose: 'login' | 'mfa',
  userId: string | null,
) {
  const rp = relyingParty(app);
  const response = input.response as AuthenticationResponseJSON;
  const challenge = await takeChallenge(db, input.challengeId, purpose, userId);
  const [key] = await db.select().from(passkeys).where(eq(passkeys.credentialId, response.id));
  if (!key || (userId !== null && key.userId !== userId)) throw passkeyFailed();
  // The authenticator says whose passkey it is; it has to agree with what was registered.
  if (
    purpose === 'login' &&
    response.response?.userHandle !== isoBase64URL.fromBuffer(userHandle(key.userId))
  )
    throw passkeyFailed();
  let info: Awaited<ReturnType<typeof verifyAuthenticationResponse>>['authenticationInfo'];
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: key.credentialId,
        publicKey: isoBase64URL.toBuffer(key.publicKey),
        counter: key.counter,
        transports: key.transports as AuthenticatorTransport[],
      },
      requireUserVerification: purpose === 'login',
    });
    if (!result.verified) throw passkeyFailed();
    info = result.authenticationInfo;
  } catch {
    // Includes a counter that went backwards: a cloned authenticator.
    throw passkeyFailed();
  }
  await db
    .update(passkeys)
    .set({
      counter: info.newCounter,
      backedUp: info.credentialBackedUp,
      lastUsedAt: new Date().toISOString(),
    })
    .where(eq(passkeys.id, key.id));
  return { userId: key.userId, passkeyId: key.id };
}

type AuthenticatorTransport =
  | 'ble'
  | 'cable'
  | 'hybrid'
  | 'internal'
  | 'nfc'
  | 'smart-card'
  | 'usb';
