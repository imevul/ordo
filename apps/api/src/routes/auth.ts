import {
  AVATAR_COLORS,
  changePasswordSchema,
  createApiKeySchema,
  createWorkspaceSchema,
  type InstanceConfig,
  loginSchema,
  type Me,
  signupSchema,
  updateMeSchema,
} from '@ordo/shared';
import { and, count, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Tx } from '../db/client.ts';
import { apiKeys, invites, sessions, users, workspaceMembers, workspaces } from '../db/schema.ts';
import { API_KEY_PREFIX, clearSessionCookie, createSession, requireUser } from '../lib/auth.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import {
  badRequest,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  parse,
  unauthorized,
} from '../lib/errors.ts';
import { createTeam } from '../services/teams.ts';

const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

async function uniqueUsername(tx: Tx, email: string) {
  const base =
    email
      .split('@')[0]!
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 24) || 'user';
  let candidate = base.length >= 2 ? base : `${base}user`;
  for (let i = 2; ; i++) {
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate));
    if (!taken) return candidate;
    candidate = `${base}${i}`;
  }
}

async function findInvite(tx: Tx, token: string) {
  const [invite] = await tx
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date().toISOString()),
      ),
    );
  return invite ?? null;
}

async function acceptInvite(
  tx: Tx,
  invite: typeof invites.$inferSelect,
  userId: string,
  email: string,
) {
  if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
    throw forbidden('This invite was sent to a different email address');
  }
  await tx
    .insert(workspaceMembers)
    .values({ workspaceId: invite.workspaceId, userId, role: invite.role })
    .onConflictDoNothing();
  // Email-bound invites are single use; open invite links stay valid until they expire.
  if (invite.email)
    await tx
      .update(invites)
      .set({ acceptedAt: new Date().toISOString() })
      .where(eq(invites.id, invite.id));
  const [ws] = await tx
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, invite.workspaceId));
  return ws!.slug;
}

export async function authRoutes(app: FastifyInstance) {
  const { db, env } = app;

  app.get('/config', async (): Promise<InstanceConfig> => {
    const [{ n }] = (await db.select({ n: count() }).from(users)) as [{ n: number }];
    return {
      signupMode: env.signupMode,
      hasUsers: n > 0,
      allowWorkspaceCreation: env.allowWorkspaceCreation,
      version: env.version,
    };
  });

  app.post('/auth/signup', authLimit, async (req, reply) => {
    const input = parse(signupSchema, req.body);
    const email = input.email.toLowerCase();
    const result = await db.transaction(async (tx) => {
      const [{ n }] = (await tx.select({ n: count() }).from(users)) as [{ n: number }];
      const invite = input.inviteToken ? await findInvite(tx, input.inviteToken) : null;
      if (input.inviteToken && !invite)
        throw badRequest('This invite link is invalid or has expired');
      if (n > 0 && env.signupMode === 'invite' && !invite)
        throw forbidden('Sign-ups on this instance require an invite');
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing) throw conflict('An account with this email already exists');
      const [user] = await tx
        .insert(users)
        .values({
          email,
          name: input.name,
          username: await uniqueUsername(tx, email),
          passwordHash: await hashPassword(input.password),
          avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
        })
        .returning({ id: users.id });
      const workspaceSlug = invite ? await acceptInvite(tx, invite, user!.id, email) : null;
      return { userId: user!.id, workspaceSlug };
    });
    await createSession(app, reply, result.userId, req.headers['user-agent']);
    return { ok: true, workspaceSlug: result.workspaceSlug };
  });

  app.post('/auth/login', authLimit, async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.email, input.email.toLowerCase()));
    // Always run a hash comparison so timing does not reveal which emails exist.
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? 'scrypt$32768$8$1$AAAA$AAAA',
    );
    if (!user || !valid) throw unauthorized('Wrong email or password');
    await createSession(app, reply, user.id, req.headers['user-agent']);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionId) await db.delete(sessions).where(eq(sessions.id, req.sessionId));
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req): Promise<Me> => {
    const user = requireUser(req);
    const memberships = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id))
      .orderBy(workspaces.name);
    return { ...user, workspaces: memberships };
  });

  app.patch('/me', async (req) => {
    const user = requireUser(req);
    const input = parse(updateMeSchema, req.body);
    try {
      await db
        .update(users)
        .set({ ...input, updatedAt: new Date().toISOString() })
        .where(eq(users.id, user.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That username is taken');
      throw err;
    }
    const memberships = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id));
    app.realtime.publish(
      memberships.map((m) => ({
        kind: 'member',
        action: 'updated',
        id: user.id,
        workspaceId: m.workspaceId,
        actorId: user.id,
      })),
    );
    return { ok: true };
  });

  app.post('/me/password', authLimit, async (req) => {
    const user = requireUser(req);
    const input = parse(changePasswordSchema, req.body);
    const [row] = await db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id));
    if (!row || !(await verifyPassword(input.currentPassword, row.hash)))
      throw badRequest('Current password is wrong');
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(input.newPassword) })
      .where(eq(users.id, user.id));
    // Sign out every other session.
    if (req.sessionId)
      await db
        .delete(sessions)
        .where(and(eq(sessions.userId, user.id), ne(sessions.id, req.sessionId)));
    return { ok: true };
  });

  app.get('/me/api-keys', async (req) => {
    const user = requireUser(req);
    return db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, user.id))
      .orderBy(desc(apiKeys.createdAt));
  });

  app.post('/me/api-keys', async (req) => {
    const user = requireUser(req);
    const { name } = parse(createApiKeySchema, req.body);
    const token = `${API_KEY_PREFIX}${randomToken(24)}`;
    const [key] = await db
      .insert(apiKeys)
      .values({ userId: user.id, name, tokenHash: sha256(token), prefix: token.slice(0, 12) })
      .returning({ id: apiKeys.id });
    // The plaintext token is returned exactly once.
    return { id: key!.id, token };
  });

  app.delete('/me/api-keys/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await db.delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)));
    return { ok: true };
  });

  app.get('/invites/:token', async (req) => {
    const { token } = req.params as { token: string };
    const invite = await db.transaction((tx) => findInvite(tx, token));
    if (!invite) throw notFound('Invite');
    const [ws] = await db
      .select({ name: workspaces.name, slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, invite.workspaceId));
    return { workspace: ws, email: invite.email, role: invite.role };
  });

  app.post('/invites/:token/accept', async (req) => {
    const user = requireUser(req);
    const { token } = req.params as { token: string };
    const slug = await db.transaction(async (tx) => {
      const invite = await findInvite(tx, token);
      if (!invite) throw notFound('Invite');
      return acceptInvite(tx, invite, user.id, user.email);
    });
    return { workspaceSlug: slug };
  });

  app.post('/workspaces', async (req) => {
    const user = requireUser(req);
    const input = parse(createWorkspaceSchema, req.body);
    const [{ n }] = (await db
      .select({ n: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id))) as [{ n: number }];
    if (!env.allowWorkspaceCreation && n > 0)
      throw forbidden('Creating workspaces is disabled on this instance');
    try {
      const slug = await db.transaction(async (tx) => {
        const [ws] = await tx
          .insert(workspaces)
          .values({ name: input.name, slug: input.slug })
          .returning();
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: ws!.id, userId: user.id, role: 'admin' });
        await createTeam(
          { tx, userId: user.id, workspaceId: ws!.id, events: [] },
          {
            name: input.teamName ?? input.name,
            key: input.teamKey ?? deriveKey(input.teamName ?? input.name),
          },
        );
        return ws!.slug;
      });
      return { slug };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That workspace URL is taken');
      throw err;
    }
  });
}

export function deriveKey(name: string) {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .trim();
  const words = letters.split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'TEAM');
  const clean = key.replace(/^[0-9]+/, '').slice(0, words.length > 1 ? 5 : 3);
  return clean || 'TEAM';
}
