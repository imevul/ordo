import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  apiKeys,
  authTokens,
  calendarFeeds,
  oauthClients,
  oauthCodes,
  oauthGrants,
  passkeys,
  sessions,
  userIdentities,
} from '../db/schema.ts';
import { audit } from './audit.ts';
import type { RequestMeta } from './context.ts';

/**
 * Revokes everything that lets a script or app act as this person without a session: personal
 * API keys, connected OAuth apps and their pending authorization codes, calendar feeds. Run after a password
 * reset (and, when asked, a password change or turning on 2FA), so a key or MCP grant minted by
 * whoever had the account doesn't outlive the recovery; and when an unverified account is released
 * from an address someone proved (`claimableUser` in sso.ts). Each revocation is audited as if the
 * person had removed it themselves, with `via` saying why.
 */
export async function revokeCredentials(
  tx: DbOrTx,
  userId: string,
  via: 'reset' | 'password_change' | '2fa_enabled' | 'released',
  meta: RequestMeta | null,
) {
  const keys = await tx
    .delete(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .returning({ id: apiKeys.id, name: apiKeys.name });
  for (const key of keys) {
    await audit(
      tx,
      {
        action: 'api_key.revoked',
        actorId: userId,
        targetType: 'api_key',
        targetId: key.id,
        data: { name: key.name, via },
      },
      meta,
    );
  }
  await tx.delete(oauthCodes).where(eq(oauthCodes.userId, userId));
  const grants = await tx
    .delete(oauthGrants)
    .where(eq(oauthGrants.userId, userId))
    .returning({ workspaceId: oauthGrants.workspaceId, clientId: oauthGrants.clientId });
  for (const grant of grants) {
    const [client] = await tx
      .select({ name: oauthClients.name })
      .from(oauthClients)
      .where(eq(oauthClients.id, grant.clientId));
    await audit(
      tx,
      {
        action: 'oauth.revoked',
        workspaceId: grant.workspaceId,
        actorId: userId,
        targetType: 'oauth_client',
        targetId: grant.clientId,
        data: { client: client?.name, via },
      },
      meta,
    );
  }
  const feeds = await tx
    .delete(calendarFeeds)
    .where(eq(calendarFeeds.userId, userId))
    .returning({ id: calendarFeeds.id, workspaceId: calendarFeeds.workspaceId });
  for (const feed of feeds) {
    await audit(
      tx,
      {
        action: 'calendar_feed.revoked',
        workspaceId: feed.workspaceId,
        actorId: userId,
        targetType: 'calendar_feed',
        targetId: feed.id,
        data: { via },
      },
      meta,
    );
  }
  return { apiKeys: keys.length, oauthGrants: grants.length, calendarFeeds: feeds.length };
}

/**
 * Every way to sign in or act as the account: sessions, passkeys, linked SSO identities, pending
 * email links and what `revokeCredentials` covers. Whoever held an unverified account may not own
 * the address, so this runs when such an account is released (`claimableUser` in sso.ts) and when
 * a password reset first proves the address: after that, the new password is the only way in
 * known to belong to the owner. TOTP and recovery codes stay: they only work after a password, so
 * they let no one in, and removing them would let a reset link alone get past someone's 2FA.
 */
export async function revokeSignIns(
  tx: DbOrTx,
  userId: string,
  via: 'reset' | 'released',
  meta: RequestMeta | null,
) {
  const signedOut = await tx
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  const keys = await tx
    .delete(passkeys)
    .where(eq(passkeys.userId, userId))
    .returning({ id: passkeys.id });
  const identities = await tx
    .delete(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .returning({ id: userIdentities.id });
  await tx.delete(authTokens).where(eq(authTokens.userId, userId));
  const credentials = await revokeCredentials(tx, userId, via, meta);
  return {
    sessions: signedOut.length,
    passkeys: keys.length,
    identities: identities.length,
    ...credentials,
  };
}
