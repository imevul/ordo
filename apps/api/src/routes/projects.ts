import {
  createMilestoneSchema,
  createProjectSchema,
  createProjectUpdateSchema,
  updateMilestoneSchema,
  updateProjectSchema,
} from '@ordo/shared';
import { desc, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { projectMilestones, projects, projectTeams, projectUpdates } from '../db/schema.ts';
import { requireAccess } from '../lib/auth.ts';
import { forbidden, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { assertCan } from '../services/access.ts';
import { type Ctx, emit, record } from '../services/context.ts';
import {
  assertProjectLead,
  assertProjectTeams,
  createProject,
  listProjects,
} from '../services/projects.ts';

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
    const id = await mutate(app, req, (ctx) => createProject(ctx, input));
    return (await listProjects(db, requireAccess(req), id))[0];
  });

  app.patch('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateProjectSchema, req.body);
    await mutate(app, req, async (ctx) => {
      await loadProject(ctx, id);
      await assertProjectLead(ctx, input.leadId);
      const { teamIds, ...rest } = input;
      if (teamIds) {
        await assertProjectTeams(ctx, teamIds);
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
      const [project] = await listProjects(ctx.tx, ctx.access, id);
      record(ctx, 'project.updated', project!, { teamIds: project!.teamIds });
    });
    return (await listProjects(db, requireAccess(req), id))[0];
  });

  app.delete('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await loadProject(ctx, id);
      const [before] = await listProjects(ctx.tx, ctx.access, id);
      record(ctx, 'project.deleted', { id, name: before?.name }, { teamIds: before?.teamIds });
      // Issues keep existing; their project is cleared by the FK's ON DELETE SET NULL.
      await ctx.tx.delete(projects).where(eq(projects.id, id));
      emit(ctx, { kind: 'project', action: 'deleted', id });
      emit(ctx, { kind: 'issue', action: 'updated', id });
      return { ok: true };
    });
  });

  // ─── milestones ───────────────────────────────────────────────────────
  // Part of the project: changes come back as the project (and reach webhooks as project.updated).

  const projectChanged = async (ctx: Ctx, projectId: string) => {
    emit(ctx, { kind: 'project', action: 'updated', id: projectId });
    const [project] = await listProjects(ctx.tx, ctx.access, projectId);
    record(ctx, 'project.updated', project!, { teamIds: project!.teamIds });
    return project!;
  };

  const loadMilestone = async (ctx: Ctx, id: string) => {
    const [m] = await ctx.tx.select().from(projectMilestones).where(eq(projectMilestones.id, id));
    if (!m) throw notFound('Milestone');
    await loadProject(ctx, m.projectId);
    return m;
  };

  app.post('/projects/:id/milestones', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createMilestoneSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await loadProject(ctx, id);
      const [{ last }] = (await ctx.tx
        .select({ last: max(projectMilestones.sortOrder) })
        .from(projectMilestones)
        .where(eq(projectMilestones.projectId, id))) as [{ last: number | null }];
      await ctx.tx
        .insert(projectMilestones)
        .values({ ...input, projectId: id, sortOrder: (last ?? 0) + 1024 });
      return projectChanged(ctx, id);
    });
  });

  app.patch('/milestones/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateMilestoneSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const m = await loadMilestone(ctx, id);
      await ctx.tx.update(projectMilestones).set(input).where(eq(projectMilestones.id, id));
      return projectChanged(ctx, m.projectId);
    });
  });

  app.delete('/milestones/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const m = await loadMilestone(ctx, id);
      // Its issues stay in the project; the FK clears their milestone.
      await ctx.tx.delete(projectMilestones).where(eq(projectMilestones.id, id));
      emit(ctx, { kind: 'issue', action: 'updated', id });
      return projectChanged(ctx, m.projectId);
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
      const [project] = await listProjects(ctx.tx, ctx.access, id);
      record(
        ctx,
        'project_update.created',
        { update: row!, project: { id, name: project?.name } },
        { teamIds: project?.teamIds },
      );
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
