import { randomBytes } from 'node:crypto';
import {
  addDomainSchema,
  createInviteSchema,
  type Invite,
  isAdminRole,
  isOwnerRole,
  updateMemberSchema,
  type WorkspaceDomain,
} from '@ordo/shared';
import { and, asc, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { invites, workspaceDomains, workspaces } from '../db/schema.ts';
import { localeForEmail } from '../i18n/index.ts';
import { requireAdmin, requireUser, requireWorkspace } from '../lib/auth.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { inviteUrl, newInviteToken, revealInviteToken } from '../lib/invites.ts';
import { mutate } from '../lib/mutate.ts';
import { auditCtx } from '../services/audit.ts';
import { inviteEmail } from '../services/mail-templates.ts';
import { queueEmail } from '../services/mailer.ts';
import { removeMember, setMemberRole, setSuspended } from '../services/members.ts';
import { memberRole, workspaceSettings } from '../services/workspaces.ts';

export async function memberRoutes(app: FastifyInstance) {
  const { db } = app;

  /**
   * Admins manage roles and suspensions. Only owners can touch owners — granting ownership,
   * demoting or suspending an owner — and the last owner can't lose ownership.
   */
  app.patch('/members/:userId', async (req) => {
    const ws = requireAdmin(req);
    const { userId } = req.params as { userId: string };
    const input = parse(updateMemberSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const current = await memberRole(ctx.tx, ctx.workspaceId, userId);
      if (!current) throw notFound('Member');
      const touchesOwner = isOwnerRole(input.role) || isOwnerRole(current);
      if (touchesOwner && !ws.access.isOwner)
        throw forbidden('Only owners can grant or change ownership').as('owners_grant');
      if (userId === ctx.userId && input.suspended) throw badRequest("You can't suspend yourself");
      if (input.role) await setMemberRole(ctx, userId, input.role);
      if (input.suspended !== undefined) await setSuspended(ctx, userId, input.suspended);
      return { ok: true };
    });
  });

  app.delete('/members/:userId', async (req) => {
    const user = requireUser(req);
    const ws = requireWorkspace(req);
    const { userId } = req.params as { userId: string };
    if (userId !== user.id && !ws.access.isAdmin)
      throw forbidden('Only admins can remove members').as('admins_remove_members');
    return mutate(app, req, async (ctx) => {
      const current = await memberRole(ctx.tx, ctx.workspaceId, userId);
      if (!current) throw notFound('Member');
      if (isOwnerRole(current)) {
        if (userId !== user.id && !ws.access.isOwner)
          throw forbidden('Only owners can remove an owner').as('owners_remove_owner');
      }
      await removeMember(ctx, userId);
      return { ok: true };
    });
  });

  // ─── invites ─────────────────────────────────────────────────────────

  /** `token` is passed when it was just made; stored ones are decrypted when the key allows. */
  const toInvite = (i: typeof invites.$inferSelect, token = revealInviteToken(app, i)): Invite => ({
    id: i.id,
    token,
    email: i.email,
    role: i.role,
    teamIds: i.teamIds,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    lastSentAt: i.lastSentAt,
    url: token ? inviteUrl(app, token) : null,
  });

  /** Admins can always invite; members only when the workspace allows it, and never as admins. */
  async function assertCanInvite(req: FastifyRequest, role: string) {
    const ws = requireWorkspace(req);
    if (ws.access.isAdmin) return ws;
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    if (ws.access.isGuest || workspaceSettings(row!).invitePolicy !== 'members') {
      throw forbidden('Only workspace admins can invite people').as('admins_invite');
    }
    if (isAdminRole(role))
      throw forbidden('Only admins can invite admins').as('admins_invite_admins');
    return ws;
  }

  app.get('/invites', async (req) => {
    const ws = requireWorkspace(req);
    const settings = workspaceSettings(
      (await db.select().from(workspaces).where(eq(workspaces.id, ws.id)))[0]!,
    );
    if (!ws.access.isAdmin && (ws.access.isGuest || settings.invitePolicy !== 'members'))
      throw forbidden();
    const rows = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, ws.id),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date().toISOString()),
          // Members see the invites they created.
          ws.access.isAdmin ? undefined : eq(invites.createdBy, ws.access.userId),
        ),
      )
      .orderBy(asc(invites.createdAt));
    return rows.map((row) => toInvite(row));
  });

  /**
   * Creates one invite per email address (emailed when SMTP is set up), or a single open link when
   * no address is given. Invitees join the chosen teams on accepting.
   */
  app.post('/invites', async (req) => {
    const input = parse(createInviteSchema, req.body);
    const ws = await assertCanInvite(req, input.role);
    const inviter = requireUser(req);
    const emails = [
      ...new Set(
        [...(input.emails ?? []), ...(input.email ? [input.email] : [])].map((e) =>
          e.toLowerCase(),
        ),
      ),
    ];
    return mutate(app, req, async (ctx) => {
      for (const teamId of input.teamIds) {
        if (!ctx.access.teamIds.includes(teamId) && !ctx.access.isAdmin)
          throw badRequest('Unknown team').as('unknown_team');
      }
      const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
      const now = new Date().toISOString();
      const tokens = new Map<string, string>();
      const rows = await ctx.tx
        .insert(invites)
        .values(
          (emails.length ? emails : [null]).map((email) => {
            const { token, columns } = newInviteToken(app);
            tokens.set(columns.id, token);
            return {
              ...columns,
              workspaceId: ws.id,
              email,
              role: input.role,
              teamIds: input.teamIds,
              createdBy: inviter.id,
              expiresAt,
              lastSentAt: email && app.mailer.enabled ? now : null,
            };
          }),
        )
        .returning();
      for (const row of rows) {
        if (row.email && app.mailer.enabled) {
          await queueEmail(
            ctx.tx,
            row.email,
            inviteEmail(await localeForEmail(ctx.tx, row.email, inviter.id), {
              inviter: inviter.name,
              workspace: ws.name,
              role: row.role,
              url: inviteUrl(app, tokens.get(row.id)!),
            }),
          );
        }
        await auditCtx(ctx, {
          action: 'invite.created',
          targetType: 'invite',
          targetId: row.id,
          data: { email: row.email, role: row.role, teamIds: row.teamIds },
        });
      }
      return rows.map((row) => toInvite(row, tokens.get(row.id)));
    });
  });

  app.post('/invites/:id/resend', async (req) => {
    const ws = requireWorkspace(req);
    const { id } = req.params as { id: string };
    if (!app.mailer.enabled) throw badRequest("Email isn't set up on this instance");
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .select()
        .from(invites)
        .where(and(eq(invites.id, id), eq(invites.workspaceId, ws.id), isNull(invites.acceptedAt)));
      if (!row?.email) throw notFound('Invite');
      if (!ws.access.isAdmin && row.createdBy !== ctx.userId) throw forbidden();
      // Resending also extends the invite. A link that can't be decrypted gets a new token.
      const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
      let token = revealInviteToken(app, row);
      const fresh = token ? null : newInviteToken(app, id);
      token ??= fresh!.token;
      await ctx.tx
        .update(invites)
        .set({ lastSentAt: new Date().toISOString(), expiresAt, ...fresh?.columns })
        .where(eq(invites.id, id));
      const inviter = requireUser(req);
      await queueEmail(
        ctx.tx,
        row.email,
        inviteEmail(await localeForEmail(ctx.tx, row.email, inviter.id), {
          inviter: inviter.name,
          workspace: ws.name,
          role: row.role,
          url: inviteUrl(app, token),
        }),
      );
      return { ok: true };
    });
  });

  app.delete('/invites/:id', async (req) => {
    const ws = requireWorkspace(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .select()
        .from(invites)
        .where(and(eq(invites.id, id), eq(invites.workspaceId, ws.id)));
      if (!row) return { ok: true };
      if (!ws.access.isAdmin && row.createdBy !== ctx.userId) throw forbidden();
      await ctx.tx.delete(invites).where(eq(invites.id, id));
      await auditCtx(ctx, { action: 'invite.revoked', targetType: 'invite', targetId: id });
      return { ok: true };
    });
  });

  // ─── domains ─────────────────────────────────────────────────────────

  const toDomain = (d: typeof workspaceDomains.$inferSelect): WorkspaceDomain => ({
    id: d.id,
    domain: d.domain,
    verificationToken: d.verificationToken,
    verified: !!d.verifiedAt,
    verifiedBy: d.verifiedBy,
    createdAt: d.createdAt,
  });

  app.get('/domains', async (req) => {
    const ws = requireAdmin(req);
    const rows = await db
      .select()
      .from(workspaceDomains)
      .where(eq(workspaceDomains.workspaceId, ws.id))
      .orderBy(asc(workspaceDomains.domain));
    return rows.map(toDomain);
  });

  app.post('/domains', async (req) => {
    const ws = requireAdmin(req);
    const { domain } = parse(addDomainSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .insert(workspaceDomains)
        .values({ workspaceId: ws.id, domain, verificationToken: randomBytes(16).toString('hex') })
        .onConflictDoNothing()
        .returning();
      if (!row) throw conflict('That domain is already added').as('domain_added');
      await auditCtx(ctx, {
        action: 'domain.added',
        targetType: 'domain',
        targetId: row.id,
        data: { domain },
      });
      return toDomain(row);
    });
  });

  /** Checks the `_ordo-verify.<domain>` TXT record. A domain can be verified by one workspace only. */
  app.post('/domains/:id/verify', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(workspaceDomains)
      .where(and(eq(workspaceDomains.id, id), eq(workspaceDomains.workspaceId, ws.id)));
    if (!row) throw notFound('Domain');
    if (row.verifiedAt) return toDomain(row);
    const records = await app
      .resolveTxt(`_ordo-verify.${row.domain}`)
      .catch(() => [] as string[][]);
    const expected = `ordo-verify=${row.verificationToken}`;
    if (!records.some((parts) => parts.join('') === expected)) {
      throw badRequest(
        `No TXT record "${expected}" found at _ordo-verify.${row.domain} yet. DNS changes can take a while.`,
      );
    }
    return mutate(app, req, async (ctx) => {
      const [taken] = await ctx.tx
        .select({ id: workspaceDomains.id })
        .from(workspaceDomains)
        .where(
          and(
            eq(workspaceDomains.domain, row.domain),
            isNotNull(workspaceDomains.verifiedAt),
            ne(workspaceDomains.id, row.id),
          ),
        );
      if (taken)
        throw conflict('Another workspace has already verified this domain').as(
          'domain_verified_elsewhere',
        );
      const [updated] = await ctx.tx
        .update(workspaceDomains)
        .set({ verifiedAt: new Date().toISOString(), verifiedBy: 'dns' })
        .where(eq(workspaceDomains.id, row.id))
        .returning();
      await auditCtx(ctx, {
        action: 'domain.verified',
        targetType: 'domain',
        targetId: row.id,
        data: { domain: row.domain, by: 'dns' },
      });
      return toDomain(updated!);
    });
  });

  app.delete('/domains/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .delete(workspaceDomains)
        .where(and(eq(workspaceDomains.id, id), eq(workspaceDomains.workspaceId, ws.id)))
        .returning();
      if (row)
        await auditCtx(ctx, {
          action: 'domain.removed',
          targetType: 'domain',
          targetId: id,
          data: { domain: row.domain },
        });
      return { ok: true };
    });
  });
}
