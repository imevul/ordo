import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { authProviders, authStates } from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import { safeFetch } from '../lib/safeFetch.ts';
import { authProviderSecretAad } from './secretKey.ts';
import { type Provider, type SsoClaims, STATE_TTL_MS, safeRedirect, takeState } from './sso.ts';

/**
 * OpenID Connect: discovery, the authorization-code flow with PKCE, and the claims it yields.
 * What happens with those claims is protocol-neutral and lives in sso.ts.
 */

export const CALLBACK_PATH = '/api/auth/oidc/callback';

const configs = new Map<string, { config: oidc.Configuration; at: number }>();

/** Discovers (and caches for 10 minutes) the provider's configuration, fetched through safeFetch. */
export async function providerConfig(
  app: FastifyInstance,
  provider: Provider,
): Promise<oidc.Configuration> {
  const { issuer, clientId, clientSecret } = provider;
  if (provider.protocol !== 'oidc' || !issuer || !clientId || !clientSecret)
    throw new Error('Not an OpenID Connect provider');
  const key = `${provider.id}:${provider.updatedAt}`;
  const cached = configs.get(key);
  if (cached && Date.now() - cached.at < 600_000) return cached.config;
  const allowPrivate = app.settings.get('allowPrivateNetworkTargets');
  const customFetch: oidc.CustomFetch = async (url, init) => {
    const body =
      init.body instanceof URLSearchParams
        ? init.body.toString()
        : (init.body as string | undefined);
    const res = await safeFetch(url, {
      method: init.method,
      headers: Object.fromEntries(
        new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).entries(),
      ),
      body,
      allowPrivate,
    });
    return new Response(res.status === 204 ? null : res.body, {
      status: res.status,
      headers: res.headers,
    });
  };
  const discover = (issuer: string) =>
    oidc.discovery(
      new URL(issuer),
      clientId,
      app.keyring.decrypt(clientSecret, authProviderSecretAad(provider.id)),
      undefined,
      {
        [oidc.customFetch]: customFetch,
        // Check ID token signatures against the provider's keys too: by default openid-client
        // trusts TLS for tokens from the token endpoint, so whoever answers there could mint any
        // identity. Plain-http issuers are only reachable on private networks (e.g. a LAN
        // Keycloak), which the admin has to allow explicitly anyway.
        execute: [
          oidc.enableNonRepudiationChecks,
          ...(issuer.startsWith('http://') && allowPrivate ? [oidc.allowInsecureRequests] : []),
        ],
      },
    );
  let config: oidc.Configuration;
  try {
    config = await discover(issuer);
  } catch (err) {
    // Issuers must match to the character, and some end in "/" (Authentik) while others don't
    // (Keycloak). Admins paste either, so try the other spelling before giving up, and keep it.
    const other = issuer.endsWith('/') ? issuer.replace(/\/+$/, '') : `${issuer}/`;
    try {
      config = await discover(other);
    } catch {
      throw err;
    }
    await app.db
      .update(authProviders)
      .set({ issuer: other })
      .where(eq(authProviders.id, provider.id));
    provider.issuer = other;
  }
  configs.set(key, { config, at: Date.now() });
  return config;
}

export async function beginLogin(
  app: FastifyInstance,
  provider: Provider,
  opts: { mode: 'login' | 'link' | 'test'; userId?: string | null; redirect?: string | null },
) {
  const config = await providerConfig(app, provider);
  const state = randomBytes(24).toString('base64url');
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  await app.db.insert(authStates).values({
    id: state,
    providerId: provider.id,
    nonce,
    codeVerifier,
    mode: opts.mode,
    userId: opts.userId ?? null,
    redirect: safeRedirect(opts.redirect),
    expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${app.env.publicUrl}${CALLBACK_PATH}`,
    scope: provider.scopes || 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    // Only the query response mode: a cross-site POST callback wouldn't carry our SameSite=Lax cookie.
    response_mode: 'query',
    state,
    nonce,
  });
  return { url: url.toString(), state };
}

/** Exchanges the code. The state row binds the callback to its provider, so `iss` is checked against it. */
export async function completeLogin(
  app: FastifyInstance,
  callbackUrl: URL,
  cookieState: string | undefined,
) {
  const { state: row, provider } = await takeState(
    app,
    callbackUrl.searchParams.get('state'),
    cookieState,
  );
  // A SAML attempt's state can't finish here.
  if (!row.codeVerifier || !row.nonce)
    throw badRequest('This sign-in attempt expired. Try again.').as('sign_in_expired');
  const config = await providerConfig(app, provider);
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: row.codeVerifier,
    expectedState: row.id,
    expectedNonce: row.nonce,
    idTokenExpected: true,
  });
  let claims = (tokens.claims() ?? {}) as SsoClaims;
  // Some IdPs only put email and groups in the userinfo response.
  if (
    (!claims.email || (provider.groupClaim && !(provider.groupClaim in claims))) &&
    tokens.access_token
  ) {
    try {
      const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      claims = {
        ...info,
        ...claims,
        email: claims.email ?? info.email,
        email_verified: claims.email_verified ?? info.email_verified,
      } as SsoClaims;
    } catch {
      // userinfo is optional
    }
  }
  return { provider, state: row, claims };
}
