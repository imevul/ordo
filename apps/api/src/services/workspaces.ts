import {
  DEFAULT_WORKSPACE_SETTINGS,
  type MemberRole,
  type Workspace,
  type WorkspaceSettings,
} from '@ordo/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { teamMembers, teams, users, workspaceMembers, workspaces } from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import type { Access } from './access.ts';
import { signedFileUrl } from './files.ts';

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
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      suspendedAt: workspaceMembers.suspendedAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, access.workspaceId))
    .orderBy(asc(users.name));
  return rows.map(({ suspendedAt, ...m }) => ({
    ...m,
    suspended: !!suspendedAt,
    email: access.isGuest && m.id !== access.userId ? '' : m.email,
  }));
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
    throw badRequest('A workspace needs at least one owner. Make someone else an owner first.');
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
    ...new Set([...teamIds, ...(role !== 'guest' && ws?.defaultTeamId ? [ws.defaultTeamId] : [])]),
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
