import {
  createStateSchema,
  createTeamSchema,
  SORT_GAP,
  updateStateSchema,
  updateTeamSchema,
} from '@ordo/shared';
import { and, count, eq, max, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { issues, teamMembers, teams, workflowStates } from '../db/schema.ts';
import { requireAdmin } from '../lib/auth.ts';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { auditCtx } from '../services/audit.ts';
import { emit } from '../services/context.ts';
import { createTeam, listTeams } from '../services/teams.ts';

async function loadTeam(tx: DbOrTx, workspaceId: string, teamId: string) {
  const [team] = await tx
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
  if (!team) throw notFound('Team');
  return team;
}

async function loadState(tx: DbOrTx, workspaceId: string, stateId: string) {
  const [row] = await tx
    .select({ state: workflowStates })
    .from(workflowStates)
    .innerJoin(teams, eq(teams.id, workflowStates.teamId))
    .where(and(eq(workflowStates.id, stateId), eq(teams.workspaceId, workspaceId)));
  if (!row) throw notFound('Status');
  return row.state;
}

const keyTaken = (err: unknown) => {
  if (isUniqueViolation(err)) return conflict('Another team already uses that key');
  return err;
};

export async function teamRoutes(app: FastifyInstance) {
  app.get('/teams', async (req) => listTeams(app.db, req.workspace!.id));

  app.post('/teams', async (req) => {
    const input = parse(createTeamSchema, req.body);
    try {
      const id = await mutate(app, req, async (ctx) => {
        const teamId = await createTeam(ctx, input);
        await auditCtx(ctx, {
          action: 'team.created',
          targetType: 'team',
          targetId: teamId,
          data: { name: input.name, key: input.key },
        });
        return teamId;
      });
      return (await listTeams(app.db, req.workspace!.id)).find((t) => t.id === id);
    } catch (err) {
      throw keyTaken(err);
    }
  });

  app.patch('/teams/:teamId', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(updateTeamSchema, req.body);
    try {
      await mutate(app, req, async (ctx) => {
        await loadTeam(ctx.tx, ctx.workspaceId, teamId);
        if (input.defaultStateId) {
          const state = await loadState(ctx.tx, ctx.workspaceId, input.defaultStateId);
          if (state.teamId !== teamId) throw badRequest('Default status must belong to the team');
        }
        await ctx.tx
          .update(teams)
          .set(input as Partial<typeof teams.$inferInsert>)
          .where(eq(teams.id, teamId));
        emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
        await auditCtx(ctx, {
          action: 'team.updated',
          targetType: 'team',
          targetId: teamId,
          data: input,
        });
      });
    } catch (err) {
      throw keyTaken(err);
    }
    return (await listTeams(app.db, req.workspace!.id)).find((t) => t.id === teamId);
  });

  app.delete('/teams/:teamId', async (req) => {
    requireAdmin(req);
    const { teamId } = req.params as { teamId: string };
    return mutate(app, req, async (ctx) => {
      const team = await loadTeam(ctx.tx, ctx.workspaceId, teamId);
      const [{ n }] = (await ctx.tx
        .select({ n: count() })
        .from(teams)
        .where(eq(teams.workspaceId, ctx.workspaceId))) as [{ n: number }];
      if (n <= 1) throw badRequest('A workspace needs at least one team');
      // Issues reference workflow states without cascading, so remove them explicitly first.
      await ctx.tx.delete(issues).where(eq(issues.teamId, team.id));
      await ctx.tx.delete(teams).where(eq(teams.id, team.id));
      emit(ctx, { kind: 'team', action: 'deleted', id: team.id, teamId: team.id });
      await auditCtx(ctx, {
        action: 'team.deleted',
        targetType: 'team',
        targetId: team.id,
        data: { name: team.name, key: team.key },
      });
      return { ok: true };
    });
  });

  app.post('/teams/:teamId/members', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const { userId } = (req.body ?? {}) as { userId?: string };
    return mutate(app, req, async (ctx) => {
      await loadTeam(ctx.tx, ctx.workspaceId, teamId);
      await ctx.tx
        .insert(teamMembers)
        .values({ teamId, userId: userId ?? ctx.userId })
        .onConflictDoNothing();
      emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
      return { ok: true };
    });
  });

  app.delete('/teams/:teamId/members/:userId', async (req) => {
    const { teamId, userId } = req.params as { teamId: string; userId: string };
    return mutate(app, req, async (ctx) => {
      await loadTeam(ctx.tx, ctx.workspaceId, teamId);
      await ctx.tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
      emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
      return { ok: true };
    });
  });

  app.post('/teams/:teamId/states', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(createStateSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await loadTeam(ctx.tx, ctx.workspaceId, teamId);
      const [{ last }] = (await ctx.tx
        .select({ last: max(workflowStates.position) })
        .from(workflowStates)
        .where(eq(workflowStates.teamId, teamId))) as [{ last: number | null }];
      const [state] = await ctx.tx
        .insert(workflowStates)
        .values({ ...input, teamId, position: (last ?? 0) + SORT_GAP })
        .returning();
      emit(ctx, { kind: 'state', action: 'created', id: state!.id, teamId });
      return state;
    });
  });

  app.patch('/states/:stateId', async (req) => {
    const { stateId } = req.params as { stateId: string };
    const input = parse(updateStateSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const state = await loadState(ctx.tx, ctx.workspaceId, stateId);
      const [row] = await ctx.tx
        .update(workflowStates)
        .set(input)
        .where(eq(workflowStates.id, state.id))
        .returning();
      emit(ctx, { kind: 'state', action: 'updated', id: state.id, teamId: state.teamId });
      return row;
    });
  });

  /** Deletes a status; its issues move to `moveTo` (or the team default). */
  app.delete('/states/:stateId', async (req) => {
    const { stateId } = req.params as { stateId: string };
    const { moveTo } = (req.query ?? {}) as { moveTo?: string };
    return mutate(app, req, async (ctx) => {
      const state = await loadState(ctx.tx, ctx.workspaceId, stateId);
      const siblings = await ctx.tx
        .select()
        .from(workflowStates)
        .where(and(eq(workflowStates.teamId, state.teamId), ne(workflowStates.id, state.id)));
      if (state.type !== 'triage' && !siblings.some((s) => s.type === state.type)) {
        throw badRequest(`A team needs at least one ${state.type} status`);
      }
      const team = await loadTeam(ctx.tx, ctx.workspaceId, state.teamId);
      const target =
        siblings.find((s) => s.id === moveTo) ??
        siblings.find((s) => s.type === state.type) ??
        siblings.find((s) => s.id === team.defaultStateId) ??
        siblings[0];
      if (!target) throw badRequest('Cannot delete the only status');
      await ctx.tx.update(issues).set({ stateId: target.id }).where(eq(issues.stateId, state.id));
      if (team.defaultStateId === state.id)
        await ctx.tx.update(teams).set({ defaultStateId: target.id }).where(eq(teams.id, team.id));
      await ctx.tx.delete(workflowStates).where(eq(workflowStates.id, state.id));
      emit(ctx, { kind: 'state', action: 'deleted', id: state.id, teamId: state.teamId });
      emit(ctx, { kind: 'issue', action: 'updated', id: state.id, teamId: state.teamId });
      return { ok: true };
    });
  });
}
