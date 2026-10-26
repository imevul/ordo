import {
  type AuditEntry,
  type Bootstrap,
  createFavoriteSchema,
  createInviteSchema,
  type Invite,
  updateMemberSchema,
  updateWorkspaceSchema,
} from '@ordo/shared';
import { and, asc, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  auditLog,
  favorites,
  invites,
  labels,
  notifications,
  users,
  views,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { requireAdmin, requireUser, requireWorkspace } from '../lib/auth.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, isUniqueViolation, parse } from '../lib/errors.ts';
import { mutate, requestMeta } from '../lib/mutate.ts';
import { audit, auditCtx } from '../services/audit.ts';
import { emit } from '../services/context.ts';
import { listCycles } from '../services/cycles.ts';
import { listProjects } from '../services/projects.ts';
import { toLabel, toView } from '../services/serialize.ts';
import { listTeams } from '../services/teams.ts';

export async function workspaceRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/bootstrap', async (req): Promise<Bootstrap> => {
    const user = requireUser(req);
    const ws = requireWorkspace(req);
    const [workspace, members, teams, labelRows, projects, cycles, viewRows, favoriteRows, unread] =
      await Promise.all([
        db.select().from(workspaces).where(eq(workspaces.id, ws.id)),
        db
          .select({
            id: users.id,
            name: users.name,
            username: users.username,
            email: users.email,
            avatarColor: users.avatarColor,
            role: workspaceMembers.role,
            joinedAt: workspaceMembers.joinedAt,
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(eq(workspaceMembers.workspaceId, ws.id))
          .orderBy(asc(users.name)),
        listTeams(db, ws.id),
        db.select().from(labels).where(eq(labels.workspaceId, ws.id)).orderBy(asc(labels.name)),
        listProjects(db, ws.id),
        listCycles(db, ws.id),
        db
          .select()
          .from(views)
          .where(
            and(
              eq(views.workspaceId, ws.id),
              or(eq(views.shared, true), eq(views.ownerId, user.id)),
            ),
          )
          .orderBy(asc(views.name)),
        db
          .select()
          .from(favorites)
          .where(and(eq(favorites.workspaceId, ws.id), eq(favorites.userId, user.id)))
          .orderBy(asc(favorites.sortOrder)),
        db
          .select({ n: count() })
          .from(notifications)
          .where(
            and(
              eq(notifications.workspaceId, ws.id),
              eq(notifications.userId, user.id),
              isNull(notifications.readAt),
            ),
          ),
      ]);
    return {
      workspace: workspace[0]!,
      role: ws.role,
      members,
      teams,
      labels: labelRows.map(toLabel),
      projects,
      cycles,
      views: viewRows.map(toView),
      favorites: favoriteRows.map((f) => ({
        id: f.id,
        kind: f.kind,
        targetId: f.targetId,
        sortOrder: f.sortOrder,
      })),
      unreadCount: unread[0]?.n ?? 0,
    };
  });

  app.patch('/', async (req) => {
    requireAdmin(req);
    const input = parse(updateWorkspaceSchema, req.body);
    try {
      return await mutate(app, req, async (ctx) => {
        const [ws] = await ctx.tx
          .update(workspaces)
          .set(input)
          .where(eq(workspaces.id, ctx.workspaceId))
          .returning();
        emit(ctx, { kind: 'workspace', action: 'updated', id: ctx.workspaceId });
        await auditCtx(ctx, {
          action: 'workspace.updated',
          targetType: 'workspace',
          targetId: ctx.workspaceId,
          data: input,
        });
        return ws;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That workspace URL is taken');
      throw err;
    }
  });

  app.patch('/members/:userId', async (req) => {
    requireAdmin(req);
    const { userId } = req.params as { userId: string };
    const { role } = parse(updateMemberSchema, req.body);
    return mutate(app, req, async (ctx) => {
      if (role !== 'admin') await assertNotLastAdmin(ctx.tx, ctx.workspaceId, userId);
      await ctx.tx
        .update(workspaceMembers)
        .set({ role })
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
      emit(ctx, { kind: 'member', action: 'updated', id: userId });
      await auditCtx(ctx, {
        action: 'member.role_changed',
        targetType: 'user',
        targetId: userId,
        data: { role },
      });
      return { ok: true };
    });
  });

  app.delete('/members/:userId', async (req) => {
    const user = requireUser(req);
    const ws = requireWorkspace(req);
    const { userId } = req.params as { userId: string };
    if (userId !== user.id && ws.role !== 'admin')
      throw forbidden('Only admins can remove members');
    return mutate(app, req, async (ctx) => {
      await assertNotLastAdmin(ctx.tx, ctx.workspaceId, userId);
      await ctx.tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
      emit(ctx, { kind: 'member', action: 'deleted', id: userId });
      await auditCtx(ctx, {
        action: 'member.removed',
        targetType: 'user',
        targetId: userId,
        data: { self: userId === user.id },
      });
      return { ok: true };
    });
  });

  const toInvite = (i: typeof invites.$inferSelect): Invite => ({
    id: i.id,
    token: i.token,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    url: `${app.env.publicUrl}/invite/${i.token}`,
  });

  app.get('/invites', async (req) => {
    const ws = requireAdmin(req);
    const rows = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, ws.id),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date().toISOString()),
        ),
      )
      .orderBy(asc(invites.createdAt));
    return rows.map(toInvite);
  });

  app.post('/invites', async (req) => {
    const ws = requireAdmin(req);
    const user = requireUser(req);
    const input = parse(createInviteSchema, req.body);
    const [row] = await db
      .insert(invites)
      .values({
        workspaceId: ws.id,
        token: randomToken(18),
        email: input.email?.toLowerCase() ?? null,
        role: input.role,
        createdBy: user.id,
        expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
      })
      .returning();
    await audit(
      db,
      {
        action: 'invite.created',
        workspaceId: ws.id,
        actorId: user.id,
        targetType: 'invite',
        targetId: row!.id,
        data: { email: row!.email, role: row!.role },
      },
      requestMeta(req),
    );
    return toInvite(row!);
  });

  app.delete('/invites/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const [removed] = await db
      .delete(invites)
      .where(and(eq(invites.id, id), eq(invites.workspaceId, ws.id)))
      .returning({ id: invites.id });
    if (removed) {
      await audit(
        db,
        {
          action: 'invite.revoked',
          workspaceId: ws.id,
          actorId: req.user!.id,
          targetType: 'invite',
          targetId: id,
        },
        requestMeta(req),
      );
    }
    return { ok: true };
  });

  app.get('/audit-log', async (req): Promise<AuditEntry[]> => {
    const ws = requireAdmin(req);
    const { before, limit } = req.query as { before?: string; limit?: string };
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.workspaceId, ws.id), before ? lt(auditLog.createdAt, before) : undefined),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(Number(limit) || 100, 500));
    return rows.map(({ userAgent: _ua, ...r }) => r);
  });

  app.post('/favorites', async (req) => {
    const input = parse(createFavoriteSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .insert(favorites)
        .values({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          kind: input.kind,
          targetId: input.targetId,
          sortOrder: Date.now(),
        })
        .onConflictDoNothing()
        .returning({ id: favorites.id });
      if (row) emit(ctx, { kind: 'favorite', action: 'created', id: row.id, userId: ctx.userId });
      return { ok: true };
    });
  });

  app.delete('/favorites/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await ctx.tx
        .delete(favorites)
        .where(and(eq(favorites.id, id), eq(favorites.userId, ctx.userId)));
      emit(ctx, { kind: 'favorite', action: 'deleted', id, userId: ctx.userId });
      return { ok: true };
    });
  });
}

async function assertNotLastAdmin(tx: DbOrTx, workspaceId: string, userId: string) {
  const admins = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'admin')));
  if (admins.length === 1 && admins[0]!.userId === userId)
    throw badRequest('A workspace needs at least one admin');
}
