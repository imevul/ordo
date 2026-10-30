import {
  type AdminAuditEntry,
  adminAuditQuerySchema,
  adminSettingsSchema,
  adminUpdateUserSchema,
  createSiteInviteSchema,
  type InstanceSettings,
  type SiteInvite,
} from '@ordo/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  auditLog,
  invites,
  issues,
  jobs,
  sessions,
  users,
  workspaceDomains,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { localeForEmail, localeOf } from '../i18n/index.ts';
import { requireUser } from '../lib/auth.ts';
import { randomToken } from '../lib/crypto.ts';
import { secretAad } from '../lib/encryptedColumns.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { decryptAiKey, instanceModel } from '../services/ai/assist.ts';
import { audit, auditFilters } from '../services/audit.ts';
import { passwordResetEmail, siteInviteEmail } from '../services/mail-templates.ts';
import { encryptSmtpUrl, queueEmail } from '../services/mailer.ts';
import { publishChanges } from '../services/sync.ts';
import { createToken } from '../services/tokens.ts';

/** Enough of an API key to recognise it. */
const maskKey = (key: string) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••');

/** Masks the password in an SMTP URL for display. */
function maskSmtpUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '••••';
    return u.toString();
  } catch {
    return 'smtp://…';
  }
}

/**
 * /api/admin — the instance administrator's area: every user and workspace, instance settings,
 * background jobs and health. Guarded by users.is_instance_admin.
 */
export async function adminRoutes(app: FastifyInstance) {
  const { db } = app;

  app.addHook('preHandler', async (req) => {
    const user = requireUser(req);
    if (!user.isInstanceAdmin)
      throw forbidden('Only instance administrators can do this').as('instance_admins_only');
  });

  app.get('/overview', async () => {
    const [[u], [w], [i], size] = await Promise.all([
      db.select({ n: count() }).from(users).where(eq(users.kind, 'human')),
      db.select({ n: count() }).from(workspaces),
      db.select({ n: count() }).from(issues),
      db.execute<{ size: string }>(
        sql`select pg_size_pretty(pg_database_size(current_database())) as size`,
      ),
    ]);
    return {
      version: app.env.version,
      users: u!.n,
      workspaces: w!.n,
      issues: i!.n,
      databaseSize: size[0]?.size ?? null,
      jobs: await app.jobs.stats(),
      leases: await app.leases.list(),
      realtimeConnections: app.realtime.connectionCount,
      storage: app.storage.describe(),
      emailEnabled: app.mailer.enabled,
      secretKey: app.keyring.available,
    };
  });

  // ─── users ───────────────────────────────────────────────────────────

  app.get('/users', async (req) => {
    const { q = '', offset = '0' } = req.query as { q?: string; offset?: string };
    const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        username: users.username,
        kind: users.kind,
        isInstanceAdmin: users.isInstanceAdmin,
        canCreateWorkspaces: users.canCreateWorkspaces,
        disabledAt: users.disabledAt,
        emailVerifiedAt: users.emailVerifiedAt,
        twoFactor: sql<boolean>`(${users.totpEnabledAt} is not null or exists (select 1 from passkeys p where p.user_id = "users"."id"))`,
        createdAt: users.createdAt,
        // Spelled out: in a single-table select Drizzle leaves columns unqualified, and a bare "id"
        // inside these subqueries would bind to the subquery's own table.
        lastSeenAt: sql<
          string | null
        >`(select max(s.last_seen_at) from sessions s where s.user_id = "users"."id")`,
        workspaceCount: sql<number>`(select count(*)::int from workspace_members m where m.user_id = "users"."id")`,
      })
      .from(users)
      .where(
        q.trim()
          ? or(ilike(users.name, like), ilike(users.email, like), ilike(users.username, like))
          : undefined,
      )
      .orderBy(desc(users.createdAt))
      .limit(50)
      .offset(Math.max(0, Number(offset) || 0));
    return rows;
  });

  app.patch('/users/:id', async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    const input = parse(adminUpdateUserSchema, req.body);
    if (id === me.id && (input.disabled || input.isInstanceAdmin === false)) {
      throw badRequest("You can't disable or demote yourself — ask another instance admin");
    }
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) throw notFound('User');
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          disabledAt:
            input.disabled === undefined
              ? undefined
              : input.disabled
                ? new Date().toISOString()
                : null,
          isInstanceAdmin: input.isInstanceAdmin,
          canCreateWorkspaces: input.canCreateWorkspaces,
        })
        .where(eq(users.id, id));
      // Disabling signs them out everywhere.
      if (input.disabled) await tx.delete(sessions).where(eq(sessions.userId, id));
      await audit(
        tx,
        {
          action: 'admin.user_updated',
          actorId: me.id,
          targetType: 'user',
          targetId: id,
          data: input,
        },
        requestMeta(req),
      );
    });
    if (input.disabled !== undefined) {
      // Open sockets re-check access on member events and close for disabled accounts.
      const memberships = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, id));
      await publishChanges(
        app,
        memberships.map((m) => ({
          kind: 'member',
          action: 'updated',
          id,
          workspaceId: m.workspaceId,
          actorId: me.id,
        })),
      );
    }
    return { ok: true };
  });

  /** A password reset link for someone who can't receive email (also emailed when possible). */
  app.post('/users/:id/reset-link', async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (user?.kind !== 'human') throw notFound('User');
    const url = await db.transaction(async (tx) => {
      const token = await createToken(tx, user.id, 'password_reset', 24 * 60);
      const link = `${app.env.publicUrl}/reset-password/${token}`;
      if (app.mailer.enabled)
        await queueEmail(
          tx,
          user.email,
          passwordResetEmail(localeOf(user.preferences), user.name, link),
        );
      await audit(
        tx,
        {
          action: 'admin.user_updated',
          actorId: me.id,
          targetType: 'user',
          targetId: id,
          data: { resetLink: true },
        },
        requestMeta(req),
      );
      return link;
    });
    return { url, emailed: app.mailer.enabled };
  });

  app.delete('/users/:id', async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    if (id === me.id) throw badRequest("You can't delete yourself");
    // Refuse to orphan a workspace.
    const sole = await db.execute<{ name: string }>(sql`
      select w.name from workspaces w
      join workspace_members m on m.workspace_id = w.id and m.user_id = ${id} and m.role = 'owner'
      where not exists (select 1 from workspace_members o where o.workspace_id = w.id and o.role = 'owner' and o.user_id <> ${id})`);
    if (sole.length) {
      throw conflict(
        `They're the only owner of ${sole.map((s) => s.name).join(', ')}. Transfer ownership or delete those workspaces first.`,
      );
    }
    await db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(users)
        .where(eq(users.id, id))
        .returning({ email: users.email });
      if (!gone) throw notFound('User');
      await audit(
        tx,
        {
          action: 'admin.user_deleted',
          actorId: me.id,
          targetType: 'user',
          targetId: id,
          data: { email: gone.email },
        },
        requestMeta(req),
      );
    });
    return { ok: true };
  });

  // ─── site invites: accounts on the instance, without a workspace ────

  const inviteUrl = (token: string) => `${app.env.publicUrl}/invite/${token}`;
  const instanceName = () => new URL(app.env.publicUrl).host;
  const toSiteInvite = (
    i: typeof invites.$inferSelect & { createdByName: string | null },
  ): SiteInvite => ({
    id: i.id,
    token: i.token,
    email: i.email,
    canCreateWorkspaces: i.canCreateWorkspaces,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    lastSentAt: i.lastSentAt,
    createdByName: i.createdByName,
    url: inviteUrl(i.token),
  });

  app.get('/invites', async (): Promise<SiteInvite[]> => {
    const rows = await db
      .select({ invite: invites, createdByName: users.name })
      .from(invites)
      .leftJoin(users, eq(users.id, invites.createdBy))
      .where(
        and(
          isNull(invites.workspaceId),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date().toISOString()),
        ),
      )
      .orderBy(asc(invites.createdAt));
    return rows.map((r) => toSiteInvite({ ...r.invite, createdByName: r.createdByName }));
  });

  /** One invite per address (emailed when SMTP is set up), or a single open link without one. */
  app.post('/invites', async (req): Promise<SiteInvite[]> => {
    const me = requireUser(req);
    const input = parse(createSiteInviteSchema, req.body);
    const emails = [
      ...new Set(
        [...(input.emails ?? []), ...(input.email ? [input.email] : [])].map((e) =>
          e.toLowerCase(),
        ),
      ),
    ];
    if (emails.length) {
      const taken = await db
        .select({ email: users.email })
        .from(users)
        .where(inArray(users.email, emails));
      if (taken.length)
        throw conflict(
          `Already signed up: ${taken.map((u) => u.email).join(', ')}. Add them to a workspace instead.`,
        );
    }
    return db.transaction(async (tx) => {
      const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
      const now = new Date().toISOString();
      const rows = await tx
        .insert(invites)
        .values(
          (emails.length ? emails : [null]).map((email) => ({
            workspaceId: null,
            token: randomToken(18),
            email,
            canCreateWorkspaces: input.canCreateWorkspaces,
            createdBy: me.id,
            expiresAt,
            lastSentAt: email && app.mailer.enabled ? now : null,
          })),
        )
        .returning();
      for (const row of rows) {
        if (row.email && app.mailer.enabled) {
          await queueEmail(
            tx,
            row.email,
            siteInviteEmail(await localeForEmail(tx, row.email, me.id), {
              inviter: me.name,
              instance: instanceName(),
              url: inviteUrl(row.token),
              canCreateWorkspaces: row.canCreateWorkspaces,
            }),
          );
        }
        await audit(
          tx,
          {
            action: 'admin.invite_created',
            actorId: me.id,
            targetType: 'invite',
            targetId: row.id,
            data: { email: row.email, canCreateWorkspaces: row.canCreateWorkspaces },
          },
          requestMeta(req),
        );
      }
      return rows.map((r) => toSiteInvite({ ...r, createdByName: me.name }));
    });
  });

  app.post('/invites/:id/resend', async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    if (!app.mailer.enabled) throw badRequest("Email isn't set up on this instance");
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(invites)
        .where(and(eq(invites.id, id), isNull(invites.workspaceId), isNull(invites.acceptedAt)));
      if (!row?.email) throw notFound('Invite');
      // Resending also extends the invite.
      const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
      await tx
        .update(invites)
        .set({ lastSentAt: new Date().toISOString(), expiresAt })
        .where(eq(invites.id, id));
      await queueEmail(
        tx,
        row.email,
        siteInviteEmail(await localeForEmail(tx, row.email, me.id), {
          inviter: me.name,
          instance: instanceName(),
          url: inviteUrl(row.token),
          canCreateWorkspaces: row.canCreateWorkspaces,
        }),
      );
    });
    return { ok: true };
  });

  app.delete('/invites/:id', async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    await db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(invites)
        .where(and(eq(invites.id, id), isNull(invites.workspaceId)))
        .returning({ email: invites.email });
      if (!gone) return;
      await audit(
        tx,
        {
          action: 'admin.invite_revoked',
          actorId: me.id,
          targetType: 'invite',
          targetId: id,
          data: { email: gone.email },
        },
        requestMeta(req),
      );
    });
    return { ok: true };
  });

  // ─── workspaces ──────────────────────────────────────────────────────

  app.get('/workspaces', async () => {
    return db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        createdAt: workspaces.createdAt,
        members: sql<number>`(select count(*)::int from workspace_members m where m.workspace_id = "workspaces"."id")`,
        issues: sql<number>`(select count(*)::int from issues i where i.workspace_id = "workspaces"."id")`,
        owners: sql<
          string[]
        >`coalesce((select array_agg(u.email) from workspace_members m join users u on u.id = m.user_id where m.workspace_id = "workspaces"."id" and m.role = 'owner'), '{}')`,
      })
      .from(workspaces)
      .orderBy(desc(workspaces.createdAt));
  });

  app.delete('/workspaces/:id', async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    const { confirmSlug } = (req.body ?? {}) as { confirmSlug?: string };
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    if (!ws) throw notFound('Workspace');
    if (confirmSlug !== ws.slug)
      throw badRequest('Type the workspace URL to confirm').as('type_url_to_confirm');
    await db.transaction(async (tx) => {
      await audit(
        tx,
        {
          action: 'workspace.deleted',
          actorId: me.id,
          targetType: 'workspace',
          targetId: id,
          data: { slug: ws.slug, by: 'instance_admin' },
        },
        requestMeta(req),
      );
      await tx.delete(workspaces).where(eq(workspaces.id, id));
    });
    await publishChanges(app, [{ kind: 'workspace', action: 'deleted', id, workspaceId: id }]);
    return { ok: true };
  });

  // ─── domains ─────────────────────────────────────────────────────────

  app.get('/domains', async () => {
    return db
      .select({
        id: workspaceDomains.id,
        domain: workspaceDomains.domain,
        verified: sql<boolean>`${workspaceDomains.verifiedAt} is not null`,
        verifiedBy: workspaceDomains.verifiedBy,
        workspace: workspaces.name,
        workspaceSlug: workspaces.slug,
        createdAt: workspaceDomains.createdAt,
      })
      .from(workspaceDomains)
      .innerJoin(workspaces, eq(workspaces.id, workspaceDomains.workspaceId))
      .orderBy(workspaceDomains.domain);
  });

  /** For instances without public DNS (e.g. internal domains): an instance admin vouches instead. */
  app.post('/domains/:id/approve', async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(workspaceDomains).where(eq(workspaceDomains.id, id));
    if (!row) throw notFound('Domain');
    const [taken] = await db
      .select({ id: workspaceDomains.id })
      .from(workspaceDomains)
      .where(
        and(
          eq(workspaceDomains.domain, row.domain),
          isNotNull(workspaceDomains.verifiedAt),
          ne(workspaceDomains.id, id),
        ),
      );
    if (taken)
      throw conflict('Another workspace has already verified this domain').as(
        'domain_verified_elsewhere',
      );
    await db.transaction(async (tx) => {
      await tx
        .update(workspaceDomains)
        .set({ verifiedAt: new Date().toISOString(), verifiedBy: 'instance_admin' })
        .where(eq(workspaceDomains.id, id));
      await audit(
        tx,
        {
          action: 'domain.verified',
          workspaceId: row.workspaceId,
          actorId: me.id,
          targetType: 'domain',
          targetId: id,
          data: { domain: row.domain, by: 'instance_admin' },
        },
        requestMeta(req),
      );
    });
    return { ok: true };
  });

  // ─── settings ────────────────────────────────────────────────────────

  const describeSettings = () =>
    app.settings.describe().map((e) => {
      if (e.key === 'smtp' && e.value) {
        const smtp = e.value as NonNullable<InstanceSettings['smtp']>;
        return { ...e, value: { from: smtp.from, url: maskSmtpUrl(decryptSmtp(smtp.url)) } };
      }
      if (e.key === 'ai' && e.value) {
        const ai = e.value as NonNullable<InstanceSettings['ai']>;
        const key = decryptAiKey(app, ai.apiKey);
        return { ...e, value: { ...ai, apiKey: key ? maskKey(key) : null } };
      }
      return e;
    });
  const decryptSmtp = (url: string) =>
    url.startsWith('v1.') ? app.keyring.decrypt(url, secretAad.smtpUrl()) : url;

  app.get('/settings', async () => describeSettings());

  app.patch('/settings', async (req) => {
    const me = requireUser(req);
    const input = parse(adminSettingsSchema, req.body);
    for (const key of Object.keys(input) as (keyof typeof input)[]) {
      if (input[key] === undefined) continue;
      if (app.settings.isLocked(key))
        throw badRequest(`${key} is set by an environment variable and can't be changed here`);
    }
    if (input.signupMode !== undefined)
      await app.settings.set('signupMode', input.signupMode, me.id);
    if (input.allowWorkspaceCreation !== undefined)
      await app.settings.set('allowWorkspaceCreation', input.allowWorkspaceCreation, me.id);
    if (input.allowPrivateNetworkTargets !== undefined)
      await app.settings.set('allowPrivateNetworkTargets', input.allowPrivateNetworkTargets, me.id);
    if (input.maxAttachmentMb !== undefined)
      await app.settings.set('maxAttachmentMb', input.maxAttachmentMb, me.id);
    if (input.workspaceAi !== undefined)
      await app.settings.set('workspaceAi', input.workspaceAi, me.id);
    if (input.offlineSync !== undefined)
      await app.settings.set('offlineSync', input.offlineSync, me.id);
    if (input.smtp !== undefined) {
      if (input.smtp === null) await app.settings.set('smtp', null, me.id);
      else {
        const current = app.settings.get('smtp');
        // An empty URL keeps the stored one (the UI only ever sees it masked).
        const url = input.smtp.url ? encryptSmtpUrl(app, input.smtp.url) : current?.url;
        if (!url) throw badRequest('Enter the SMTP URL');
        if (input.smtp.url && !/^smtps?:\/\//.test(input.smtp.url))
          throw badRequest('The SMTP URL must start with smtp:// or smtps://');
        await app.settings.set('smtp', { url, from: input.smtp.from }, me.id);
      }
    }
    if (input.ai !== undefined) {
      if (input.ai === null) await app.settings.set('ai', null, me.id);
      else {
        const current = app.settings.get('ai');
        // An empty key keeps the stored one (the UI only ever sees it masked); null removes it.
        const apiKey =
          input.ai.apiKey === ''
            ? (current?.apiKey ?? null)
            : input.ai.apiKey && app.keyring.encrypt(input.ai.apiKey, secretAad.aiApiKey());
        if (input.ai.provider === 'anthropic' && !apiKey)
          throw badRequest('Enter an API key for the Claude API');
        if (input.ai.provider === 'openai' && !input.ai.baseUrl)
          throw badRequest('Enter the base URL of the OpenAI-compatible endpoint');
        await app.settings.set(
          'ai',
          {
            provider: input.ai.provider,
            model: input.ai.model,
            baseUrl: input.ai.baseUrl?.replace(/\/$/, '') ?? null,
            apiKey,
          },
          me.id,
        );
      }
    }
    await audit(
      db,
      {
        action: 'settings.updated',
        actorId: me.id,
        data: {
          ...input,
          smtp: input.smtp
            ? { from: input.smtp.from, url: input.smtp.url ? 'changed' : 'kept' }
            : input.smtp,
          ai: input.ai
            ? {
                ...input.ai,
                apiKey: input.ai.apiKey === '' ? 'kept' : input.ai.apiKey ? 'changed' : null,
              }
            : input.ai,
        },
      },
      requestMeta(req),
    );
    return describeSettings();
  });

  app.post('/settings/test-email', async (req) => {
    const { to } = (req.body ?? {}) as { to?: string };
    if (!to?.includes('@')) throw badRequest('Enter an address to send the test to');
    try {
      await app.mailer.verify();
      await app.mailer.send(to, {
        subject: 'Ordo test email',
        html: '<p style="font-family:sans-serif">Email from your Ordo instance works.</p>',
        text: 'Email from your Ordo instance works.',
      });
    } catch (err) {
      throw badRequest(`Sending failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true };
  });

  // A one-line request to the configured model, so admins see a bad key or URL right away.
  app.post(
    '/settings/test-ai',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async () => {
      const model = instanceModel(app);
      if (!model) throw badRequest('AI assistance is off').as('ai_off');
      const started = Date.now();
      const reply = await model.complete({
        system: 'You check that a connection works.',
        prompt: 'Reply with the single word: ready',
        maxTokens: 2000,
      });
      return { reply: reply.trim().slice(0, 200), ms: Date.now() - started };
    },
  );

  // ─── jobs and audit ──────────────────────────────────────────────────

  app.get('/jobs', async () => {
    return db
      .select({
        id: jobs.id,
        name: jobs.name,
        status: jobs.status,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
        runAt: jobs.runAt,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(inArray(jobs.status, ['dead', 'pending']))
      .orderBy(desc(jobs.id))
      .limit(200);
  });

  app.post('/jobs/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    await db
      .update(jobs)
      .set({ status: 'pending', attempts: 0, runAt: new Date().toISOString(), lastError: null })
      .where(eq(jobs.id, Number(id)));
    await db.execute(sql`select pg_notify('ordo_jobs', '')`);
    return { ok: true };
  });

  app.delete('/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(jobs).where(and(eq(jobs.id, Number(id)), eq(jobs.status, 'dead')));
    return { ok: true };
  });

  app.get('/audit-log', async (req): Promise<AdminAuditEntry[]> => {
    const q = parse(adminAuditQuerySchema, req.query);
    return db
      .select({
        id: auditLog.id,
        workspaceId: auditLog.workspaceId,
        workspaceName: workspaces.name,
        actorId: auditLog.actorId,
        actorName: users.name,
        actorEmail: users.email,
        actorAvatarColor: users.avatarColor,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        targetName: sql<string | null>`case "audit_log"."target_type"
          when 'user' then (select u.name from users u where u.id::text = "audit_log"."target_id")
          when 'team' then (select t.name from teams t where t.id::text = "audit_log"."target_id")
          when 'workspace' then (select w.name from workspaces w where w.id::text = "audit_log"."target_id")
        end`,
        data: auditLog.data,
        ip: auditLog.ip,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .leftJoin(workspaces, eq(workspaces.id, auditLog.workspaceId))
      .where(
        and(
          q.workspaceId
            ? eq(auditLog.workspaceId, q.workspaceId)
            : q.scope === 'all'
              ? undefined
              : isNull(auditLog.workspaceId),
          ...auditFilters(q, [users.name, users.email]),
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(q.limit);
  });
}
