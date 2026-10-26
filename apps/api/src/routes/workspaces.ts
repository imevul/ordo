import multipart from '@fastify/multipart';
import {
  type AuditEntry,
  type Bootstrap,
  createFavoriteSchema,
  deleteWorkspaceSchema,
  transferOwnershipSchema,
  updateWorkspaceSchema,
} from '@ordo/shared';
import { and, asc, count, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  auditLog,
  favorites,
  labels,
  notifications,
  teams,
  users,
  views,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { requireAdmin, requireOwner, requireUser, requireWorkspace } from '../lib/auth.ts';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../lib/errors.ts';
import { mutate, requestMeta } from '../lib/mutate.ts';
import { teamScope } from '../services/access.ts';
import { audit, auditCtx } from '../services/audit.ts';
import { emit } from '../services/context.ts';
import { listCycles } from '../services/cycles.ts';
import { deleteFile, saveFile, signedFileUrl } from '../services/files.ts';
import { workspaceBots } from '../services/integrations.ts';
import { workspacePlaceholders } from '../services/placeholders.ts';
import { listProjects } from '../services/projects.ts';
import { toLabel, toView } from '../services/serialize.ts';
import { listTeams } from '../services/teams.ts';
import { memberRole, toWorkspace, workspaceSettings } from '../services/workspaces.ts';

export async function workspaceRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/bootstrap', async (req): Promise<Bootstrap> => {
    const user = requireUser(req);
    const ws = requireWorkspace(req);
    const access = ws.access;
    const [
      workspace,
      members,
      teamList,
      labelRows,
      projects,
      cycles,
      viewRows,
      favoriteRows,
      unread,
      bots,
      placeholders,
    ] = await Promise.all([
      db.select().from(workspaces).where(eq(workspaces.id, ws.id)),
      db
        .select({
          id: users.id,
          name: users.name,
          username: users.username,
          email: users.email,
          avatarColor: users.avatarColor,
          avatarFileId: users.avatarFileId,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
          suspendedAt: workspaceMembers.suspendedAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, ws.id))
        .orderBy(asc(users.name)),
      listTeams(db, access),
      // Workspace labels, plus labels of teams the viewer can read.
      db
        .select()
        .from(labels)
        .where(
          and(
            eq(labels.workspaceId, ws.id),
            access.isAdmin
              ? undefined
              : or(isNull(labels.teamId), teamScope(access, labels.teamId)),
          ),
        )
        .orderBy(asc(labels.name)),
      listProjects(db, access),
      listCycles(db, access),
      db
        .select()
        .from(views)
        .where(
          and(eq(views.workspaceId, ws.id), or(eq(views.shared, true), eq(views.ownerId, user.id))),
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
      workspaceBots(db, ws.id),
      workspacePlaceholders(db, ws.id),
    ]);
    // Favorites only for things still visible.
    const visibleTarget = (kind: string, id: string) =>
      kind === 'project'
        ? projects.some((p) => p.id === id)
        : kind === 'team'
          ? teamList.some((t) => t.id === id)
          : kind === 'view'
            ? viewRows.some((v) => v.id === id)
            : true;
    return {
      workspace: toWorkspace(app, workspace[0]!),
      role: ws.role,
      members: members.map(({ avatarFileId, suspendedAt, ...m }) => ({
        ...m,
        avatarUrl: signedFileUrl(app, avatarFileId),
        suspended: !!suspendedAt,
        // Guests don't see other people's email addresses.
        email: access.isGuest && m.id !== user.id ? '' : m.email,
      })),
      bots: bots.map((b) => ({ ...b, email: '', avatarUrl: null })),
      placeholders,
      teams: teamList,
      labels: labelRows.map(toLabel),
      projects,
      cycles,
      views: viewRows.map(toView),
      favorites: favoriteRows
        .filter((f) => visibleTarget(f.kind, f.targetId))
        .map((f) => ({ id: f.id, kind: f.kind, targetId: f.targetId, sortOrder: f.sortOrder })),
      unreadCount: unread[0]?.n ?? 0,
    };
  });

  app.patch('/', async (req) => {
    requireAdmin(req);
    const input = parse(updateWorkspaceSchema, req.body);
    try {
      return await mutate(app, req, async (ctx) => {
        const [current] = await ctx.tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, ctx.workspaceId));
        if (input.defaultTeamId) {
          const [team] = await ctx.tx
            .select({ id: teams.id, private: teams.private })
            .from(teams)
            .where(and(eq(teams.id, input.defaultTeamId), eq(teams.workspaceId, ctx.workspaceId)));
          if (!team) throw badRequest('Unknown team');
          if (team.private) throw badRequest('The default team must be public');
        }
        const [row] = await ctx.tx
          .update(workspaces)
          .set({
            name: input.name,
            slug: input.slug,
            defaultTeamId: input.defaultTeamId,
            settings: input.settings
              ? { ...workspaceSettings(current!), ...input.settings }
              : undefined,
          })
          .where(eq(workspaces.id, ctx.workspaceId))
          .returning();
        emit(ctx, { kind: 'workspace', action: 'updated', id: ctx.workspaceId });
        await auditCtx(ctx, {
          action: 'workspace.updated',
          targetType: 'workspace',
          targetId: ctx.workspaceId,
          data: input,
        });
        return toWorkspace(app, row!);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That workspace URL is taken');
      throw err;
    }
  });

  // Logo upload: multipart is only parsed in this scope.
  await app.register(async (uploads) => {
    await uploads.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    uploads.post('/logo', async (req) => {
      const ws = requireAdmin(req);
      const file = await req.file();
      if (!file) throw badRequest('No file uploaded');
      const saved = await saveFile(app, {
        workspaceId: ws.id,
        ownerId: requireUser(req).id,
        kind: 'logo',
        filename: file.filename,
        body: await file.toBuffer(),
        imagesOnly: true,
      });
      const [before] = await db
        .select({ logo: workspaces.logoFileId })
        .from(workspaces)
        .where(eq(workspaces.id, ws.id));
      await db.update(workspaces).set({ logoFileId: saved.id }).where(eq(workspaces.id, ws.id));
      if (before?.logo) await deleteFile(app, before.logo);
      app.realtime.publish([
        { kind: 'workspace', action: 'updated', id: ws.id, workspaceId: ws.id },
      ]);
      return { logoUrl: signedFileUrl(app, saved.id) };
    });
  });

  app.delete('/logo', async (req) => {
    const ws = requireAdmin(req);
    const [before] = await db
      .select({ logo: workspaces.logoFileId })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id));
    if (before?.logo) {
      await db.update(workspaces).set({ logoFileId: null }).where(eq(workspaces.id, ws.id));
      await deleteFile(app, before.logo);
      app.realtime.publish([
        { kind: 'workspace', action: 'updated', id: ws.id, workspaceId: ws.id },
      ]);
    }
    return { ok: true };
  });

  /** Owners hand ownership to another member, and by default step down to admin. */
  app.post('/transfer-ownership', async (req) => {
    requireOwner(req);
    const input = parse(transferOwnershipSchema, req.body);
    return mutate(app, req, async (ctx) => {
      if (input.userId === ctx.userId) throw badRequest('You already own this workspace');
      const role = await memberRole(ctx.tx, ctx.workspaceId, input.userId);
      if (!role) throw notFound('Member');
      if (role === 'guest') throw badRequest('Guests cannot own a workspace');
      const member = (userId: string) =>
        and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId));
      await ctx.tx
        .update(workspaceMembers)
        .set({ role: 'owner', suspendedAt: null })
        .where(member(input.userId));
      if (input.stepDown)
        await ctx.tx.update(workspaceMembers).set({ role: 'admin' }).where(member(ctx.userId));
      for (const id of [input.userId, ctx.userId])
        emit(ctx, { kind: 'member', action: 'updated', id });
      await auditCtx(ctx, {
        action: 'member.role_changed',
        targetType: 'user',
        targetId: input.userId,
        data: { role: 'owner', transferredFrom: ctx.userId, stepDown: input.stepDown },
      });
      return { ok: true };
    });
  });

  /** Deletes the workspace and everything in it. Owners only, confirmed by typing the URL slug. */
  app.delete('/', async (req) => {
    const ws = requireOwner(req);
    const { confirmSlug } = parse(deleteWorkspaceSchema, req.body ?? {});
    if (confirmSlug !== ws.slug) throw badRequest('Type the workspace URL to confirm');
    await db.transaction(async (tx) => {
      await audit(
        tx,
        {
          action: 'workspace.deleted',
          actorId: requireUser(req).id,
          targetType: 'workspace',
          targetId: ws.id,
          data: { slug: ws.slug, name: ws.name },
        },
        requestMeta(req),
      );
      await tx.delete(workspaces).where(eq(workspaces.id, ws.id));
    });
    app.realtime.publish([{ kind: 'workspace', action: 'deleted', id: ws.id, workspaceId: ws.id }]);
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
