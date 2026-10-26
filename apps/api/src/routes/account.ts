import multipart from '@fastify/multipart';
import {
  type Account,
  changeEmailSchema,
  disableTwoFactorSchema,
  passwordConfirmSchema,
  type SessionInfo,
  totpCodeSchema,
  updatePreferencesSchema,
} from '@ordo/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recoveryCodes, sessions, users, workspaceMembers, workspaces } from '../db/schema.ts';
import { requireUser } from '../lib/auth.ts';
import { verifyPassword } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import { resolvePreferences } from '../services/digest.ts';
import { deleteFile, saveFile, signedFileUrl } from '../services/files.ts';
import { securityEmail, verifyEmailEmail } from '../services/mail-templates.ts';
import { queueEmail } from '../services/mailer.ts';
import {
  beginTotp,
  regenerateRecoveryCodes,
  verifySecondFactor,
  verifyTotp,
} from '../services/mfa.ts';
import { createToken } from '../services/tokens.ts';

/** Sessions are identified to the user by a prefix of their hash; never by the cookie token. */
const publicSessionId = (hash: string) => hash.slice(0, 16);

export async function accountRoutes(app: FastifyInstance) {
  const { db, env } = app;

  const loadUser = async (req: FastifyRequest) => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, requireUser(req).id));
    if (!user) throw notFound('User');
    return user;
  };

  /** Sensitive changes need the current password, unless the account has none (SSO-only). */
  const confirmPassword = async (user: typeof users.$inferSelect, password: string | undefined) => {
    if (!user.passwordHash) return;
    if (!password || !(await verifyPassword(password, user.passwordHash))) {
      throw badRequest('Current password is wrong');
    }
  };

  app.get('/me/account', async (req): Promise<Account> => {
    const user = await loadUser(req);
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
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      avatarColor: user.avatarColor,
      avatarUrl: signedFileUrl(app, user.avatarFileId),
      isInstanceAdmin: user.isInstanceAdmin,
      workspaces: memberships,
      emailVerified: !!user.emailVerifiedAt,
      hasPassword: !!user.passwordHash,
      twoFactorEnabled: !!user.totpEnabledAt,
      preferences: resolvePreferences(user.preferences),
    };
  });

  app.patch('/me/preferences', async (req) => {
    const user = await loadUser(req);
    const input = parse(updatePreferencesSchema, req.body);
    const current = resolvePreferences(user.preferences);
    const next = {
      ...current,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.weekStartsOn !== undefined ? { weekStartsOn: input.weekStartsOn } : {}),
      notifications: {
        ...current.notifications,
        ...(input.notifications?.emailDigest
          ? { emailDigest: input.notifications.emailDigest }
          : {}),
        email: { ...current.notifications.email, ...input.notifications?.email },
      },
    };
    await db.update(users).set({ preferences: next }).where(eq(users.id, user.id));
    return next;
  });

  // ─── avatar (multipart is only parsed in this scope) ──────────────────

  await app.register(async (uploads) => {
    await uploads.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

    uploads.post('/me/avatar', async (req) => {
      const user = await loadUser(req);
      const file = await req.file();
      if (!file) throw badRequest('No file uploaded');
      const body = await file.toBuffer();
      const saved = await saveFile(app, {
        workspaceId: null,
        ownerId: user.id,
        kind: 'avatar',
        filename: file.filename,
        body,
        imagesOnly: true,
      });
      await db
        .update(users)
        .set({ avatarFileId: saved.id, updatedAt: new Date().toISOString() })
        .where(eq(users.id, user.id));
      if (user.avatarFileId) await deleteFile(app, user.avatarFileId);
      await notifyProfileChanged(user.id);
      return { avatarUrl: signedFileUrl(app, saved.id) };
    });
  });

  app.delete('/me/avatar', async (req) => {
    const user = await loadUser(req);
    if (user.avatarFileId) {
      await db.update(users).set({ avatarFileId: null }).where(eq(users.id, user.id));
      await deleteFile(app, user.avatarFileId);
      await notifyProfileChanged(user.id);
    }
    return { ok: true };
  });

  /** Profile changes show up in every workspace the user belongs to. */
  async function notifyProfileChanged(userId: string) {
    const rows = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));
    app.realtime.publish(
      rows.map((r) => ({
        kind: 'member',
        action: 'updated',
        id: userId,
        workspaceId: r.workspaceId,
        actorId: userId,
      })),
    );
  }

  // ─── email ───────────────────────────────────────────────────────────

  /**
   * With email set up, the new address is confirmed by a link sent to it and only then
   * replaces the old one. Without email, the change applies directly but stays unverified.
   */
  app.post('/me/email', async (req) => {
    const user = await loadUser(req);
    const input = parse(changeEmailSchema, req.body);
    await confirmPassword(user, input.password);
    const email = input.email.toLowerCase();
    if (email === user.email) throw badRequest('That is already your email address');
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken) throw conflict('Another account already uses that email');
    if (app.mailer.enabled) {
      await db.transaction(async (tx) => {
        const token = await createToken(tx, user.id, 'email_change', 48 * 60, { email });
        await queueEmail(
          tx,
          email,
          verifyEmailEmail(user.name, `${env.publicUrl}/confirm-email/${token}`, true),
        );
      });
      return { pending: true };
    }
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ email, emailVerifiedAt: null, updatedAt: new Date().toISOString() })
        .where(eq(users.id, user.id));
      await audit(
        tx,
        { action: 'auth.email_changed', actorId: user.id, data: { from: user.email, to: email } },
        requestMeta(req),
      );
    });
    await notifyProfileChanged(user.id);
    return { pending: false };
  });

  app.post('/me/email/verify', async (req) => {
    const user = await loadUser(req);
    if (user.emailVerifiedAt) return { ok: true };
    if (!app.mailer.enabled) throw badRequest("Email isn't set up on this instance");
    await db.transaction(async (tx) => {
      const token = await createToken(tx, user.id, 'email_verify', 48 * 60, { email: user.email });
      await queueEmail(
        tx,
        user.email,
        verifyEmailEmail(user.name, `${env.publicUrl}/verify-email/${token}`),
      );
    });
    return { ok: true };
  });

  // ─── sessions ────────────────────────────────────────────────────────

  app.get('/me/sessions', async (req): Promise<SessionInfo[]> => {
    const user = requireUser(req);
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), sql`${sessions.expiresAt} > now()`))
      .orderBy(desc(sessions.lastSeenAt));
    return rows.map((s) => ({
      id: publicSessionId(s.id),
      current: s.id === req.sessionId,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      sso: !!s.authProviderId,
    }));
  });

  app.delete('/me/sessions/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{16}$/.test(id)) throw notFound('Session');
    const removed = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, user.id), sql`left(${sessions.id}, 16) = ${id}`))
      .returning({ id: sessions.id });
    if (removed.length)
      await audit(db, { action: 'auth.session_revoked', actorId: user.id }, requestMeta(req));
    return { ok: true };
  });

  app.post('/me/sessions/revoke-others', async (req) => {
    const user = requireUser(req);
    if (!req.sessionId) throw forbidden('Use a browser session for this');
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, user.id), ne(sessions.id, req.sessionId)));
    await audit(
      db,
      { action: 'auth.session_revoked', actorId: user.id, data: { others: true } },
      requestMeta(req),
    );
    return { ok: true };
  });

  // ─── two-factor authentication ───────────────────────────────────────

  app.post('/me/2fa/setup', async (req) => {
    const user = await loadUser(req);
    if (user.totpEnabledAt) throw badRequest('Two-factor authentication is already on');
    const { password } = parse(passwordConfirmSchema, req.body);
    await confirmPassword(user, password);
    return beginTotp(db, app.keyring, user);
  });

  app.post('/me/2fa/enable', async (req) => {
    const user = await loadUser(req);
    const { code } = parse(totpCodeSchema, req.body);
    if (user.totpEnabledAt) throw badRequest('Two-factor authentication is already on');
    if (!verifyTotp(app.keyring, user, code))
      throw badRequest('That code is not valid. Check the time on your device.');
    const recoveryCodes = await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpEnabledAt: new Date().toISOString() })
        .where(eq(users.id, user.id));
      await audit(tx, { action: 'auth.2fa_enabled', actorId: user.id }, requestMeta(req));
      await queueEmail(
        tx,
        user.email,
        securityEmail({
          title: 'Two-factor authentication is on',
          body: 'Signing in to Ordo now also needs a code from your authenticator app.',
        }),
      );
      return regenerateRecoveryCodes(tx, user.id);
    });
    return { recoveryCodes };
  });

  app.post('/me/2fa/disable', async (req) => {
    const user = await loadUser(req);
    const input = parse(disableTwoFactorSchema, req.body);
    if (!user.totpEnabledAt) return { ok: true };
    await confirmPassword(user, input.password);
    if (!(await verifySecondFactor(db, app.keyring, user, input.code)))
      throw badRequest('That code is not valid');
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpEnabledAt: null, totpSecret: null })
        .where(eq(users.id, user.id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
      await audit(tx, { action: 'auth.2fa_disabled', actorId: user.id }, requestMeta(req));
      await queueEmail(
        tx,
        user.email,
        securityEmail({
          title: 'Two-factor authentication is off',
          body: 'Signing in to Ordo now only needs your password.',
        }),
      );
    });
    return { ok: true };
  });

  app.post('/me/2fa/recovery-codes', async (req) => {
    const user = await loadUser(req);
    const { code } = parse(totpCodeSchema, req.body);
    if (!user.totpEnabledAt || !verifyTotp(app.keyring, user, code))
      throw badRequest('That code is not valid');
    return { recoveryCodes: await regenerateRecoveryCodes(db, user.id) };
  });
}
