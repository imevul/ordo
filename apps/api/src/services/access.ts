import {
  isAdminRole,
  isGuestRole,
  isOwnerRole,
  isTeamAdminRole,
  type MemberRole,
} from '@ordo/shared';
import { type AnyColumn, and, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { teamMembers, teams, users, workspaceMembers } from '../db/schema.ts';
import { forbidden, notFound } from '../lib/errors.ts';

/**
 * What one user may see and do in one workspace. Computed once per request (and per socket),
 * then passed to every query and check, so access rules live in exactly one place.
 *
 * - owner/admin: every team.
 * - member: every public team, plus private teams they belong to.
 * - guest: only teams they belong to.
 * Team admins (or workspace admins) manage a team's settings, workflow and membership.
 */
export interface Access {
  userId: string;
  workspaceId: string;
  role: MemberRole;
  isOwner: boolean;
  isAdmin: boolean;
  isGuest: boolean;
  /** An agent account: a guest of its teams that may still plan there (cycles, milestones). */
  isAgent: boolean;
  /** Teams this user can read and work in. */
  teamIds: string[];
  /** Teams this user administers (all readable teams for workspace admins). */
  adminTeamIds: string[];
  /** Teams this user has joined. */
  memberTeamIds: string[];
  /** True for system contexts (jobs, seeds) that act on the whole workspace. */
  system: boolean;
}

export async function computeAccess(
  db: DbOrTx,
  userId: string,
  workspaceId: string,
  role: MemberRole,
): Promise<Access> {
  const [allTeams, memberships, [user]] = await Promise.all([
    db
      .select({ id: teams.id, private: teams.private })
      .from(teams)
      .where(eq(teams.workspaceId, workspaceId)),
    db
      .select({ teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, userId), eq(teams.workspaceId, workspaceId))),
    db.select({ kind: users.kind }).from(users).where(eq(users.id, userId)),
  ]);
  const joined = new Set(memberships.map((m) => m.teamId));
  const isAdmin = isAdminRole(role);
  const readable = allTeams
    .filter((t) => isAdmin || joined.has(t.id) || (!isGuestRole(role) && !t.private))
    .map((t) => t.id);
  return {
    userId,
    workspaceId,
    role,
    isOwner: isOwnerRole(role),
    isAdmin,
    isGuest: isGuestRole(role),
    isAgent: user?.kind === 'agent',
    teamIds: readable,
    adminTeamIds: isAdmin
      ? readable
      : memberships.filter((m) => isTeamAdminRole(m.role)).map((m) => m.teamId),
    memberTeamIds: [...joined],
    system: false,
  };
}

/** Access for system work (jobs, seeds, creating a workspace): every team in the workspace. */
export function systemAccess(workspaceId: string, actorId: string): Access {
  return {
    userId: actorId,
    workspaceId,
    role: 'owner',
    isOwner: true,
    isAdmin: true,
    isGuest: false,
    isAgent: false,
    teamIds: [],
    adminTeamIds: [],
    memberTeamIds: [],
    system: true,
  };
}

// Admins see every team of their workspace (team lookups always filter by workspace), including
// teams created after their access was computed.
export const canReadTeam = (a: Access, teamId: string) => a.isAdmin || a.teamIds.includes(teamId);
export const canAdminTeam = (a: Access, teamId: string) =>
  a.isAdmin || a.adminTeamIds.includes(teamId);

/**
 * Throws unless the team is accessible at the given level. Unreadable teams are reported as
 * "not found" so their existence doesn't leak.
 */
export function assertTeamAccess(
  a: Access,
  teamId: string,
  need: 'read' | 'write' | 'admin' = 'read',
) {
  if (!canReadTeam(a, teamId)) throw notFound('Team');
  if (need === 'admin' && !canAdminTeam(a, teamId))
    throw forbidden('Only team admins can do this').as('team_admins_only');
}

/** SQL restricting `column` (a team id) to readable teams; undefined when everything is visible. */
export function teamScope(a: Access, column: AnyColumn | SQL): SQL | undefined {
  if (a.isAdmin) return undefined;
  if (a.teamIds.length === 0) return sql`false`;
  return inArray(column as AnyColumn, a.teamIds);
}

export type WorkspaceAction =
  | 'workspace.manage'
  | 'workspace.delete'
  | 'members.manage'
  | 'members.invite'
  | 'audit.read'
  | 'issues.purge'
  | 'teams.create'
  | 'projects.create'
  | 'views.create'
  | 'labels.create';

export function can(a: Access, action: WorkspaceAction): boolean {
  switch (action) {
    case 'workspace.delete':
      return a.isOwner;
    case 'workspace.manage':
    case 'members.manage':
    case 'members.invite':
    case 'audit.read':
    case 'issues.purge':
      return a.isAdmin;
    case 'teams.create':
    case 'projects.create':
    case 'views.create':
    case 'labels.create':
      return !a.isGuest;
  }
}

export function assertCan(a: Access, action: WorkspaceAction, message?: string) {
  if (!can(a, action)) throw forbidden(message);
}

/** Of `userIds`, those who may read `teamId` (used for notifications and mentions). */
export async function usersWithTeamAccess(
  db: DbOrTx,
  workspaceId: string,
  teamId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(teams, eq(teams.id, teamId))
    .leftJoin(
      teamMembers,
      and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, workspaceMembers.userId)),
    )
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(teams.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, userIds),
        or(
          inArray(workspaceMembers.role, ['owner', 'admin']),
          sql`${teamMembers.userId} is not null`,
          and(eq(workspaceMembers.role, 'member'), eq(teams.private, false)),
        ),
      ),
    );
  return rows.map((r) => r.userId);
}
