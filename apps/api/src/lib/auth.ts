import type { MemberRole } from '@ordo/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import {
  apiKeys,
  authProviders,
  oauthGrants,
  oauthTokens,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { type Access, computeAccess } from '../services/access.ts';
import { audit } from '../services/audit.ts';
import { ACCESS_PREFIX } from '../services/oauth.ts';
import { randomToken, sha256 } from './crypto.ts';
import { forbidden, HttpError, notFound, unauthorized } from './errors.ts';

export const SESSION_COOKIE = 'ordo_session';
const SESSION_DAYS = 30;
const DAY = 86_400_000;
export const API_KEY_PREFIX = 'ordo_';
/** SCIM tokens (services/scim.ts) share the prefix's start but are never API keys. */
export const SCIM_TOKEN_PREFIX = 'ordo_scim_';

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  email: string;
  avatarColor: string;
  avatarFileId: string | null;
  isInstanceAdmin: boolean;
}

export interface WorkspaceCtx {
  id: string;
  slug: string;
  name: string;
  role: MemberRole;
  access: Access;
}

/** Set when the session was created by an SSO login. */
export interface SsoSession {
  providerId: string;
  expiresAt: string | null;
}

/** How the caller authenticated; require-SSO decides from this. */
export type AuthMethod = 'session' | 'api_key' | 'oauth';

/** An OAuth access token: good for one workspace's MCP endpoint only. */
export interface OAuthAuth {
  workspaceId: string;
  grantId: string;
}

export interface AuthInfo {
  method: AuthMethod;
  sso: SsoSession | null;
  /** Skips the require-SSO check (used to let admins test a provider before switching it on). */
  ignoreSso?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    authMethod: AuthMethod | null;
    sso: SsoSession | null;
    oauth: OAuthAuth | null;
    workspace: WorkspaceCtx | null;
  }
}

const userColumns = {
  id: users.id,
  name: users.name,
  username: users.username,
  email: users.email,
  avatarColor: users.avatarColor,
  avatarFileId: users.avatarFileId,
  isInstanceAdmin: users.isInstanceAdmin,
};

/** Only enabled, human accounts can authenticate. Bots and placeholders exist for attribution only. */
const canSignIn = and(isNull(users.disabledAt), eq(users.kind, 'human'));

// last_seen_at is a hint for the sessions list, so write it at most this often.
const LAST_SEEN_RESOLUTION = 5 * 60_000;

export async function createSession(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
  req: FastifyRequest,
  sso?: { authProviderId: string; ssoExpiresAt: string | null },
  method: 'password' | 'passkey' = 'password',
) {
  const token = randomToken();
  const now = new Date();
  await app.db.insert(sessions).values({
    id: sha256(token),
    userId,
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    ip: req.ip ?? null,
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY).toISOString(),
    authProviderId: sso?.authProviderId ?? null,
    ssoExpiresAt: sso?.ssoExpiresAt ?? null,
  });
  setSessionCookie(app, reply, token);
  if (!sso) await auditSsoBypass(app.db, userId, req, method);
}

/** Owners of require-SSO workspaces may still use their password; each such sign-in is audited there. */
async function auditSsoBypass(
  db: Db,
  userId: string,
  req: FastifyRequest,
  method: 'password' | 'passkey',
) {
  const owned = await db
    .select({ id: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.role, 'owner'),
        sql`(${workspaces.settings}->>'requireSso')::boolean is true`,
      ),
    );
  for (const ws of owned) {
    await audit(
      db,
      {
        action: 'auth.sso_bypass',
        actorId: userId,
        workspaceId: ws.id,
        data: { method },
      },
      { ip: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 300) ?? null },
    );
  }
}

function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: app.env.secureCookies,
    maxAge: SESSION_DAYS * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Resolves the caller from a session cookie, an `Authorization: Bearer ordo_…` API key or an
 * OAuth access token (which the caller has to confine to the MCP endpoint).
 */
export async function resolveUser(
  db: Db,
  req: FastifyRequest,
): Promise<{
  user: AuthUser;
  sessionId: string | null;
  method: AuthMethod;
  sso: SsoSession | null;
  oauth?: OAuthAuth;
} | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token.startsWith(ACCESS_PREFIX)) return resolveAccessToken(db, token);
    // SCIM tokens provision a workspace (routes/scim.ts); they are nobody.
    if (token.startsWith(SCIM_TOKEN_PREFIX) || !token.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await db
      .select({ user: userColumns, keyId: apiKeys.id })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.tokenHash, sha256(token)), canSignIn));
    if (!row) return null;
    db.update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, row.keyId))
      .catch(() => {});
    return { user: row.user, sessionId: null, method: 'api_key', sso: null };
  }

  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const [row] = await db
    .select({
      user: userColumns,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      providerId: sessions.authProviderId,
      ssoExpiresAt: sessions.ssoExpiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date().toISOString()), canSignIn));
  if (!row) return null;
  const now = Date.now();
  // The org's "SSO session max age": the user has to go back through their IdP.
  if (row.ssoExpiresAt && new Date(row.ssoExpiresAt).getTime() < now) {
    db.delete(sessions)
      .where(eq(sessions.id, id))
      .catch(() => {});
    return null;
  }
  const patch: Partial<typeof sessions.$inferInsert> = {};
  // Sliding expiry: extend sessions that are past half their lifetime.
  if (new Date(row.expiresAt).getTime() - now < (SESSION_DAYS / 2) * DAY) {
    patch.expiresAt = new Date(now + SESSION_DAYS * DAY).toISOString();
  }
  if (!row.lastSeenAt || now - new Date(row.lastSeenAt).getTime() > LAST_SEEN_RESOLUTION) {
    patch.lastSeenAt = new Date(now).toISOString();
    patch.ip = req.ip ?? null;
  }
  if (Object.keys(patch).length) {
    db.update(sessions)
      .set(patch)
      .where(eq(sessions.id, id))
      .catch(() => {});
  }
  const sso = row.providerId ? { providerId: row.providerId, expiresAt: row.ssoExpiresAt } : null;
  return { user: row.user, sessionId: id, method: 'session', sso };
}

async function resolveAccessToken(db: Db, token: string) {
  const now = new Date().toISOString();
  const [row] = await db
    .select({
      user: userColumns,
      grantId: oauthGrants.id,
      workspaceId: oauthGrants.workspaceId,
      providerId: oauthGrants.ssoProviderId,
      ssoExpiresAt: oauthGrants.ssoExpiresAt,
      lastUsedAt: oauthGrants.lastUsedAt,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(
      and(
        eq(oauthTokens.tokenHash, sha256(token)),
        eq(oauthTokens.kind, 'access'),
        gt(oauthTokens.expiresAt, now),
        canSignIn,
      ),
    );
  if (!row) return null;
  // Granted from an SSO login: it ends with that login's maximum age.
  if (row.ssoExpiresAt && new Date(row.ssoExpiresAt).getTime() < Date.now()) return null;
  if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > LAST_SEEN_RESOLUTION) {
    db.update(oauthGrants)
      .set({ lastUsedAt: now })
      .where(eq(oauthGrants.id, row.grantId))
      .catch(() => {});
  }
  return {
    user: row.user,
    sessionId: null,
    method: 'oauth' as const,
    sso: row.providerId ? { providerId: row.providerId, expiresAt: row.ssoExpiresAt } : null,
    oauth: { workspaceId: row.workspaceId, grantId: row.grantId },
  };
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export const authInfo = (req: FastifyRequest): AuthInfo => ({
  method: req.authMethod ?? 'session',
  sso: req.sso,
});

/**
 * Resolves a workspace by slug for a signed-in user and computes their access. Used by every
 * workspace route and by the WebSocket, so membership and require-SSO rules are enforced in one
 * place. Non-members get "not found", so the workspace's existence doesn't leak.
 */
export async function authorizeWorkspace(
  db: Db,
  user: AuthUser,
  ref: string | { id: string },
  auth: AuthInfo,
): Promise<WorkspaceCtx> {
  const [row] = await db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      role: workspaceMembers.role,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, user.id),
        // Suspended members keep their history but lose access.
        isNull(workspaceMembers.suspendedAt),
      ),
    )
    // Re-checked here (not just at sign-in) so live sockets of disabled accounts are closed.
    .innerJoin(users, and(eq(users.id, workspaceMembers.userId), isNull(users.disabledAt)))
    .where(typeof ref === 'string' ? eq(workspaces.slug, ref) : eq(workspaces.id, ref.id));
  if (!row) throw notFound('Workspace');
  if (row.settings?.requireSso && !auth.ignoreSso) await assertSso(db, row, auth);
  const { settings: _settings, ...ws } = row;
  return { ...ws, access: await computeAccess(db, user.id, row.id, row.role) };
}

/**
 * Require SSO: the session must come from one of this workspace's providers. Owners keep their
 * password as a break-glass (audited at login), so a broken IdP can't lock an org out.
 */
async function assertSso(
  db: Db,
  ws: {
    id: string;
    name: string;
    role: MemberRole;
    settings: { allowApiKeysUnderSso?: boolean } | null;
  },
  auth: AuthInfo,
) {
  if (ws.role === 'owner') return;
  if (auth.method === 'api_key') {
    if (ws.settings?.allowApiKeysUnderSso) return;
    throw new HttpError(403, `${ws.name} doesn't allow API keys`, 'sso_required').as(
      'api_keys_not_allowed',
      { workspace: ws.name },
    );
  }
  const providers = await db
    .select({ providerId: authProviders.id, name: authProviders.name })
    .from(authProviders)
    .where(and(eq(authProviders.workspaceId, ws.id), eq(authProviders.enabled, true)));
  if (auth.sso && providers.some((p) => p.providerId === auth.sso!.providerId)) return;
  throw new HttpError(403, `${ws.name} requires signing in with SSO`, 'sso_required', {
    workspace: ws.name,
    options: providers.map((p) => ({ ...p, workspace: ws.name })),
  }).as('sso_required', { workspace: ws.name });
}

export function requireWorkspace(req: FastifyRequest): WorkspaceCtx {
  if (!req.workspace) throw notFound('Workspace');
  return req.workspace;
}

export const requireAccess = (req: FastifyRequest): Access => requireWorkspace(req).access;

/** Owners and admins. */
export function requireAdmin(req: FastifyRequest): WorkspaceCtx {
  const ws = requireWorkspace(req);
  if (!ws.access.isAdmin) throw forbidden('Only workspace admins can do this').as('admins_only');
  return ws;
}

export function requireOwner(req: FastifyRequest): WorkspaceCtx {
  const ws = requireWorkspace(req);
  if (!ws.access.isOwner) throw forbidden('Only workspace owners can do this').as('owners_only');
  return ws;
}
