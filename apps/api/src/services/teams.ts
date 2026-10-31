import {
  cycleAutomationOf,
  DEFAULT_WORKFLOW_STATES,
  SORT_GAP,
  type Team,
  type TeamRole,
} from '@ordo/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  scimGroups,
  teamKeyAliases,
  teamMembers,
  teams,
  workflowStates,
  workspaceMembers,
} from '../db/schema.ts';
import { badRequest, conflict, one } from '../lib/errors.ts';
import { type Access, teamScope } from './access.ts';
import { auditCtx } from './audit.ts';
import { type Ctx, emit } from './context.ts';
import { toTriageRule, triageRulesOf } from './triage.ts';

export async function createTeam(
  ctx: Ctx,
  input: {
    name: string;
    key: string;
    description?: string | null;
    color?: string;
    private?: boolean;
  },
): Promise<string> {
  const team = one(
    await ctx.tx
      .insert(teams)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        key: input.key,
        description: input.description ?? null,
        color: input.color ?? '#ff1493',
        private: input.private ?? false,
      })
      .returning({ id: teams.id }),
  );
  const teamId = team.id;
  // A live key beats a former one.
  await ctx.tx
    .delete(teamKeyAliases)
    .where(and(eq(teamKeyAliases.workspaceId, ctx.workspaceId), eq(teamKeyAliases.key, input.key)));
  const states = await ctx.tx
    .insert(workflowStates)
    .values(DEFAULT_WORKFLOW_STATES.map((s, i) => ({ ...s, teamId, position: i * SORT_GAP })))
    .returning({ id: workflowStates.id, type: workflowStates.type });
  const backlog = states.find((s) => s.type === 'backlog');
  await ctx.tx
    .update(teams)
    .set({ defaultStateId: backlog?.id ?? null })
    .where(eq(teams.id, teamId));
  // The creator joins as the team's first admin.
  await ctx.tx
    .insert(teamMembers)
    .values({ teamId, userId: ctx.userId, role: 'admin' })
    .onConflictDoNothing();
  emit(ctx, { kind: 'team', action: 'created', id: teamId, teamId });
  return teamId;
}

/** Teams the given access can see, with workflow states and members. */
export async function listTeams(db: DbOrTx, access: Access): Promise<Team[]> {
  const rows = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, access.workspaceId), teamScope(access, teams.id)))
    .orderBy(asc(teams.name));
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const [states, members, rules, groups] = await Promise.all([
    db
      .select()
      .from(workflowStates)
      .where(inArray(workflowStates.teamId, ids))
      .orderBy(asc(workflowStates.position)),
    db.select().from(teamMembers).where(inArray(teamMembers.teamId, ids)),
    triageRulesOf(db, ids),
    db
      .select({ teamId: scimGroups.teamId, name: scimGroups.displayName })
      .from(scimGroups)
      .where(inArray(scimGroups.teamId, ids))
      .orderBy(asc(scimGroups.displayName)),
  ]);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    key: t.key,
    description: t.description,
    color: t.color,
    estimateScale: t.estimateScale,
    triageEnabled: t.triageEnabled,
    cyclesEnabled: t.cyclesEnabled,
    defaultStateId: t.defaultStateId,
    defaultRepositoryId: t.defaultRepositoryId,
    private: t.private,
    gitAutomation: t.gitAutomation,
    cycleAutomation: cycleAutomationOf(t.cycleAutomation),
    autoArchiveMonths: t.autoArchiveMonths,
    slaHours: t.slaHours,
    triageRules: rules.filter((r) => r.teamId === t.id).map(toTriageRule),
    defaultCapacity: t.defaultCapacity,
    memberIds: members.filter((m) => m.teamId === t.id).map((m) => m.userId),
    members: members
      .filter((m) => m.teamId === t.id)
      .map((m) => ({ userId: m.userId, role: m.role, capacity: m.capacity })),
    managedBy: groups.filter((g) => g.teamId === t.id).map((g) => g.name),
    states: states
      .filter((s) => s.teamId === t.id)
      .map((s) => ({
        id: s.id,
        teamId: s.teamId,
        name: s.name,
        type: s.type,
        color: s.color,
        position: s.position,
        description: s.description,
      })),
  }));
}

/**
 * Puts a workspace member on a team, or changes their role there. Callers check who may; this
 * checks they belong to the workspace.
 */
export async function addTeamMember(ctx: Ctx, teamId: string, userId: string, role: TeamRole) {
  const [member] = await ctx.tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)),
    );
  if (!member) throw badRequest('That person is not a member of this workspace').as('not_member');
  await ctx.tx
    .insert(teamMembers)
    .values({ teamId, userId, role })
    .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { role } });
  emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
  emit(ctx, { kind: 'member', action: 'updated', id: userId });
  await auditCtx(ctx, {
    action: 'team.member_added',
    targetType: 'team',
    targetId: teamId,
    data: { userId, role, ...(ctx.source === 'scim' && { via: 'scim' }) },
  });
}

/** Takes someone off a team; false when they weren't on it. */
export async function removeTeamMember(ctx: Ctx, teamId: string, userId: string) {
  const removed = await ctx.tx
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning({ userId: teamMembers.userId });
  if (!removed.length) return false;
  emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
  emit(ctx, { kind: 'member', action: 'updated', id: userId });
  await auditCtx(ctx, {
    action: 'team.member_removed',
    targetType: 'team',
    targetId: teamId,
    data: { userId, ...(ctx.source === 'scim' && { via: 'scim' }) },
  });
  return true;
}

/** Teams linked to directory groups take their members from those groups only. */
export async function assertNotManaged(ctx: Ctx, teamId: string) {
  if (ctx.source === 'scim') return;
  const [group] = await ctx.tx
    .select({ name: scimGroups.displayName })
    .from(scimGroups)
    .where(eq(scimGroups.teamId, teamId))
    .limit(1);
  if (group)
    throw conflict(
      `This team's members come from the directory group "${group.name}". Change them there.`,
    ).as('team_managed', { group: group.name });
}
