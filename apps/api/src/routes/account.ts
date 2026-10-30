import multipart from '@fastify/multipart';
import {
  type Account,
  addPasskeySchema,
  changeEmailSchema,
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  notifyPauseSchema,
  type Passkey,
  passkeyOptionsSchema,
  passwordConfirmSchema,
  recoveryCodesSchema,
  removePasskeySchema,
  renamePasskeySchema,
  type SessionInfo,
  setStatusSchema,
  updatePreferencesSchema,
} from '@ordo/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  passkeys,
  recoveryCodes,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { localeOf } from '../i18n/index.ts';
import { requireUser } from '../lib/auth.ts';
import { verifyPassword } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import { revokeCredentials } from '../services/credentials.ts';
import { resolvePreferences } from '../services/digest.ts';
import { deleteFile, saveFile, signedFileUrl } from '../services/files.ts';
import { securityEmail, verifyEmailEmail } from '../services/mail-templates.ts';
import { queueEmail } from '../services/mailer.ts';
import {
  beginTotp,
  hasRecoveryCodes,
  hasSecondFactor,
  regenerateRecoveryCodes,
  verifySecondFactor,
  verifyTotp,
} from '../services/mfa.ts';
import {
  addPasskey,
  listPasskeys,
  registrationOptions,
  relyingParty,
  toPasskey,
} from '../services/passkeys.ts';
import { pauseOf, publishProfileChanged, statusOf } from '../services/status.ts';
import { createToken } from '../services/tokens.ts';
import { mayCreateWorkspace } from '../services/workspaces.ts';

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
      throw badRequest('Current password is wrong').as('current_password_wrong');
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
      canCreateWorkspace: await mayCreateWorkspace(app, user.id),
      emailVerified: !!user.emailVerifiedAt,
      hasPassword: !!user.passwordHash,
      twoFactorEnabled: await hasSecondFactor(db, user),
      totpEnabled: !!user.totpEnabledAt,
      locale: resolvePreferences(user.preferences).locale,
      preferences: resolvePreferences(user.preferences),
      status: statusOf(user),
      notifyPause: pauseOf(user),
    };
  });

  app.patch('/me/preferences', async (req) => {
    const user = await loadUser(req);
    const input = parse(updatePreferencesSchema, req.body);
    const current = resolvePreferences(user.preferences);
    const next = {
      ...current,
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.weekStartsOn !== undefined ? { weekStartsOn: input.weekStartsOn } : {}),
      notifications: {
        ...current.notifications,
        ...(input.notifications?.emailDigest
          ? { emailDigest: input.notifications.emailDigest }
          : {}),
        inbox: { ...current.notifications.inbox, ...input.notifications?.inbox },
        push: { ...current.notifications.push, ...input.notifications?.push },
        email: { ...current.notifications.email, ...input.notifications?.email },
        chat: { ...current.notifications.chat, ...input.notifications?.chat },
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
      if (!file) throw badRequest('No file uploaded').as('no_file');
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

  const notifyProfileChanged = (userId: string) => publishProfileChanged(app, [userId]);

  // ─── status ──────────────────────────────────────────────────────────

  /**
   * Sets your status (seen by everyone in your workspaces) and, with `pause`, holds back pings
   * until it clears. A pause set this way ends with the status.
   */
  app.put('/me/status', async (req) => {
    const user = requireUser(req);
    const input = parse(setStatusSchema, req.body);
    if (!input.kind && !input.emoji && !input.text)
      throw badRequest('Choose a status, or write one');
    if (input.until && Date.parse(input.until) <= Date.now())
      throw badRequest('The status would already be over');
    await db
      .update(users)
      .set({
        statusKind: input.kind,
        statusEmoji: input.emoji ?? null,
        statusText: input.text || null,
        statusUntil: input.until,
        ...(input.pause !== undefined
          ? { notifyPause: input.pause, notifyPauseUntil: input.pause ? input.until : null }
          : {}),
      })
      .where(eq(users.id, user.id));
    await notifyProfileChanged(user.id);
    return { ok: true };
  });

  /** Clears your status, and the pause that came with it (one that ends at the same time). */
  app.delete('/me/status', async (req) => {
    const user = requireUser(req);
    const [row] = await db
      .select({ statusUntil: users.statusUntil, notifyPauseUntil: users.notifyPauseUntil })
      .from(users)
      .where(eq(users.id, user.id));
    const pauseCameWithIt = !!row && row.statusUntil === row.notifyPauseUntil;
    await db
      .update(users)
      .set({
        statusKind: null,
        statusEmoji: null,
        statusText: null,
        statusUntil: null,
        ...(pauseCameWithIt ? { notifyPause: null, notifyPauseUntil: null } : {}),
      })
      .where(eq(users.id, user.id));
    await notifyProfileChanged(user.id);
    return { ok: true };
  });

  /** Holds back push, email and chat pings (they still reach the inbox), or with `mode: null` resumes them. */
  app.put('/me/notify-pause', async (req) => {
    const user = requireUser(req);
    const { mode, until } = parse(notifyPauseSchema, req.body);
    if (mode && until && Date.parse(until) <= Date.now())
      throw badRequest('The pause would already be over');
    await db
      .update(users)
      .set({ notifyPause: mode, notifyPauseUntil: mode ? until : null })
      .where(eq(users.id, user.id));
    await notifyProfileChanged(user.id);
    return { ok: true };
  });

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
    if (email === user.email)
      throw badRequest('That is already your email address').as('same_email');
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken) throw conflict('Another account already uses that email').as('email_taken');
    if (app.mailer.enabled) {
      await db.transaction(async (tx) => {
        const token = await createToken(tx, user.id, 'email_change', 48 * 60, { email });
        await queueEmail(
          tx,
          email,
          verifyEmailEmail(
            localeOf(user.preferences),
            user.name,
            `${env.publicUrl}/confirm-email/${token}`,
            true,
          ),
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
        verifyEmailEmail(
          localeOf(user.preferences),
          user.name,
          `${env.publicUrl}/verify-email/${token}`,
        ),
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

  // ─── passkeys ────────────────────────────────────────────────────────

  /**
   * Adding or removing a passkey changes how the account signs in: it needs the password, or for
   * an account without one (SSO), a sign-in within the last 15 minutes.
   */
  const reauthenticate = async (
    req: FastifyRequest,
    user: typeof users.$inferSelect,
    password: string | undefined,
  ) => {
    if (user.passwordHash) return confirmPassword(user, password);
    const [session] = req.sessionId
      ? await db.select().from(sessions).where(eq(sessions.id, req.sessionId))
      : [];
    if (!session || Date.now() - new Date(session.createdAt).getTime() > 15 * 60_000)
      throw forbidden('Sign in again to change your passkeys').as('reauth_needed');
  };

  app.get('/me/passkeys', async (req): Promise<Passkey[]> => {
    const user = requireUser(req);
    return (await listPasskeys(db, user.id)).map(toPasskey);
  });

  app.post('/me/passkeys/options', async (req) => {
    const user = await loadUser(req);
    if (!relyingParty(app).usable)
      throw badRequest('Passkeys need Ordo on an https address').as('passkey_failed');
    const { password } = parse(passkeyOptionsSchema, req.body);
    await reauthenticate(req, user, password);
    return registrationOptions(app, user);
  });

  app.post('/me/passkeys', async (req): Promise<Passkey & { recoveryCodes?: string[] }> => {
    const user = await loadUser(req);
    const input = parse(addPasskeySchema, req.body);
    let codes: string[] | undefined;
    const row = await db.transaction(async (tx) => {
      const key = await addPasskey(app, tx, user.id, input);
      // A passkey asks for itself after the password from now on: hand out a way back in.
      if (!(await hasRecoveryCodes(tx, user.id)))
        codes = await regenerateRecoveryCodes(tx, user.id);
      await audit(
        tx,
        { action: 'auth.passkey_added', actorId: user.id, data: { name: key.name } },
        requestMeta(req),
      );
      await queueEmail(
        tx,
        user.email,
        securityEmail(localeOf(user.preferences), {
          notice: 'passkeyAdded',
          params: { name: key.name },
        }),
      );
      return key;
    });
    return { ...toPasskey(row), ...(codes && { recoveryCodes: codes }) };
  });

  app.patch('/me/passkeys/:id', async (req): Promise<Passkey> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { name } = parse(renamePasskeySchema, req.body);
    const [row] = await db
      .update(passkeys)
      .set({ name })
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
      .returning();
    if (!row) throw notFound('Passkey');
    return toPasskey(row);
  });

  app.delete('/me/passkeys/:id', async (req) => {
    const user = await loadUser(req);
    const { id } = req.params as { id: string };
    const { password } = parse(removePasskeySchema, req.body ?? {});
    await reauthenticate(req, user, password);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(passkeys)
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
        .returning();
      if (!row) throw notFound('Passkey');
      // The last factor gone: recovery codes would only stand in for nothing.
      if (!(await hasSecondFactor(tx, user)))
        await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
      await audit(
        tx,
        { action: 'auth.passkey_removed', actorId: user.id, data: { name: row.name } },
        requestMeta(req),
      );
      await queueEmail(
        tx,
        user.email,
        securityEmail(localeOf(user.preferences), {
          notice: 'passkeyRemoved',
          params: { name: row.name },
        }),
      );
    });
    return { ok: true };
  });

  // ─── two-factor authentication ───────────────────────────────────────

  app.post('/me/2fa/setup', async (req) => {
    const user = await loadUser(req);
    if (user.totpEnabledAt)
      throw badRequest('Two-factor authentication is already on').as('two_factor_already_on');
    const { password } = parse(passwordConfirmSchema, req.body);
    await confirmPassword(user, password);
    return beginTotp(db, app.keyring, user);
  });

  app.post('/me/2fa/enable', async (req) => {
    const user = await loadUser(req);
    const { code, revokeCredentials: revoke } = parse(enableTwoFactorSchema, req.body);
    if (user.totpEnabledAt)
      throw badRequest('Two-factor authentication is already on').as('two_factor_already_on');
    if (!verifyTotp(app.keyring, user, code))
      throw badRequest('That code is not valid. Check the time on your device.').as(
        'invalid_code_time',
      );
    const recoveryCodes = await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpEnabledAt: new Date().toISOString() })
        .where(eq(users.id, user.id));
      await audit(tx, { action: 'auth.2fa_enabled', actorId: user.id }, requestMeta(req));
      if (revoke) await revokeCredentials(tx, user.id, '2fa_enabled', requestMeta(req));
      await queueEmail(
        tx,
        user.email,
        securityEmail(localeOf(user.preferences), { notice: 'twoFactorOn' }),
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
      throw badRequest('That code is not valid').as('invalid_code');
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpEnabledAt: null, totpSecret: null })
        .where(eq(users.id, user.id));
      // With passkeys left, two-factor stays on and the recovery codes stay useful.
      const stillOn = await hasSecondFactor(tx, { id: user.id, totpEnabledAt: null });
      if (!stillOn) await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
      await audit(tx, { action: 'auth.2fa_disabled', actorId: user.id }, requestMeta(req));
      await queueEmail(
        tx,
        user.email,
        securityEmail(localeOf(user.preferences), { notice: stillOn ? 'totpOff' : 'twoFactorOff' }),
      );
    });
    return { ok: true };
  });

  app.post('/me/2fa/recovery-codes', async (req) => {
    const user = await loadUser(req);
    const { code, password } = parse(recoveryCodesSchema, req.body);
    if (user.totpEnabledAt) {
      if (!code || !verifyTotp(app.keyring, user, code))
        throw badRequest('That code is not valid').as('invalid_code');
    } else if (await hasSecondFactor(db, user)) {
      await reauthenticate(req, user, password);
    } else throw badRequest('That code is not valid').as('invalid_code');
    return { recoveryCodes: await regenerateRecoveryCodes(db, user.id) };
  });
}
