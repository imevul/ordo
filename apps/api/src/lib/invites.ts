import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { randomToken, sha256 } from './crypto.ts';

/**
 * Invite tokens are stored as a sha256 for lookup, plus encrypted so admins can copy and resend
 * the link later. Without ORDO_SECRET_KEY only the hash is kept: the link is shown once.
 */
export const inviteTokenAad = (id: string) => `invites:${id}:token`;

/** Columns for a new invite row (or a new token for row `id`), with the token to put in the link. */
export function newInviteToken(app: FastifyInstance, id: string = randomUUID()) {
  const token = randomToken(18);
  return {
    token,
    columns: {
      id,
      tokenHash: sha256(token),
      tokenEncrypted: app.keyring.available ? app.keyring.encrypt(token, inviteTokenAad(id)) : null,
    },
  };
}

/** The stored invite's token, or null when it can't be decrypted (no key, or an unknown one). */
export function revealInviteToken(
  app: FastifyInstance,
  row: { id: string; tokenEncrypted: string | null },
): string | null {
  if (!row.tokenEncrypted) return null;
  try {
    return app.keyring.decrypt(row.tokenEncrypted, inviteTokenAad(row.id));
  } catch {
    return null;
  }
}

export const inviteUrl = (app: FastifyInstance, token: string) =>
  `${app.env.publicUrl}/invite/${token}`;
