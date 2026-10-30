import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { apiKeys, oauthClients, oauthCodes, oauthGrants } from '../db/schema.ts';
import { audit } from './audit.ts';
import type { RequestMeta } from './context.ts';

/**
 * Revokes everything that lets a script or app act as this person without a session: personal
 * API keys, connected OAuth apps and their pending authorization codes. Run after a password
 * reset (and, when asked, a password change or turning on 2FA), so a key or MCP grant minted by
 * whoever had the account doesn't outlive the recovery. Each revocation is audited as if the
 * person had removed it themselves, with `via` saying why.
 */
export async function revokeCredentials(
  tx: DbOrTx,
  userId: string,
  via: 'reset' | 'password_change' | '2fa_enabled',
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
  return { apiKeys: keys.length, oauthGrants: grants.length };
}
