import type { MemberRole } from '@ordo/shared';
import { and, eq, gt } from 'drizzle-orm';
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
    workspace: WorkspaceCtx | null;
  }
}

const userColumns = {
  id: users.id,
  name: users.name,
  username: users.username,
  email: users.email,
  avatarColor: users.avatarColor,
};

export async function createSession(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
  userAgent?: string,
) {
  const token = randomToken();
  await app.db.insert(sessions).values({
    id: sha256(token),
    userId,
    userAgent: userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(Date.now() + SESSION_DAYS * DAY).toISOString(),
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
): Promise<{ user: AuthUser; sessionId: string | null } | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (!token.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await db
      .select({ user: userColumns, keyId: apiKeys.id })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(eq(apiKeys.tokenHash, sha256(token)));
    if (!row) return null;
    db.update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, row.keyId))
      .catch(() => {});
    return { user: row.user, sessionId: null };
  }

  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const [row] = await db
    .select({ user: userColumns, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date().toISOString())));
  if (!row) return null;
  // Sliding expiry: extend sessions that are past half their lifetime.
  if (new Date(row.expiresAt).getTime() - Date.now() < (SESSION_DAYS / 2) * DAY) {
    db.update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_DAYS * DAY).toISOString() })
      .where(eq(sessions.id, id))
      .catch(() => {});
  }
  return { user: row.user, sessionId: id };
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
