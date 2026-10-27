import {
  AVATAR_COLORS,
  changePasswordSchema,
  createApiKeySchema,
  createWorkspaceSchema,
  DEFAULT_LOCALE,
  forgotPasswordSchema,
  type InstanceConfig,
  loginSchema,
  type Me,
  mfaLoginSchema,
  passkeyLoginSchema,
  resetPasswordSchema,
  signupSchema,
  tokenSchema,
  updateMeSchema,
} from '@ordo/shared';
import { and, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Tx } from '../db/client.ts';
import {
  apiKeys,
  authTokens,
  invites,
  sessions,
  teams,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { localeOf } from '../i18n/index.ts';
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
import { requestMeta } from '../lib/mutate.ts';
import { systemAccess } from '../services/access.ts';
import { audit, auditCtx } from '../services/audit.ts';
import type { Ctx } from '../services/context.ts';
import { resolvePreferences } from '../services/digest.ts';
import { signedFileUrl } from '../services/files.ts';
import { passwordResetEmail, securityEmail, verifyEmailEmail } from '../services/mail-templates.ts';
import { queueEmail } from '../services/mailer.ts';
import { verifySecondFactor } from '../services/mfa.ts';
import {
  authenticationOptions,
  passkeyFailed,
  relyingParty,
  verifyPasskey,
} from '../services/passkeys.ts';
import { createTeam } from '../services/teams.ts';
import { consumeToken, createToken } from '../services/tokens.ts';
import { joinWorkspace } from '../services/workspaces.ts';

// A well-formed hash nobody can match, compared against when the account doesn't exist.
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

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
    throw forbidden('This invite was sent to a different email address').as('invite_other_email');
  }
  await joinWorkspace(tx, invite.workspaceId, userId, invite.role, invite.teamIds);
  // Email-bound invites are single use; open invite links stay valid until they expire.
  if (invite.email) {
    await tx
      .update(invites)
      .set({ acceptedAt: new Date().toISOString() })
      .where(eq(invites.id, invite.id));
  }
  await audit(tx, {
    action: 'invite.accepted',
    workspaceId: invite.workspaceId,
    actorId: userId,
    targetType: 'invite',
    targetId: invite.id,
    data: { role: invite.role },
  });
  const [ws] = await tx
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, invite.workspaceId));
  return ws!.slug;
}

export async function authRoutes(app: FastifyInstance) {
  const { db, env, settings } = app;

  app.get('/config', async (): Promise<InstanceConfig> => {
    const [{ n }] = (await db.select({ n: count() }).from(users)) as [{ n: number }];
    return {
      signupMode: settings.get('signupMode'),
      hasUsers: n > 0,
      emailEnabled: app.mailer.enabled,
      allowWorkspaceCreation: settings.get('allowWorkspaceCreation'),
      version: env.version,
      passkeyOrigin: relyingParty(app).usable ? relyingParty(app).origin : null,
    };
  });

  app.post('/auth/signup', authLimit, async (req, reply) => {
    const input = parse(signupSchema, req.body);
    const email = input.email.toLowerCase();
    const result = await db.transaction(async (tx) => {
      const [{ n }] = (await tx.select({ n: count() }).from(users)) as [{ n: number }];
      const invite = input.inviteToken ? await findInvite(tx, input.inviteToken) : null;
      if (input.inviteToken && !invite)
        throw badRequest('This invite link is invalid or has expired').as('invite_invalid');
      if (n > 0 && settings.get('signupMode') === 'invite' && !invite)
        throw forbidden('Sign-ups on this instance require an invite').as('invite_required');
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing) throw conflict('An account with this email already exists').as('email_taken');
      const [user] = await tx
        .insert(users)
        .values({
          email,
          name: input.name,
          username: await uniqueUsername(tx, email),
          passwordHash: await hashPassword(input.password),
          preferences: input.locale ? { locale: input.locale } : {},
          avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
          // The first account on an instance administers it.
          isInstanceAdmin: n === 0,
        })
        .returning({ id: users.id });
      await audit(
        tx,
        { action: 'auth.signup', actorId: user!.id, data: { invited: !!invite } },
        requestMeta(req),
      );
      const workspaceSlug = invite ? await acceptInvite(tx, invite, user!.id, email) : null;
      if (app.mailer.enabled) {
        const token = await createToken(tx, user!.id, 'email_verify', 48 * 60, { email });
        await queueEmail(
          tx,
          email,
          verifyEmailEmail(
            input.locale ?? DEFAULT_LOCALE,
            input.name,
            `${env.publicUrl}/verify-email/${token}`,
          ),
        );
      }
      return { userId: user!.id, workspaceSlug };
    });
    await createSession(app, reply, result.userId, req);
    return { ok: true, workspaceSlug: result.workspaceSlug };
  });

  app.post('/auth/login', authLimit, async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const email = input.email.toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    // Always run a hash comparison so timing does not reveal which emails exist or have passwords.
    const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    const usable = user && user.kind === 'human' && user.passwordHash && valid;
    if (!usable) {
      await audit(
        db,
        { action: 'auth.login_failed', actorId: user?.id ?? null, data: { email } },
        requestMeta(req),
      );
      throw unauthorized('Wrong email or password').as('wrong_credentials');
    }
    if (user.disabledAt)
      throw forbidden('This account has been disabled. Contact your administrator.').as(
        'account_disabled',
      );
    if (user.totpEnabledAt) {
      // Password was right; the session is created only after the second factor.
      const mfaToken = await createToken(db, user.id, 'mfa', 10);
      return { ok: false, mfaRequired: true, mfaToken };
    }
    await audit(
      db,
      { action: 'auth.login', actorId: user.id, data: { method: 'password' } },
      requestMeta(req),
    );
    await createSession(app, reply, user.id, req);
    return { ok: true };
  });

  // ─── passkeys: sign in without a password ────────────────────────────

  app.post('/auth/passkey/options', authLimit, async () => {
    if (!relyingParty(app).usable)
      throw badRequest('Passkeys need Ordo on an https address').as('passkey_failed');
    return authenticationOptions(app, 'login', null);
  });

  app.post('/auth/passkey', authLimit, async (req, reply) => {
    const input = parse(passkeyLoginSchema, req.body);
    let userId: string;
    try {
      ({ userId } = await verifyPasskey(app, db, input, 'login', null));
    } catch (err) {
      await audit(
        db,
        { action: 'auth.login_failed', actorId: null, data: { method: 'passkey' } },
        requestMeta(req),
      );
      throw err;
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || user.kind !== 'human') throw passkeyFailed();
    if (user.disabledAt)
      throw forbidden('This account has been disabled. Contact your administrator.').as(
        'account_disabled',
      );
    await audit(
      db,
      { action: 'auth.login', actorId: user.id, data: { method: 'passkey' } },
      requestMeta(req),
    );
    await createSession(app, reply, user.id, req, undefined, 'passkey');
    return { ok: true };
  });

  app.post('/auth/mfa', authLimit, async (req, reply) => {
    const input = parse(mfaLoginSchema, req.body);
    const userId = await db.transaction(async (tx) => {
      const token = await consumeToken(tx, 'mfa', input.mfaToken);
      const [user] = await tx.select().from(users).where(eq(users.id, token.userId));
      if (!user || user.disabledAt || !user.totpEnabledAt)
        throw unauthorized('Sign in again').as('sign_in_again');
      if (!(await verifySecondFactor(tx, app.keyring, user, input.code))) return null;
      await audit(
        tx,
        { action: 'auth.login', actorId: user.id, data: { method: 'password+totp' } },
        requestMeta(req),
      );
      return user.id;
    });
    if (!userId) {
      // A wrong code doesn't burn the step: reissue the token so they can try again.
      const [row] = await db
        .select({ userId: authTokens.userId })
        .from(authTokens)
        .where(eq(authTokens.tokenHash, sha256(input.mfaToken)));
      await audit(
        db,
        { action: 'auth.login_failed', actorId: row?.userId ?? null, data: { method: 'totp' } },
        requestMeta(req),
      );
      if (row)
        await db
          .update(authTokens)
          .set({ usedAt: null })
          .where(eq(authTokens.tokenHash, sha256(input.mfaToken)));
      throw unauthorized('That code is not valid').as('invalid_code');
    }
    await createSession(app, reply, userId, req);
    return { ok: true };
  });

  app.post('/auth/forgot', authLimit, async (req) => {
    const { email } = parse(forgotPasswordSchema, req.body);
    if (!app.mailer.enabled) {
      throw badRequest(
        "Email isn't set up on this instance. Ask an administrator to reset your password.",
      );
    }
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    // Same answer whether or not the account exists.
    if (user && user.kind === 'human' && !user.disabledAt) {
      await db.transaction(async (tx) => {
        const token = await createToken(tx, user.id, 'password_reset', 60);
        await queueEmail(
          tx,
          user.email,
          passwordResetEmail(
            localeOf(user.preferences),
            user.name,
            `${env.publicUrl}/reset-password/${token}`,
          ),
        );
      });
    }
    return { ok: true };
  });

  app.post('/auth/reset', authLimit, async (req, reply) => {
    const input = parse(resetPasswordSchema, req.body);
    const passwordHash = await hashPassword(input.password);
    const userId = await db.transaction(async (tx) => {
      const token = await consumeToken(tx, 'password_reset', input.token);
      // Resetting by email also proves the address.
      await tx
        .update(users)
        .set({ passwordHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
        .where(eq(users.id, token.userId));
      await tx.delete(sessions).where(eq(sessions.userId, token.userId));
      await audit(
        tx,
        { action: 'auth.password_changed', actorId: token.userId, data: { via: 'reset' } },
        requestMeta(req),
      );
      return token.userId;
    });
    const [user] = await db
      .select({ totp: users.totpEnabledAt })
      .from(users)
      .where(eq(users.id, userId));
    // With 2FA on, a reset link alone doesn't sign you in.
    if (user?.totp) return { ok: true, signedIn: false };
    await createSession(app, reply, userId, req);
    return { ok: true, signedIn: true };
  });

  app.post('/auth/verify-email', async (req) => {
    const { token } = parse(tokenSchema, req.body);
    await db.transaction(async (tx) => {
      const row = await consumeToken(tx, 'email_verify', token);
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date().toISOString() })
        .where(and(eq(users.id, row.userId), eq(users.email, String(row.data.email))));
    });
    return { ok: true };
  });

  app.post('/auth/confirm-email-change', async (req) => {
    const { token } = parse(tokenSchema, req.body);
    try {
      await db.transaction(async (tx) => {
        const row = await consumeToken(tx, 'email_change', token);
        const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
        if (!user) throw badRequest('This link is invalid or has expired').as('link_invalid');
        const next = String(row.data.email);
        await tx
          .update(users)
          .set({
            email: next,
            emailVerifiedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(users.id, user.id));
        await audit(
          tx,
          { action: 'auth.email_changed', actorId: user.id, data: { from: user.email, to: next } },
          requestMeta(req),
        );
        // Tell the old address, in case the change wasn't wanted.
        await queueEmail(
          tx,
          user.email,
          securityEmail(localeOf(user.preferences), {
            notice: 'emailChanged',
            params: { email: next },
          }),
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw conflict('Another account already uses that email').as('email_taken');
      throw err;
    }
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionId) {
      await db.delete(sessions).where(eq(sessions.id, req.sessionId));
      await audit(db, { action: 'auth.logout', actorId: req.user?.id }, requestMeta(req));
    }
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
    const [prefs] = await db
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, user.id));
    const { avatarFileId, ...rest } = user;
    return {
      ...rest,
      avatarUrl: signedFileUrl(app, avatarFileId),
      locale: resolvePreferences(prefs?.preferences).locale,
      workspaces: memberships,
    };
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
      if (isUniqueViolation(err)) throw conflict('That username is taken').as('username_taken');
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
    if (!row?.hash)
      throw badRequest('This account signs in through SSO and has no password').as(
        'sso_no_password',
      );
    if (!(await verifyPassword(input.currentPassword, row.hash)))
      throw badRequest('Current password is wrong').as('current_password_wrong');
    const passwordHash = await hashPassword(input.newPassword);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      // Sign out every other session.
      if (req.sessionId)
        await tx
          .delete(sessions)
          .where(and(eq(sessions.userId, user.id), ne(sessions.id, req.sessionId)));
      await audit(tx, { action: 'auth.password_changed', actorId: user.id }, requestMeta(req));
    });
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
    const key = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({ userId: user.id, name, tokenHash: sha256(token), prefix: token.slice(0, 12) })
        .returning({ id: apiKeys.id });
      await audit(
        tx,
        {
          action: 'api_key.created',
          actorId: user.id,
          targetType: 'api_key',
          targetId: row!.id,
          data: { name },
        },
        requestMeta(req),
      );
      return row;
    });
    // The plaintext token is returned exactly once.
    return { id: key!.id, token };
  });

  app.delete('/me/api-keys/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [removed] = await db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
      .returning({ id: apiKeys.id, name: apiKeys.name });
    if (removed) {
      await audit(
        db,
        {
          action: 'api_key.revoked',
          actorId: user.id,
          targetType: 'api_key',
          targetId: id,
          data: { name: removed.name },
        },
        requestMeta(req),
      );
    }
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
    const teamRows = invite.teamIds.length
      ? await db.select({ name: teams.name }).from(teams).where(inArray(teams.id, invite.teamIds))
      : [];
    return {
      workspace: ws,
      email: invite.email,
      role: invite.role,
      teams: teamRows.map((t) => t.name),
    };
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
    if (!settings.get('allowWorkspaceCreation') && n > 0)
      throw forbidden('Creating workspaces is disabled on this instance').as(
        'workspace_creation_off',
      );
    try {
      const slug = await db.transaction(async (tx) => {
        const [ws] = await tx
          .insert(workspaces)
          .values({ name: input.name, slug: input.slug })
          .returning();
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: ws!.id, userId: user.id, role: 'owner' });
        const ctx: Ctx = {
          tx,
          userId: user.id,
          workspaceId: ws!.id,
          access: systemAccess(ws!.id, user.id),
          events: [],
          domainEvents: [],
          source: req.authMethod === 'api_key' ? 'api' : 'web',
          silent: false,
          meta: requestMeta(req),
        };
        await createTeam(ctx, {
          name: input.teamName ?? input.name,
          key: input.teamKey ?? deriveKey(input.teamName ?? input.name),
        });
        await auditCtx(ctx, {
          action: 'workspace.created',
          targetType: 'workspace',
          targetId: ws!.id,
          data: { slug: ws!.slug },
        });
        return ws!.slug;
      });
      return { slug };
    } catch (err) {
      if (isUniqueViolation(err))
        throw conflict('That workspace URL is taken').as('workspace_url_taken');
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
