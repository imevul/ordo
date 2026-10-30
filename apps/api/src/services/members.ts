import { isOwnerRole, type MemberRole } from '@ordo/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { teamMembers, teams, users, workspaceMembers } from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { auditCtx } from './audit.ts';
import { type Ctx, emit } from './context.ts';
import { assertNotLastOwner, memberRole } from './workspaces.ts';

/**
 * Workspace membership changes, whoever asks: an admin in Settings → Members or a directory over
 * SCIM. Callers decide who may do what; these keep the workspace's invariants (an owner remains,
 * removed people leave its teams too) and write the audit trail.
 */

const where = (ctx: Ctx, userId: string) =>
  and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId));

/** Changes from outside the app say where they came from. */
const via = (ctx: Ctx) => (ctx.source === 'scim' ? { via: 'scim' } : {});

async function current(ctx: Ctx, userId: string) {
  const role = await memberRole(ctx.tx, ctx.workspaceId, userId);
  if (!role) throw notFound('Member');
  // Agents stay guests of their own teams; they're managed (and disabled) as agents.
  const [user] = await ctx.tx.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  if (user?.kind === 'agent') throw badRequest('Agents are managed in Settings → Agents');
  return role;
}

export async function setMemberRole(ctx: Ctx, userId: string, role: MemberRole) {
  const was = await current(ctx, userId);
  if (was === role) return;
  if (isOwnerRole(was)) await assertNotLastOwner(ctx.tx, ctx.workspaceId, userId);
  await ctx.tx.update(workspaceMembers).set({ role }).where(where(ctx, userId));
  await auditCtx(ctx, {
    action: 'member.role_changed',
    targetType: 'user',
    targetId: userId,
    data: { role, ...via(ctx) },
  });
  emit(ctx, { kind: 'member', action: 'updated', id: userId });
}

/** Suspended members keep their place (teams, assignments) but can't open the workspace. */
export async function setSuspended(ctx: Ctx, userId: string, suspended: boolean) {
  const role = await current(ctx, userId);
  if (suspended && isOwnerRole(role)) await assertNotLastOwner(ctx.tx, ctx.workspaceId, userId);
  const [row] = await ctx.tx
    .select({ suspendedAt: workspaceMembers.suspendedAt })
    .from(workspaceMembers)
    .where(where(ctx, userId));
  if (!!row?.suspendedAt === suspended) return;
  await ctx.tx
    .update(workspaceMembers)
    .set({ suspendedAt: suspended ? new Date().toISOString() : null })
    .where(where(ctx, userId));
  await auditCtx(ctx, {
    action: suspended ? 'member.suspended' : 'member.unsuspended',
    targetType: 'user',
    targetId: userId,
    ...(ctx.source === 'scim' && { data: via(ctx) }),
  });
  emit(ctx, { kind: 'member', action: 'updated', id: userId });
}

/** Removes someone from the workspace and from all of its teams. */
export async function removeMember(ctx: Ctx, userId: string) {
  const role = await current(ctx, userId);
  if (isOwnerRole(role)) await assertNotLastOwner(ctx.tx, ctx.workspaceId, userId);
  const left = await leaveWorkspaceTeams(ctx, userId);
  await ctx.tx.delete(workspaceMembers).where(where(ctx, userId));
  for (const teamId of left) emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
  emit(ctx, { kind: 'member', action: 'deleted', id: userId });
  await auditCtx(ctx, {
    action: 'member.removed',
    targetType: 'user',
    targetId: userId,
    data: { self: userId === ctx.userId, ...via(ctx) },
  });
}

async function leaveWorkspaceTeams(ctx: Ctx, userId: string) {
  const workspaceTeams = ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.workspaceId, ctx.workspaceId));
  const removed = await ctx.tx
    .delete(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, workspaceTeams)))
    .returning({ teamId: teamMembers.teamId });
  return removed.map((r) => r.teamId);
}
