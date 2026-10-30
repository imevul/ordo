import type { ScimGroup, ScimLinkPreview } from '@ordo/shared';
import { and, asc, count, eq, inArray, type SQL, sql } from 'drizzle-orm';
import {
  scimGroupMembers,
  scimGroups,
  scimUsers,
  teamMembers,
  teams,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { notFound, one } from '../lib/errors.ts';
import { auditCtx } from './audit.ts';
import type { Ctx } from './context.ts';
import { SCIM_SCHEMA, ScimError, type ScimQuery, scimPage, UUID, visible } from './scim.ts';
import { addTeamMember, removeTeamMember } from './teams.ts';
import { workspaceSettings } from './workspaces.ts';

/**
 * Directory groups. On their own they only mirror the directory; linked to a team (by an admin,
 * or by name when the workspace asks for that) they decide who is on it: the team's members
 * become everyone in its linked groups, and changes in the directory follow.
 */

type GroupRow = typeof scimGroups.$inferSelect;

async function loadGroup(ctx: Ctx, id: string) {
  const [row] = UUID.test(id)
    ? await ctx.tx
        .select()
        .from(scimGroups)
        .where(and(eq(scimGroups.id, id), eq(scimGroups.workspaceId, ctx.workspaceId)))
    : [];
  return row ?? null;
}

async function groupOrThrow(ctx: Ctx, id: string) {
  const row = await loadGroup(ctx, id);
  if (!row) throw new ScimError(404, 'Group not found');
  return row;
}

async function membersOf(ctx: Ctx, groupIds: string[]) {
  if (!groupIds.length) return [];
  return ctx.tx
    .select({ groupId: scimGroupMembers.groupId, id: users.id, name: users.name })
    .from(scimGroupMembers)
    .innerJoin(users, eq(users.id, scimGroupMembers.userId))
    .where(inArray(scimGroupMembers.groupId, groupIds))
    .orderBy(asc(users.name));
}

function toScimGroup(
  row: GroupRow,
  members: { id: string; name: string }[] | null,
  baseUrl: string,
) {
  return {
    schemas: [SCIM_SCHEMA.group],
    id: row.id,
    displayName: row.displayName,
    ...(row.externalId && { externalId: row.externalId }),
    ...(members && {
      members: members.map((m) => ({
        value: m.id,
        display: m.name,
        $ref: `${baseUrl}/Users/${m.id}`,
      })),
    }),
    meta: {
      resourceType: 'Group',
      created: row.createdAt,
      lastModified: row.updatedAt,
      location: `${baseUrl}/Groups/${row.id}`,
    },
  };
}

/** Entra asks for groups without their members (`excludedAttributes=members`) to keep it quick. */
const wantsMembers = (q: { excludedAttributes?: string }) =>
  !(q.excludedAttributes ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .includes('members');

function groupFilter(filter: string | undefined): SQL[] {
  if (!filter?.trim()) return [];
  return filter.split(/\s+and\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/i).map((clause) => {
    const m = /^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(clause);
    if (!m) throw new ScimError(400, `Unsupported filter: ${clause}`, 'invalidFilter');
    const value = m[2]!.replace(/\\(.)/g, '$1');
    switch (m[1]!.toLowerCase()) {
      case 'displayname':
        return sql`lower(${scimGroups.displayName}) = ${value.toLowerCase()}`;
      case 'externalid':
        return eq(scimGroups.externalId, value);
      case 'id':
        return UUID.test(value) ? eq(scimGroups.id, value) : sql`false`;
      default:
        throw new ScimError(400, `Unsupported filter attribute: ${m[1]}`, 'invalidFilter');
    }
  });
}

export async function listScimGroups(ctx: Ctx, baseUrl: string, q: ScimQuery) {
  const where = and(eq(scimGroups.workspaceId, ctx.workspaceId), ...groupFilter(q.filter));
  const { startIndex, pageSize } = scimPage(q);
  const [{ total }] = (await ctx.tx.select({ total: count() }).from(scimGroups).where(where)) as [
    { total: number },
  ];
  const rows = pageSize
    ? await ctx.tx
        .select()
        .from(scimGroups)
        .where(where)
        .orderBy(asc(scimGroups.createdAt), asc(scimGroups.id))
        .limit(pageSize)
        .offset(startIndex - 1)
    : [];
  const members = wantsMembers(q)
    ? await membersOf(
        ctx,
        rows.map((r) => r.id),
      )
    : null;
  return {
    schemas: [SCIM_SCHEMA.list],
    totalResults: total,
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((r) =>
      toScimGroup(r, members?.filter((m) => m.groupId === r.id) ?? null, baseUrl),
    ),
  };
}

export async function getScimGroup(
  ctx: Ctx,
  baseUrl: string,
  id: string,
  q: { excludedAttributes?: string } = {},
) {
  const row = await groupOrThrow(ctx, id);
  return toScimGroup(row, wantsMembers(q) ? await membersOf(ctx, [row.id]) : null, baseUrl);
}

/** Member references the directory sent, kept only for people it may see. */
async function knownMembers(ctx: Ctx, value: unknown): Promise<string[]> {
  const ids = (Array.isArray(value) ? value : value ? [value] : [])
    .map((m) => (typeof m === 'string' ? m : (m as { value?: unknown })?.value))
    .filter((v): v is string => typeof v === 'string' && UUID.test(v));
  if (!ids.length) return [];
  const rows = await ctx.tx
    .select({ id: users.id })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .leftJoin(
      scimUsers,
      and(eq(scimUsers.workspaceId, workspaceMembers.workspaceId), eq(scimUsers.userId, users.id)),
    )
    .where(and(visible(ctx), inArray(users.id, [...new Set(ids)])));
  return rows.map((r) => r.id);
}

/** What a request wants changed about a group. `members` replaces; `add`/`remove` adjust. */
interface GroupChanges {
  displayName?: string;
  externalId?: string | null;
  members?: unknown;
  add: unknown[];
  remove: unknown[];
  removeAll?: boolean;
}

function groupResourceChanges(body: unknown): GroupChanges {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.displayName !== 'string' || !b.displayName.trim())
    throw new ScimError(400, 'displayName is required', 'invalidValue');
  return {
    displayName: b.displayName.trim(),
    externalId: typeof b.externalId === 'string' ? b.externalId : undefined,
    members: b.members ?? [],
    add: [],
    remove: [],
  };
}

/**
 * PATCH in the dialects identity providers use: `members` add and remove with a list (Okta, Entra),
 * `members[value eq "…"]` remove (Okta), a path-less replace of displayName (Entra).
 */
function groupPatchChanges(body: unknown): GroupChanges {
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops)) throw new ScimError(400, 'Expected Operations', 'invalidSyntax');
  const changes: GroupChanges = { add: [], remove: [] };
  const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  for (const op of ops as { op?: unknown; path?: unknown; value?: unknown }[]) {
    const kind = typeof op?.op === 'string' ? op.op.toLowerCase() : '';
    if (!['add', 'replace', 'remove'].includes(kind))
      throw new ScimError(400, `Unsupported operation: ${String(op?.op)}`, 'invalidSyntax');
    const path = typeof op.path === 'string' ? op.path.trim() : '';
    const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
    if (filtered) {
      if (kind === 'remove') changes.remove.push(filtered[1]);
      continue;
    }
    const attr = path.toLowerCase();
    if (attr === 'members') {
      if (kind === 'add') changes.add.push(...list(op.value));
      else if (kind === 'replace') changes.members = list(op.value);
      else if (op.value === undefined) changes.removeAll = true;
      else changes.remove.push(...list(op.value));
    } else if (attr === 'displayname') {
      if (kind !== 'remove' && typeof op.value === 'string') changes.displayName = op.value.trim();
    } else if (attr === 'externalid') {
      changes.externalId = kind === 'remove' ? null : String(op.value ?? '');
    } else if (!path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      if (typeof v.displayName === 'string') changes.displayName = v.displayName.trim();
      if (typeof v.externalId === 'string') changes.externalId = v.externalId;
      if (v.members !== undefined) {
        if (kind === 'add') changes.add.push(...list(v.members));
        else changes.members = list(v.members);
      }
    }
  }
  return changes;
}

async function applyGroupChanges(ctx: Ctx, group: GroupRow, changes: GroupChanges) {
  const patch: Partial<GroupRow> = {};
  if (changes.displayName && changes.displayName !== group.displayName)
    patch.displayName = changes.displayName;
  if (changes.externalId !== undefined) patch.externalId = changes.externalId;
  await ctx.tx
    .update(scimGroups)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(scimGroups.id, group.id));

  const where = eq(scimGroupMembers.groupId, group.id);
  if (changes.members !== undefined || changes.removeAll) {
    await ctx.tx.delete(scimGroupMembers).where(where);
  }
  const add = [
    ...(changes.members !== undefined ? await knownMembers(ctx, changes.members) : []),
    ...(await knownMembers(ctx, changes.add)),
  ];
  if (add.length)
    await ctx.tx
      .insert(scimGroupMembers)
      .values([...new Set(add)].map((userId) => ({ groupId: group.id, userId })))
      .onConflictDoNothing();
  const remove = (changes.remove.length ? changes.remove : [])
    .map((m) => (typeof m === 'string' ? m : (m as { value?: unknown })?.value))
    .filter((v): v is string => typeof v === 'string' && UUID.test(v));
  if (remove.length)
    await ctx.tx
      .delete(scimGroupMembers)
      .where(and(where, inArray(scimGroupMembers.userId, remove)));

  if (group.teamId) await reconcileTeam(ctx, group.teamId);
  else if (patch.displayName) await matchByName(ctx, { ...group, ...patch });
}

export async function createScimGroup(ctx: Ctx, baseUrl: string, body: unknown) {
  const changes = groupResourceChanges(body);
  const row = one(
    await ctx.tx
      .insert(scimGroups)
      .values({
        workspaceId: ctx.workspaceId,
        displayName: changes.displayName!,
        externalId: changes.externalId ?? null,
      })
      .returning(),
  );
  await applyGroupChanges(ctx, row, changes);
  if (!row.teamId) await matchByName(ctx, row);
  return getScimGroup(ctx, baseUrl, row.id);
}

export async function updateScimGroup(
  ctx: Ctx,
  baseUrl: string,
  id: string,
  body: unknown,
  kind: 'put' | 'patch',
) {
  const group = await groupOrThrow(ctx, id);
  await applyGroupChanges(
    ctx,
    group,
    kind === 'put' ? groupResourceChanges(body) : groupPatchChanges(body),
  );
  return getScimGroup(ctx, baseUrl, id);
}

/** The team it decided keeps its members, now managed by hand (unless other groups link it). */
export async function deleteScimGroup(ctx: Ctx, id: string) {
  const group = await groupOrThrow(ctx, id);
  await ctx.tx.delete(scimGroups).where(eq(scimGroups.id, group.id));
  if (group.teamId) await reconcileTeam(ctx, group.teamId);
}

// ─── teams ───────────────────────────────────────────────────────────────

/** Who should be on a team: everyone in its linked groups who is still a workspace member. */
async function desiredMembers(ctx: Ctx, groupIds: string[]) {
  if (!groupIds.length) return null;
  const rows = await ctx.tx
    .selectDistinct({ id: scimGroupMembers.userId })
    .from(scimGroupMembers)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, scimGroupMembers.userId),
      ),
    )
    .where(inArray(scimGroupMembers.groupId, groupIds));
  return new Set(rows.map((r) => r.id));
}

async function linkedGroups(ctx: Ctx, teamId: string) {
  const rows = await ctx.tx
    .select({ id: scimGroups.id })
    .from(scimGroups)
    .where(and(eq(scimGroups.teamId, teamId), eq(scimGroups.workspaceId, ctx.workspaceId)));
  return rows.map((r) => r.id);
}

async function teamMemberIds(ctx: Ctx, teamId: string) {
  const rows = await ctx.tx
    .select({ id: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return new Set(rows.map((r) => r.id));
}

/** Makes a linked team's members match its groups. Roles of people who stay are kept. */
export async function reconcileTeam(ctx: Ctx, teamId: string) {
  const desired = await desiredMembers(ctx, await linkedGroups(ctx, teamId));
  if (!desired) return;
  const current = await teamMemberIds(ctx, teamId);
  for (const id of desired) if (!current.has(id)) await addTeamMember(ctx, teamId, id, 'member');
  for (const id of current) if (!desired.has(id)) await removeTeamMember(ctx, teamId, id);
}

async function matchByName(ctx: Ctx, group: GroupRow) {
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  if (!workspaceSettings(ws!).scimMatchGroupsByName) return;
  const [team] = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, ctx.workspaceId),
        sql`lower(${teams.name}) = ${group.displayName.toLowerCase()}`,
      ),
    );
  if (team) await linkGroup(ctx, group.id, team.id);
}

// ─── admin ───────────────────────────────────────────────────────────────

export async function adminGroups(ctx: Ctx): Promise<ScimGroup[]> {
  const rows = await ctx.tx
    .select({
      id: scimGroups.id,
      displayName: scimGroups.displayName,
      teamId: scimGroups.teamId,
      memberCount: sql<number>`(select count(*)::int from ${scimGroupMembers} where ${scimGroupMembers.groupId} = "scim_groups"."id")`,
    })
    .from(scimGroups)
    .where(eq(scimGroups.workspaceId, ctx.workspaceId))
    .orderBy(asc(scimGroups.displayName));
  return rows;
}

async function teamInWorkspace(ctx: Ctx, teamId: string) {
  const [team] = await ctx.tx
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!team) throw notFound('Team');
  return team;
}

/** Who linking `groupId` to `teamId` would add to the team and take off it. */
export async function previewLink(
  ctx: Ctx,
  groupId: string,
  teamId: string,
): Promise<ScimLinkPreview> {
  const group = await loadGroup(ctx, groupId);
  if (!group) throw notFound('Group');
  await teamInWorkspace(ctx, teamId);
  const groups = [...new Set([...(await linkedGroups(ctx, teamId)), group.id])];
  const desired = (await desiredMembers(ctx, groups))!;
  const current = await teamMemberIds(ctx, teamId);
  const ids = [...new Set([...desired, ...current])];
  const names = ids.length
    ? await ctx.tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const named = (id: string) => ({ id, name: names.find((n) => n.id === id)?.name ?? '?' });
  return {
    add: [...desired].filter((id) => !current.has(id)).map(named),
    remove: [...current].filter((id) => !desired.has(id)).map(named),
  };
}

/** Links a group to a team (and reconciles it), or unlinks it (members stay). */
export async function linkGroup(ctx: Ctx, groupId: string, teamId: string | null) {
  const group = await loadGroup(ctx, groupId);
  if (!group) throw notFound('Group');
  if (group.teamId === teamId) return;
  const team = teamId ? await teamInWorkspace(ctx, teamId) : null;
  await ctx.tx
    .update(scimGroups)
    .set({ teamId, updatedAt: new Date().toISOString() })
    .where(eq(scimGroups.id, groupId));
  const previous = group.teamId;
  await auditCtx(ctx, {
    action: team ? 'scim.group_linked' : 'scim.group_unlinked',
    targetType: 'team',
    targetId: team?.id ?? previous ?? undefined,
    data: { group: group.displayName, ...(team && { team: team.name }) },
  });
  if (team) await reconcileTeam(ctx, team.id);
  // Other groups may still decide the old team: without this one's people.
  if (previous) await reconcileTeam(ctx, previous);
}
