import { createHash, timingSafeEqual } from 'node:crypto';
import type { OAuthClientInfo, OAuthGrant } from '@ordo/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
  users,
  workspaces,
} from '../db/schema.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { safeFetch } from '../lib/safeFetch.ts';

/**
 * Ordo as an OAuth 2.1 authorization server for its MCP server, as the MCP spec asks: metadata
 * discovery (RFC 8414, RFC 9728), client ID metadata documents or dynamic registration
 * (RFC 7591), the authorization code flow with mandatory PKCE, and tokens bound to one
 * workspace's MCP endpoint (RFC 8707). Tokens only ever work there; everything else keeps
 * needing a session or a personal API key.
 */

export const SCOPE = 'mcp';
export const ACCESS_PREFIX = 'ordo_oat_';
export const REFRESH_PREFIX = 'ordo_ort_';
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86_400_000;
const CODE_TTL = 5 * 60_000;
const METADATA_TTL = 60 * 60_000;
// Refresh tokens used twice within this window are a client racing itself, not a leak.
const REUSE_GRACE = 30_000;

type Client = typeof oauthClients.$inferSelect;
type Params = Record<string, unknown>;

/** An error in RFC 6749 terms; `redirect` is set when the app may be sent the error. */
export class OAuthError extends Error {
  constructor(
    public error: string,
    message: string,
    public status = 400,
    public redirect?: string,
  ) {
    super(message);
  }
}

const str = (p: Params, key: string) =>
  typeof p[key] === 'string' ? (p[key] as string) : undefined;
const iso = (ms: number) => new Date(ms).toISOString();

export const mcpPath = (slug: string) => `/api/w/${slug}/mcp`;
export const resourceUrl = (app: FastifyInstance, slug: string) =>
  `${app.env.publicUrl}${mcpPath(slug)}`;
export const resourceMetadataUrl = (app: FastifyInstance, slug: string) =>
  `${app.env.publicUrl}/.well-known/oauth-protected-resource${mcpPath(slug)}`;

/** The workspace a `resource` indicator names, when it's one of this instance's MCP endpoints. */
export function slugFromResource(app: FastifyInstance, resource: string | undefined) {
  const prefix = `${app.env.publicUrl}/api/w/`;
  if (!resource?.startsWith(prefix)) return null;
  return /^([a-z0-9-]+)\/mcp\/?$/.exec(resource.slice(prefix.length))?.[1] ?? null;
}

export function authorizationServerMetadata(app: FastifyInstance) {
  const base = app.env.publicUrl;
  const authMethods = ['none', 'client_secret_post', 'client_secret_basic'];
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: authMethods,
    revocation_endpoint_auth_methods_supported: authMethods,
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(app: FastifyInstance, slug: string) {
  return {
    resource: resourceUrl(app, slug),
    authorization_servers: [app.env.publicUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Ordo',
  };
}

// ─── Clients ─────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);

/** https, http on loopback (native apps, RFC 8252), or an app's own scheme. */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000 || value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return !UNSAFE_SCHEMES.has(url.protocol);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string, given: string) {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    return (
      a.protocol === 'http:' &&
      LOOPBACK.has(a.hostname) &&
      b.protocol === 'http:' &&
      b.hostname === a.hostname &&
      b.pathname === a.pathname &&
      b.search === a.search
    );
  } catch {
    return false;
  }
}

const isMetadataUrl = (clientId: string) => /^https?:\/\//.test(clientId);

function httpsUri(value: unknown) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** Reads a client ID metadata document: the client_id is the URL of a JSON description. */
async function fetchClientMetadata(app: FastifyInstance, clientId: string) {
  const allowPrivate = app.settings.get('allowPrivateNetworkTargets');
  const bad = (why: string) => new OAuthError('invalid_client', why);
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw bad('client_id is not a valid URL');
  }
  // Plain http only where private targets are allowed, i.e. a development setup.
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && allowPrivate);
  if (!secure || url.pathname === '/' || url.hash || url.username || url.password)
    throw bad('A URL client_id must be an https URL with a path');
  let doc: Params;
  try {
    const res = await safeFetch(clientId, {
      allowPrivate,
      timeoutMs: 5000,
      maxBytes: 5 * 1024,
      maxRedirects: 0,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = res.json<Params>();
  } catch (err) {
    throw bad(`Couldn't read the app's metadata document (${(err as Error).message})`);
  }
  if (!doc || typeof doc !== 'object' || doc.client_id !== clientId)
    throw bad("The metadata document's client_id must be its own URL");
  const redirectUris = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris.filter(validRedirectUri).slice(0, 20)
    : [];
  if (!redirectUris.length) throw bad('The metadata document lists no usable redirect_uris');
  if ((doc.token_endpoint_auth_method ?? 'none') !== 'none')
    throw bad('Apps described by a metadata document must be public clients (auth method "none")');
  return {
    name: (str(doc, 'client_name') ?? '').trim().slice(0, 100) || url.hostname,
    uri: httpsUri(doc.client_uri),
    redirectUris,
  };
}

/**
 * The client a client_id names. Metadata documents are re-read once they're an hour old, unless
 * `refresh` is off (token requests: the app was vetted when the person said yes).
 */
export async function findClient(
  app: FastifyInstance,
  clientId: string | undefined,
  { refresh = true } = {},
): Promise<Client | null> {
  if (!clientId || clientId.length > 2000) return null;
  const [row] = await app.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  if (!isMetadataUrl(clientId) || (row && !refresh)) return row ?? null;
  if (row?.fetchedAt && Date.now() - new Date(row.fetchedAt).getTime() < METADATA_TTL) return row;
  const doc = await fetchClientMetadata(app, clientId);
  const fetchedAt = new Date().toISOString();
  const [saved] = await app.db
    .insert(oauthClients)
    .values({ clientId, authMethod: 'none', ...doc, fetchedAt })
    .onConflictDoUpdate({ target: oauthClients.clientId, set: { ...doc, fetchedAt } })
    .returning();
  return saved!;
}

/** How the consent screen and the connected-apps list name an app. */
export function clientInfo(c: Pick<Client, 'clientId' | 'name' | 'redirectUris' | 'fetchedAt'>) {
  const verified = c.fetchedAt !== null;
  let host = '';
  try {
    const url = new URL(verified ? c.clientId : c.redirectUris[0]!);
    host = url.host || url.protocol.replace(/:$/, '');
  } catch {}
  return { name: c.name, host, verified } satisfies OAuthClientInfo;
}

/** Dynamic client registration (RFC 7591). Anyone may register; nothing works until someone consents. */
export async function registerClient(app: FastifyInstance, body: Params) {
  const metadata = (why: string) => new OAuthError('invalid_client_metadata', why);
  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    !redirectUris.length ||
    redirectUris.length > 10 ||
    !redirectUris.every(validRedirectUri)
  )
    throw new OAuthError(
      'invalid_redirect_uri',
      'redirect_uris must be https URLs, http://localhost URLs or app-specific schemes',
    );
  const authMethod = str(body, 'token_endpoint_auth_method') ?? 'client_secret_basic';
  if (
    authMethod !== 'none' &&
    authMethod !== 'client_secret_post' &&
    authMethod !== 'client_secret_basic'
  )
    throw metadata(`Unsupported token_endpoint_auth_method: ${authMethod}`);
  const grantTypes = body.grant_types ?? ['authorization_code'];
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
  )
    throw metadata('Only the authorization_code and refresh_token grants are supported');
  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code'))
    throw metadata('Only the code response type is supported');

  const clientId = randomToken(18);
  const secret = authMethod === 'none' ? null : randomToken(32);
  const name = (str(body, 'client_name') ?? '').trim().slice(0, 100) || 'Unnamed app';
  const uri = httpsUri(body.client_uri);
  await app.db.insert(oauthClients).values({
    clientId,
    secretHash: secret ? sha256(secret) : null,
    authMethod,
    name,
    uri,
    redirectUris: redirectUris as string[],
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
    client_name: name,
    ...(uri && { client_uri: uri }),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: authMethod,
  };
}

/** The client behind a token or revocation request, authenticated the way it registered. */
export async function authenticateClient(
  app: FastifyInstance,
  body: Params,
  authorization: string | undefined,
) {
  let id = str(body, 'client_id');
  let secret = str(body, 'client_secret');
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
    try {
      id = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    } catch {
      throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
    }
  }
  const client = await findClient(app, id, { refresh: false });
  if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
  if (client.secretHash) {
    const given = Buffer.from(sha256(secret ?? ''));
    if (!secret || !timingSafeEqual(given, Buffer.from(client.secretHash)))
      throw new OAuthError('invalid_client', 'Wrong client credentials', 401);
  }
  return client;
}

// ─── Authorization ───────────────────────────────────────────────────

export interface AuthorizeRequest {
  client: Client;
  redirectUri: string;
  challenge: string;
  state: string | undefined;
  slug: string;
}

/** Where the app gets the outcome: the redirect URI plus code or error, state and issuer. */
export function redirectWith(
  app: FastifyInstance,
  redirectUri: string,
  state: string | undefined,
  params: Record<string, string>,
) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (state !== undefined) url.searchParams.set('state', state);
  url.searchParams.set('iss', app.env.publicUrl);
  return url.href;
}

/**
 * Checks an authorization request. Without a known client and redirect URI the person sees the
 * error; after that, errors go back to the app.
 */
export async function checkAuthorizeRequest(
  app: FastifyInstance,
  q: Params,
): Promise<AuthorizeRequest> {
  const client = await findClient(app, str(q, 'client_id'));
  if (!client) throw new OAuthError('invalid_client', 'This app is unknown (no such client_id)');
  const asked = str(q, 'redirect_uri');
  const redirectUri = asked
    ? client.redirectUris.some((r) => redirectMatches(r, asked))
      ? asked
      : undefined
    : client.redirectUris.length === 1
      ? client.redirectUris[0]
      : undefined;
  if (!redirectUri)
    throw new OAuthError('invalid_request', "The redirect_uri isn't one this app registered");
  const state = str(q, 'state');
  const back = (error: string, message: string) =>
    new OAuthError(
      error,
      message,
      400,
      redirectWith(app, redirectUri, state, { error, error_description: message }),
    );
  if (str(q, 'response_type') !== 'code')
    throw back('unsupported_response_type', 'Only response_type=code is supported');
  const challenge = str(q, 'code_challenge');
  if (
    !challenge ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
    str(q, 'code_challenge_method') !== 'S256'
  )
    throw back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  // Requested scopes are otherwise ignored: there is one, and it is what gets granted.
  const slug = slugFromResource(app, str(q, 'resource'));
  if (!slug)
    throw back(
      'invalid_target',
      `resource must be a workspace's MCP URL, like ${resourceUrl(app, 'your-workspace')}`,
    );
  return { client, redirectUri, challenge, state, slug };
}

export async function issueCode(
  app: FastifyInstance,
  r: AuthorizeRequest,
  who: {
    userId: string;
    workspaceId: string;
    sso: { providerId: string; expiresAt: string | null } | null;
  },
) {
  const code = randomToken(32);
  await app.db.insert(oauthCodes).values({
    codeHash: sha256(code),
    clientId: r.client.id,
    userId: who.userId,
    workspaceId: who.workspaceId,
    redirectUri: r.redirectUri,
    codeChallenge: r.challenge,
    ssoProviderId: who.sso?.providerId ?? null,
    ssoExpiresAt: who.sso?.expiresAt ?? null,
    expiresAt: iso(Date.now() + CODE_TTL),
  });
  return code;
}

// ─── Tokens ──────────────────────────────────────────────────────────

async function issueTokens(tx: DbOrTx, grantId: string) {
  const access = `${ACCESS_PREFIX}${randomToken(32)}`;
  const refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
  const now = Date.now();
  await tx.insert(oauthTokens).values([
    { grantId, kind: 'access', tokenHash: sha256(access), expiresAt: iso(now + ACCESS_TTL * 1000) },
    { grantId, kind: 'refresh', tokenHash: sha256(refresh), expiresAt: iso(now + REFRESH_TTL) },
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope: SCOPE,
  };
}

const invalidGrant = (message: string) => new OAuthError('invalid_grant', message);

/** The authorization_code grant: a code from the consent screen plus its PKCE verifier. */
export async function exchangeCode(app: FastifyInstance, client: Client, body: Params) {
  const code = str(body, 'code');
  const verifier = str(body, 'code_verifier');
  if (!code || !verifier)
    throw new OAuthError('invalid_request', 'code and code_verifier are required');
  // Deleted before anything is checked, so a code can never be tried twice.
  const [row] = await app.db
    .delete(oauthCodes)
    .where(eq(oauthCodes.codeHash, sha256(code)))
    .returning();
  if (!row || row.clientId !== client.id || new Date(row.expiresAt).getTime() < Date.now())
    throw invalidGrant('The code is invalid, expired or already used');
  const redirectUri = str(body, 'redirect_uri');
  if (redirectUri !== undefined && redirectUri !== row.redirectUri)
    throw invalidGrant("redirect_uri doesn't match the authorization request");
  if (
    !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
    createHash('sha256').update(verifier).digest('base64url') !== row.codeChallenge
  )
    throw invalidGrant("code_verifier doesn't match the code_challenge");
  const resource = str(body, 'resource');
  if (resource !== undefined) {
    const [ws] = await app.db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId));
    if (!ws || slugFromResource(app, resource) !== ws.slug)
      throw new OAuthError('invalid_target', 'resource differs from the authorization request');
  }
  return app.db.transaction(async (tx) => {
    const [grant] = await tx
      .insert(oauthGrants)
      .values({
        clientId: client.id,
        userId: row.userId,
        workspaceId: row.workspaceId,
        ssoProviderId: row.ssoProviderId,
        ssoExpiresAt: row.ssoExpiresAt,
      })
      .returning({ id: oauthGrants.id });
    await tx
      .update(oauthClients)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(oauthClients.id, client.id));
    return issueTokens(tx, grant!.id);
  });
}

/** The refresh_token grant. Each refresh token works once and is replaced (rotation). */
export async function refreshTokens(app: FastifyInstance, client: Client, body: Params) {
  const token = str(body, 'refresh_token');
  if (!token) throw new OAuthError('invalid_request', 'refresh_token is required');
  const [row] = await app.db
    .select({
      id: oauthTokens.id,
      expiresAt: oauthTokens.expiresAt,
      usedAt: oauthTokens.usedAt,
      grantId: oauthGrants.id,
      clientId: oauthGrants.clientId,
      ssoExpiresAt: oauthGrants.ssoExpiresAt,
      disabled: users.disabledAt,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthTokens.tokenHash, sha256(token)), eq(oauthTokens.kind, 'refresh')));
  if (!row || row.clientId !== client.id) throw invalidGrant('Unknown refresh token');
  const now = Date.now();
  if (row.usedAt) {
    if (now - new Date(row.usedAt).getTime() > REUSE_GRACE)
      await app.db.delete(oauthGrants).where(eq(oauthGrants.id, row.grantId));
    throw invalidGrant('This refresh token was already used');
  }
  if (new Date(row.expiresAt).getTime() < now) throw invalidGrant('The refresh token expired');
  if (row.disabled) throw invalidGrant('The account is disabled');
  if (row.ssoExpiresAt && new Date(row.ssoExpiresAt).getTime() < now)
    throw invalidGrant('The single sign-on session this was granted in has ended; sign in again');
  return app.db.transaction(async (tx) => {
    const [used] = await tx
      .update(oauthTokens)
      .set({ usedAt: iso(now) })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.usedAt)))
      .returning({ id: oauthTokens.id });
    if (!used) throw invalidGrant('This refresh token was already used');
    return issueTokens(tx, row.grantId);
  });
}

/**
 * Token revocation (RFC 7009). A refresh token ends the whole grant, an access token just itself.
 * Unknown tokens are not an error.
 */
export async function revokeToken(app: FastifyInstance, client: Client, body: Params) {
  const token = str(body, 'token');
  if (!token) throw new OAuthError('invalid_request', 'token is required');
  const [row] = await app.db
    .select({ id: oauthTokens.id, kind: oauthTokens.kind, grantId: oauthGrants.id })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .where(and(eq(oauthTokens.tokenHash, sha256(token)), eq(oauthGrants.clientId, client.id)));
  if (!row) return;
  if (row.kind === 'refresh')
    await app.db.delete(oauthGrants).where(eq(oauthGrants.id, row.grantId));
  else await app.db.delete(oauthTokens).where(eq(oauthTokens.id, row.id));
}

// ─── Grants ──────────────────────────────────────────────────────────

/** The apps a person has connected, newest first. */
export async function listGrants(db: DbOrTx, userId: string): Promise<OAuthGrant[]> {
  const rows = await db
    .select({
      id: oauthGrants.id,
      lastUsedAt: oauthGrants.lastUsedAt,
      createdAt: oauthGrants.createdAt,
      client: {
        clientId: oauthClients.clientId,
        name: oauthClients.name,
        redirectUris: oauthClients.redirectUris,
        fetchedAt: oauthClients.fetchedAt,
      },
      workspace: { name: workspaces.name, slug: workspaces.slug },
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .innerJoin(workspaces, eq(workspaces.id, oauthGrants.workspaceId))
    .where(eq(oauthGrants.userId, userId))
    .orderBy(desc(oauthGrants.createdAt));
  return rows.map((r) => ({ ...r, client: clientInfo(r.client) }));
}

/** Expired codes and tokens, grants with nothing left, and apps nobody connected. */
export async function pruneOAuth(db: DbOrTx) {
  const now = new Date().toISOString();
  const dayAgo = iso(Date.now() - 86_400_000);
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now));
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now));
  await db
    .delete(oauthGrants)
    .where(sql`not exists (select 1 from oauth_tokens t where t.grant_id = "oauth_grants"."id")`);
  // Registrations never used, and cached metadata documents no grant refers to.
  await db.delete(oauthClients).where(
    and(
      lt(oauthClients.createdAt, dayAgo),
      sql`(("oauth_clients"."fetched_at" is null and "oauth_clients"."last_used_at" is null)
          or "oauth_clients"."fetched_at" is not null)`,
      sql`not exists (select 1 from oauth_grants g where g.client_id = "oauth_clients"."id")`,
      sql`not exists (select 1 from oauth_codes c where c.client_id = "oauth_clients"."id")`,
    ),
  );
}
