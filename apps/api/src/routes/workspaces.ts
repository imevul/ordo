import multipart from '@fastify/multipart';
import {
  type AuditEntry,
  auditQuerySchema,
  type Bootstrap,
  createFavoriteSchema,
  deleteWorkspaceSchema,
  transferOwnershipSchema,
  updateWorkspaceSchema,
} from '@ordo/shared';
import { and, asc, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  auditLog,
  favorites,
  notifications,
  teams,
  views,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { requireAdmin, requireOwner, requireUser, requireWorkspace } from '../lib/auth.ts';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../lib/errors.ts';
import { mutate, requestMeta } from '../lib/mutate.ts';
import { assertAiChangeAllowed, resolveWorkspaceAi } from '../services/ai/assist.ts';
import { audit, auditCtx, auditFilters } from '../services/audit.ts';
import { emit } from '../services/context.ts';
import { listCustomers } from '../services/customers.ts';
import { listCycles } from '../services/cycles.ts';
import { deleteFile, saveFile, signedFileUrl } from '../services/files.ts';
import { listInitiatives } from '../services/initiatives.ts';
import { workspaceBots } from '../services/integrations.ts';
import { listLabels } from '../services/labels.ts';
import { workspacePlaceholders } from '../services/placeholders.ts';
import { assertProjectLead, listProjects } from '../services/projects.ts';
import { listRecurring } from '../services/recurring.ts';
import { listRepositories } from '../services/repositories.ts';
import { toView } from '../services/serialize.ts';
import { publishChanges } from '../services/sync.ts';
import { listTeams } from '../services/teams.ts';
import { listTemplates } from '../services/templates.ts';
import {
  listFormerMembers,
  listMembers,
  memberRole,
  toWorkspace,
  workspaceSettings,
} from '../services/workspaces.ts';

/** Everything the app needs to show a workspace, as the requester may see it. */
export async function loadBootstrap(app: FastifyInstance, req: FastifyRequest): Promise<Bootstrap> {
  const { db } = app;
  const user = requireUser(req);
  const ws = requireWorkspace(req);
  const access = ws.access;
  const ai = await resolveWorkspaceAi(app, ws.id);
  const [
    workspace,
    members,
    teamList,
    labelRows,
    templates,
    projects,
    cycles,
    viewRows,
    favoriteRows,
    unread,
    bots,
    placeholders,
    formerMembers,
    repositories,
  ] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.id, ws.id)),
    listMembers(db, access),
    listTeams(db, access),
    listLabels(db, access),
    listTemplates(db, access),
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
          or(isNull(notifications.snoozedUntil), sql`${notifications.snoozedUntil} <= now()`),
        ),
      ),
    workspaceBots(db, ws.id),
    workspacePlaceholders(db, ws.id),
    listFormerMembers(db, access),
    listRepositories(db, ws.id),
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
    members: members.map(({ avatarFileId, ...m }) => ({
      ...m,
      avatarUrl: signedFileUrl(app, avatarFileId),
    })),
    bots: bots.map((b) => ({ ...b, email: '', avatarUrl: null })),
    placeholders,
    formerMembers,
    repositories,
    teams: teamList,
    labels: labelRows,
    templates,
    recurring: await listRecurring(db, access),
    customers: await listCustomers(db, access),
    initiatives: await listInitiatives(db, access, projects),
    projects,
    cycles,
    views: viewRows.map(toView),
    favorites: favoriteRows
      .filter((f) => visibleTarget(f.kind, f.targetId))
      .map((f) => ({ id: f.id, kind: f.kind, targetId: f.targetId, sortOrder: f.sortOrder })),
    unreadCount: unread[0]?.n ?? 0,
    ai: ai.settings
      ? {
          provider: ai.settings.provider,
          model: ai.settings.model,
          enabled: ai.enabled,
          source: ai.source,
        }
      : null,
  };
}

export async function workspaceRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/bootstrap', (req) => loadBootstrap(app, req));

  app.patch('/', async (req) => {
    requireAdmin(req);
    const input = parse(updateWorkspaceSchema, req.body);
    if (input.settings?.aiEnabled !== undefined || input.settings?.aiSource)
      assertAiChangeAllowed(app, {
        // Turning it on, or back to the instance's model, is always fine.
        aiEnabled: input.settings.aiEnabled,
        aiSource: input.settings.aiSource === 'instance' ? undefined : input.settings.aiSource,
      });
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
          if (!team) throw badRequest('Unknown team').as('unknown_team');
          if (team.private)
            throw badRequest('The default team must be public').as('default_team_public');
        }
        if (input.settings?.defaultAssigneeId)
          await assertProjectLead(ctx, input.settings.defaultAssigneeId, 'Default assignee');
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
      if (isUniqueViolation(err))
        throw conflict('That workspace URL is taken').as('workspace_url_taken');
      throw err;
    }
  });

  // Logo upload: multipart is only parsed in this scope.
  await app.register(async (uploads) => {
    await uploads.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    uploads.post('/logo', async (req) => {
      const ws = requireAdmin(req);
      const file = await req.file();
      if (!file) throw badRequest('No file uploaded').as('no_file');
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
      await publishChanges(app, [
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
      await publishChanges(app, [
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
      if (input.userId === ctx.userId)
        throw badRequest('You already own this workspace').as('already_owner');
      const role = await memberRole(ctx.tx, ctx.workspaceId, input.userId);
      if (!role) throw notFound('Member');
      if (role === 'guest') throw badRequest('Guests cannot own a workspace').as('guests_own');
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
    if (confirmSlug !== ws.slug)
      throw badRequest('Type the workspace URL to confirm').as('type_url_to_confirm');
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
    await publishChanges(app, [
      { kind: 'workspace', action: 'deleted', id: ws.id, workspaceId: ws.id },
    ]);
    return { ok: true };
  });

  app.get('/audit-log', async (req): Promise<AuditEntry[]> => {
    const ws = requireAdmin(req);
    const q = parse(auditQuerySchema, req.query);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), ...auditFilters(q)))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(q.limit);
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
