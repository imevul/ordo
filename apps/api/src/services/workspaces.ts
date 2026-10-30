import {
  DEFAULT_WORKSPACE_SETTINGS,
  isGuestRole,
  type Member,
  type MemberRole,
  type User,
  type Workspace,
  type WorkspaceSettings,
} from '@ordo/shared';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { issues, teamMembers, teams, users, workspaceMembers, workspaces } from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import { type Access, teamScope } from './access.ts';
import { signedFileUrl } from './files.ts';
import { statusColumns, statusOf } from './status.ts';

export const workspaceSettings = (row: {
  settings: Partial<WorkspaceSettings> | null;
}): WorkspaceSettings => ({
  ...DEFAULT_WORKSPACE_SETTINGS,
  ...row.settings,
});

export function toWorkspace(app: FastifyInstance, row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: signedFileUrl(app, row.logoFileId),
    defaultTeamId: row.defaultTeamId,
    settings: workspaceSettings(row),
    createdAt: row.createdAt,
  };
}

/** Members of the workspace as `access` may see them: guests don't see other people's email. */
export async function listMembers(db: DbOrTx, access: Access) {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      email: users.email,
      avatarColor: users.avatarColor,
      avatarFileId: users.avatarFileId,
      kind: users.kind,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      suspendedAt: workspaceMembers.suspendedAt,
      ...statusColumns,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, access.workspaceId))
    .orderBy(asc(users.name));
  const now = Date.now();
  return rows.map(
    ({ suspendedAt, kind, statusKind, statusEmoji, statusText, statusUntil, ...m }) => ({
      ...m,
      status: statusOf({ statusKind, statusEmoji, statusText, statusUntil }, now),
      kind: kind === 'agent' ? ('agent' as const) : ('human' as const),
      suspended: !!suspendedAt,
      email: access.isGuest && m.id !== access.userId ? '' : m.email,
    }),
  );
}

/**
 * People who left the workspace but are still assigned issues `access` can see: a name and a
 * colour, so those issues still say whose they are.
 */
export async function listFormerMembers(
  db: DbOrTx,
  access: Access,
): Promise<(User & Pick<Member, 'kind'>)[]> {
  const current = db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, access.workspaceId));
  const assigned = db
    .selectDistinct({ id: issues.assigneeId })
    .from(issues)
    .where(
      and(
        eq(issues.workspaceId, access.workspaceId),
        isNull(issues.deletedAt),
        teamScope(access, issues.teamId),
      ),
    );
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      avatarColor: users.avatarColor,
      kind: users.kind,
    })
    .from(users)
    .where(
      and(
        inArray(users.id, assigned),
        notInArray(users.id, current),
        // Placeholders and bots come with the bootstrap on their own.
        inArray(users.kind, ['human', 'agent']),
      ),
    )
    .orderBy(asc(users.name));
  // The kind filter above leaves only humans and agents.
  return rows.map((r) => ({
    ...r,
    kind: r.kind as Member['kind'],
    email: '',
    avatarUrl: null,
  }));
}

/**
 * Whether POST /workspaces lets this person create one. With creation off, anyone may still make
 * their first workspace, except people who came in through a site invite that didn't grant it.
 */
export async function mayCreateWorkspace(app: FastifyInstance, userId: string) {
  if (app.settings.get('allowWorkspaceCreation')) return true;
  const [row] = await app.db
    .select({
      canCreateWorkspaces: users.canCreateWorkspaces,
      siteInvitedAt: users.siteInvitedAt,
      memberships: sql<number>`(select count(*)::int from workspace_members m where m.user_id = "users"."id")`,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return false;
  return row.canCreateWorkspaces || (row.memberships === 0 && !row.siteInvitedAt);
}

export async function memberRole(tx: DbOrTx, workspaceId: string, userId: string) {
  const [row] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

export async function assertNotLastOwner(tx: DbOrTx, workspaceId: string, userId: string) {
  const owners = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')));
  if (owners.length === 1 && owners[0]!.userId === userId) {
    throw badRequest('A workspace needs at least one owner. Make someone else an owner first.').as(
      'needs_owner',
    );
  }
}

/**
 * Adds someone to a workspace (no-op if already a member) and to the given teams, plus the
 * workspace's default team unless they're a guest. Used by invites and domain auto-join.
 */
export async function joinWorkspace(
  tx: DbOrTx,
  workspaceId: string,
  userId: string,
  role: MemberRole,
  teamIds: string[] = [],
) {
  await tx.insert(workspaceMembers).values({ workspaceId, userId, role }).onConflictDoNothing();
  const [ws] = await tx
    .select({ defaultTeamId: workspaces.defaultTeamId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const wanted = [
    ...new Set([
      ...teamIds,
      ...(!isGuestRole(role) && ws?.defaultTeamId ? [ws.defaultTeamId] : []),
    ]),
  ];
  if (wanted.length === 0) return;
  // Only teams that still exist in this workspace.
  const valid = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), inArray(teams.id, wanted)));
  if (valid.length) {
    await tx
      .insert(teamMembers)
      .values(valid.map((t) => ({ teamId: t.id, userId })))
      .onConflictDoNothing();
  }
}
