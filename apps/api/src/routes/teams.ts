import {
  addTeamMemberSchema,
  createStateSchema,
  createTeamSchema,
  createTriageRuleSchema,
  cycleAutomationOf,
  isTeamAdminRole,
  SORT_GAP,
  updateStateSchema,
  updateTeamMemberSchema,
  updateTeamSchema,
  updateTriageRuleSchema,
} from '@ordo/shared';
import { and, count, eq, isNull, max, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  cycles,
  issues,
  teamKeyAliases,
  teamMembers,
  teams,
  triageRules,
  workflowStates,
} from '../db/schema.ts';
import { requireAccess, requireAdmin, requireWorkspace } from '../lib/auth.ts';
import {
  badRequest,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  one,
  parse,
} from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { assertCan, assertTeamAccess, canAdminTeam, computeAccess } from '../services/access.ts';
import { auditCtx } from '../services/audit.ts';
import { type Ctx, emit } from '../services/context.ts';
import { bulkUpdateIssues } from '../services/issues.ts';
import { assertRepositories } from '../services/repositories.ts';
import { bumpEpoch } from '../services/sync.ts';
import {
  addTeamMember,
  assertNotManaged,
  createTeam,
  listTeams,
  removeTeamMember,
} from '../services/teams.ts';
import { assertTriageRule, toTriageRule } from '../services/triage.ts';

/** Loads a team of the workspace and checks the caller's access to it. */
async function loadTeam(ctx: Ctx, teamId: string, need: 'read' | 'admin' = 'read') {
  const [team] = await ctx.tx
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!team) throw notFound('Team');
  assertTeamAccess(ctx.access, team.id, need);
  return team;
}

/** Workflow states are managed by team admins. */
async function loadState(ctx: Ctx, stateId: string) {
  const [row] = await ctx.tx
    .select({ state: workflowStates })
    .from(workflowStates)
    .innerJoin(teams, eq(teams.id, workflowStates.teamId))
    .where(and(eq(workflowStates.id, stateId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!row) throw notFound('Status');
  assertTeamAccess(ctx.access, row.state.teamId, 'admin');
  return row.state;
}

const keyTaken = (err: unknown) => {
  if (isUniqueViolation(err))
    return conflict('Another team already uses that key').as('team_key_taken');
  return err;
};

export async function teamRoutes(app: FastifyInstance) {
  app.get('/teams', async (req) => listTeams(app.db, requireAccess(req)));

  app.post('/teams', async (req) => {
    assertCan(requireAccess(req), 'teams.create', 'Guests cannot create teams');
    const input = parse(createTeamSchema, req.body);
    try {
      const id = await mutate(app, req, async (ctx) => {
        const teamId = await createTeam(ctx, input);
        await auditCtx(ctx, {
          action: 'team.created',
          targetType: 'team',
          targetId: teamId,
          data: { name: input.name, key: input.key, private: input.private ?? false },
        });
        return teamId;
      });
      // Recompute access: the creator just joined (and administers) the new team.
      const ws = requireWorkspace(req);
      const access = await computeAccess(app.db, ws.access.userId, ws.id, ws.role);
      return (await listTeams(app.db, access)).find((t) => t.id === id);
    } catch (err) {
      throw keyTaken(err);
    }
  });

  app.patch('/teams/:teamId', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(updateTeamSchema, req.body);
    try {
      await mutate(app, req, async (ctx) => {
        const before = await loadTeam(ctx, teamId, 'admin');
        if (input.gitAutomation) {
          const ids = Object.values(input.gitAutomation).filter((v) => v && v !== 'none');
          const own = await ctx.tx
            .select({ id: workflowStates.id })
            .from(workflowStates)
            .where(eq(workflowStates.teamId, teamId));
          if (ids.some((sid) => !own.some((s) => s.id === sid)))
            throw badRequest('Automation statuses must belong to the team');
        }
        if (input.key && input.key !== before.key) {
          // The old key keeps resolving (branches, commits, old links); the new one is live now.
          await ctx.tx
            .delete(teamKeyAliases)
            .where(
              and(
                eq(teamKeyAliases.workspaceId, ctx.workspaceId),
                eq(teamKeyAliases.key, input.key),
              ),
            );
          await ctx.tx
            .insert(teamKeyAliases)
            .values({ workspaceId: ctx.workspaceId, key: before.key, teamId })
            .onConflictDoUpdate({
              target: [teamKeyAliases.workspaceId, teamKeyAliases.key],
              set: { teamId },
            });
        }
        if (input.defaultStateId) {
          const [state] = await ctx.tx
            .select({ teamId: workflowStates.teamId })
            .from(workflowStates)
            .where(eq(workflowStates.id, input.defaultStateId));
          if (state?.teamId !== teamId) throw badRequest('Default status must belong to the team');
        }
        await assertRepositories(ctx, [input.defaultRepositoryId]);
        const set = { ...input } as Partial<typeof teams.$inferInsert>;
        if (input.cycleAutomation) {
          const was = cycleAutomationOf(before.cycleAutomation);
          set.cycleAutomation = { ...was, ...input.cycleAutomation };
          // Turning automation on starts from now: cycles that already ended keep their issues.
          if (input.cycleAutomation.enabled && !was.enabled) {
            await ctx.tx
              .update(cycles)
              .set({ completedAt: new Date().toISOString() })
              .where(
                and(
                  eq(cycles.teamId, teamId),
                  sql`${cycles.endsAt} <= current_date`,
                  isNull(cycles.completedAt),
                ),
              );
          }
        }
        await ctx.tx.update(teams).set(set).where(eq(teams.id, teamId));
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
    return (await listTeams(app.db, requireAccess(req))).find((t) => t.id === teamId);
  });

  // ─── triage rules (team admins) ──────────────────────────────────────

  app.post('/teams/:teamId/triage-rules', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(createTriageRuleSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await loadTeam(ctx, teamId, 'admin');
      await assertTriageRule(ctx, teamId, input);
      const [{ last }] = (await ctx.tx
        .select({ last: max(triageRules.position) })
        .from(triageRules)
        .where(eq(triageRules.teamId, teamId))) as [{ last: number | null }];
      const row = one(
        await ctx.tx
          .insert(triageRules)
          .values({ ...input, teamId, position: (last ?? 0) + SORT_GAP })
          .returning(),
      );
      emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
      return toTriageRule(row);
    });
  });

  const loadRule = async (ctx: Ctx, id: string) => {
    const [rule] = await ctx.tx.select().from(triageRules).where(eq(triageRules.id, id));
    if (!rule) throw notFound('Triage rule');
    await loadTeam(ctx, rule.teamId, 'admin');
    return rule;
  };

  app.patch('/triage-rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateTriageRuleSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const rule = await loadRule(ctx, id);
      await assertTriageRule(ctx, rule.teamId, input);
      const row = one(
        await ctx.tx.update(triageRules).set(input).where(eq(triageRules.id, id)).returning(),
        'Triage rule',
      );
      emit(ctx, { kind: 'team', action: 'updated', id: rule.teamId, teamId: rule.teamId });
      return toTriageRule(row);
    });
  });

  app.delete('/triage-rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const rule = await loadRule(ctx, id);
      await ctx.tx.delete(triageRules).where(eq(triageRules.id, id));
      emit(ctx, { kind: 'team', action: 'updated', id: rule.teamId, teamId: rule.teamId });
      return { ok: true };
    });
  });

  app.delete('/teams/:teamId', async (req) => {
    requireAdmin(req);
    const { teamId } = req.params as { teamId: string };
    return mutate(app, req, async (ctx) => {
      const team = await loadTeam(ctx, teamId, 'admin');
      const [{ n }] = (await ctx.tx
        .select({ n: count() })
        .from(teams)
        .where(eq(teams.workspaceId, ctx.workspaceId))) as [{ n: number }];
      if (n <= 1) throw badRequest('A workspace needs at least one team').as('needs_team');
      // Issues reference workflow states without cascading, so remove them explicitly first.
      await ctx.tx.delete(issues).where(eq(issues.teamId, team.id));
      await ctx.tx.delete(teams).where(eq(teams.id, team.id));
      // Its issues are gone for everyone: sync clients start over rather than replay each one.
      await bumpEpoch(ctx.tx, ctx.workspaceId);
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

  /**
   * Adds a member. Anyone but guests may join a public team themselves; adding someone else,
   * joining a private team, or granting team admin requires being a team admin.
   */
  app.post('/teams/:teamId/members', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(addTeamMemberSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const team = await loadTeam(ctx, teamId);
      const userId = input.userId ?? ctx.userId;
      const selfJoin =
        userId === ctx.userId &&
        !isTeamAdminRole(input.role) &&
        !team.private &&
        !ctx.access.isGuest;
      if (!selfJoin && !canAdminTeam(ctx.access, teamId)) {
        throw forbidden('Only team admins can add people to this team').as('team_admins_add');
      }
      await assertNotManaged(ctx, teamId);
      await addTeamMember(ctx, teamId, userId, input.role);
      return { ok: true };
    });
  });

  app.patch('/teams/:teamId/members/:userId', async (req) => {
    const { teamId, userId } = req.params as { teamId: string; userId: string };
    const { role } = parse(updateTeamMemberSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await loadTeam(ctx, teamId, 'admin');
      const [row] = await ctx.tx
        .update(teamMembers)
        .set({ role })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
        .returning();
      if (!row) throw notFound('Team member');
      emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
      emit(ctx, { kind: 'member', action: 'updated', id: userId });
      await auditCtx(ctx, {
        action: 'team.member_role_changed',
        targetType: 'team',
        targetId: teamId,
        data: { userId, role },
      });
      return { ok: true };
    });
  });

  /** Leaving is always allowed; removing someone else requires being a team admin. */
  app.delete('/teams/:teamId/members/:userId', async (req) => {
    const { teamId, userId } = req.params as { teamId: string; userId: string };
    return mutate(app, req, async (ctx) => {
      await loadTeam(ctx, teamId, userId === ctx.userId ? 'read' : 'admin');
      await assertNotManaged(ctx, teamId);
      await removeTeamMember(ctx, teamId, userId);
      return { ok: true };
    });
  });

  app.post('/teams/:teamId/states', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const input = parse(createStateSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await loadTeam(ctx, teamId, 'admin');
      const [{ last }] = (await ctx.tx
        .select({ last: max(workflowStates.position) })
        .from(workflowStates)
        .where(eq(workflowStates.teamId, teamId))) as [{ last: number | null }];
      const state = one(
        await ctx.tx
          .insert(workflowStates)
          .values({ ...input, teamId, position: (last ?? 0) + SORT_GAP })
          .returning(),
      );
      emit(ctx, { kind: 'state', action: 'created', id: state.id, teamId });
      return state;
    });
  });

  app.patch('/states/:stateId', async (req) => {
    const { stateId } = req.params as { stateId: string };
    const input = parse(updateStateSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const state = await loadState(ctx, stateId);
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
      const state = await loadState(ctx, stateId);
      const siblings = await ctx.tx
        .select()
        .from(workflowStates)
        .where(and(eq(workflowStates.teamId, state.teamId), ne(workflowStates.id, state.id)));
      if (state.type !== 'triage' && !siblings.some((s) => s.type === state.type)) {
        throw badRequest(`A team needs at least one ${state.type} status`);
      }
      const team = await loadTeam(ctx, state.teamId, 'admin');
      const target =
        siblings.find((s) => s.id === moveTo) ??
        siblings.find((s) => s.type === state.type) ??
        siblings.find((s) => s.id === team.defaultStateId) ??
        siblings[0];
      if (!target) throw badRequest('Cannot delete the only status').as('only_status');
      const inState = await ctx.tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.stateId, state.id));
      await bulkUpdateIssues(
        ctx,
        inState.map((i) => i.id),
        { stateId: target.id },
      );
      if (team.defaultStateId === state.id)
        await ctx.tx.update(teams).set({ defaultStateId: target.id }).where(eq(teams.id, team.id));
      await ctx.tx.delete(workflowStates).where(eq(workflowStates.id, state.id));
      emit(ctx, { kind: 'state', action: 'deleted', id: state.id, teamId: state.teamId });
      return { ok: true };
    });
  });
}
