import type { MemberRole } from '@ordo/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import { apiKeys, sessions, users, workspaceMembers, workspaces } from '../db/schema.ts';
import { randomToken, sha256 } from './crypto.ts';
import { forbidden, notFound, unauthorized } from './errors.ts';

export const SESSION_COOKIE = 'ordo_session';
const SESSION_DAYS = 30;
const DAY = 86_400_000;
export const API_KEY_PREFIX = 'ordo_';

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  email: string;
  avatarColor: string;
  isInstanceAdmin: boolean;
}

export interface WorkspaceCtx {
  id: string;
  slug: string;
  name: string;
  role: MemberRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    authMethod: 'session' | 'api_key' | null;
    workspace: WorkspaceCtx | null;
  }
}

const userColumns = {
  id: users.id,
  name: users.name,
  username: users.username,
  email: users.email,
  avatarColor: users.avatarColor,
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
  });
  setSessionCookie(app, reply, token);
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

/** Resolves the caller from a session cookie or an `Authorization: Bearer ordo_…` API key. */
export async function resolveUser(
  db: Db,
  req: FastifyRequest,
): Promise<{ user: AuthUser; sessionId: string | null; method: 'session' | 'api_key' } | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (!token.startsWith(API_KEY_PREFIX)) return null;
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
    return { user: row.user, sessionId: null, method: 'api_key' };
  }

  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const [row] = await db
    .select({ user: userColumns, expiresAt: sessions.expiresAt, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date().toISOString()), canSignIn));
  if (!row) return null;
  const now = Date.now();
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
  return { user: row.user, sessionId: id, method: 'session' };
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export async function resolveWorkspace(
  db: Db,
  userId: string,
  slug: string,
): Promise<WorkspaceCtx> {
  const [row] = await db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)),
    )
    .where(eq(workspaces.slug, slug));
  if (!row) throw notFound('Workspace');
  return row;
}

export function requireWorkspace(req: FastifyRequest): WorkspaceCtx {
  if (!req.workspace) throw notFound('Workspace');
  return req.workspace;
}

export function requireAdmin(req: FastifyRequest): WorkspaceCtx {
  const ws = requireWorkspace(req);
  if (ws.role !== 'admin') throw forbidden('Only workspace admins can do this');
  return ws;
}
