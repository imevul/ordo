import { createProjectSchema, createProjectUpdateSchema, updateProjectSchema } from '@ordo/shared';
import { and, desc, eq, inArray, min } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { projects, projectTeams, projectUpdates, teams, workspaceMembers } from '../db/schema.ts';
import { requireAccess } from '../lib/auth.ts';
import { badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { assertCan, canReadTeam } from '../services/access.ts';
import { type Ctx, emit } from '../services/context.ts';
import { listProjects } from '../services/projects.ts';

async function assertTeams(ctx: Ctx, teamIds: string[]) {
  const rows = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, ctx.workspaceId), inArray(teams.id, teamIds)));
  if (rows.length !== new Set(teamIds).size || teamIds.some((t) => !canReadTeam(ctx.access, t))) {
    throw badRequest('Unknown team');
  }
}

async function assertLead(ctx: Ctx, leadId: string | null | undefined) {
  if (!leadId) return;
  const [m] = await ctx.tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, leadId)),
    );
  if (!m) throw badRequest('Lead is not a workspace member');
}

/** A project the caller can see and change: visible through one of its teams, and not a guest. */
async function loadProject(ctx: Ctx, id: string) {
  const [visible] = await listProjects(ctx.tx, ctx.access, id);
  if (!visible) throw notFound('Project');
  if (ctx.access.isGuest) throw forbidden('Guests cannot change projects');
  const [p] = await ctx.tx.select().from(projects).where(eq(projects.id, id));
  return p!;
}

export async function projectRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/projects', async (req) => listProjects(db, requireAccess(req)));

  app.get('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [project] = await listProjects(db, requireAccess(req), id);
    if (!project) throw notFound('Project');
    return project;
  });

  app.post('/projects', async (req) => {
    assertCan(requireAccess(req), 'projects.create', 'Guests cannot create projects');
    const input = parse(createProjectSchema, req.body);
    const id = await mutate(app, req, async (ctx) => {
      await assertTeams(ctx, input.teamIds);
      await assertLead(ctx, input.leadId);
      const [{ first }] = (await ctx.tx
        .select({ first: min(projects.sortOrder) })
        .from(projects)
        .where(eq(projects.workspaceId, ctx.workspaceId))) as [{ first: number | null }];
      const { teamIds, ...rest } = input;
      const [row] = await ctx.tx
        .insert(projects)
        .values({
          ...rest,
          workspaceId: ctx.workspaceId,
          createdBy: ctx.userId,
          sortOrder: (first ?? 0) - 1024,
        })
        .returning({ id: projects.id });
      await ctx.tx
        .insert(projectTeams)
        .values(teamIds.map((teamId) => ({ projectId: row!.id, teamId })));
      emit(ctx, { kind: 'project', action: 'created', id: row!.id });
      return row!.id;
    });
    return (await listProjects(db, requireAccess(req), id))[0];
  });

  app.patch('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateProjectSchema, req.body);
    await mutate(app, req, async (ctx) => {
      await loadProject(ctx, id);
      await assertLead(ctx, input.leadId);
      const { teamIds, ...rest } = input;
      if (teamIds) {
        await assertTeams(ctx, teamIds);
        await ctx.tx.delete(projectTeams).where(eq(projectTeams.projectId, id));
        await ctx.tx
          .insert(projectTeams)
          .values(teamIds.map((teamId) => ({ projectId: id, teamId })));
      }
      await ctx.tx
        .update(projects)
        .set({ ...rest, updatedAt: new Date().toISOString() })
        .where(eq(projects.id, id));
      emit(ctx, { kind: 'project', action: 'updated', id });
    });
    return (await listProjects(db, requireAccess(req), id))[0];
  });

  app.delete('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await loadProject(ctx, id);
      // Issues keep existing; their project is cleared by the FK's ON DELETE SET NULL.
      await ctx.tx.delete(projects).where(eq(projects.id, id));
      emit(ctx, { kind: 'project', action: 'deleted', id });
      emit(ctx, { kind: 'issue', action: 'updated', id });
      return { ok: true };
    });
  });

  app.get('/projects/:id/updates', async (req) => {
    const { id } = req.params as { id: string };
    const [p] = await listProjects(db, requireAccess(req), id);
    if (!p) throw notFound('Project');
    return db
      .select()
      .from(projectUpdates)
      .where(eq(projectUpdates.projectId, id))
      .orderBy(desc(projectUpdates.createdAt));
  });

  app.post('/projects/:id/updates', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createProjectUpdateSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await loadProject(ctx, id);
      const [row] = await ctx.tx
        .insert(projectUpdates)
        .values({ projectId: id, authorId: ctx.userId, body: input.body, health: input.health })
        .returning();
      emit(ctx, { kind: 'projectUpdate', action: 'created', id: row!.id });
      emit(ctx, { kind: 'project', action: 'updated', id });
      return row;
    });
  });

  app.delete('/project-updates/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .select({ update: projectUpdates, workspaceId: projects.workspaceId })
        .from(projectUpdates)
        .innerJoin(projects, eq(projects.id, projectUpdates.projectId))
        .where(eq(projectUpdates.id, id));
      if (!row || row.workspaceId !== ctx.workspaceId) throw notFound('Project update');
      const [visible] = await listProjects(ctx.tx, ctx.access, row.update.projectId);
      if (!visible) throw notFound('Project update');
      if (row.update.authorId !== ctx.userId && !ctx.access.isAdmin) throw forbidden();
      await ctx.tx.delete(projectUpdates).where(eq(projectUpdates.id, id));
      emit(ctx, { kind: 'projectUpdate', action: 'deleted', id });
      emit(ctx, { kind: 'project', action: 'updated', id: row.update.projectId });
      return { ok: true };
    });
  });
}
