import { randomUUID } from 'node:crypto';
import { AVATAR_COLORS, type PlaceholderSummary, type User } from '@ordo/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  attachments,
  comments,
  domainEvents,
  files,
  importItems,
  issueHistory,
  issueLinks,
  issueRelations,
  issues,
  notifications,
  projects,
  projectUpdates,
  users,
  workspaceMembers,
} from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { usersWithTeamAccess } from './access.ts';
import { auditCtx } from './audit.ts';
import { type Ctx, emit } from './context.ts';

/**
 * Placeholders stand in for people an import brought along who aren't members. They're named on
 * the issues they created or were assigned, but can't sign in, aren't notified and can't be
 * picked. When the person joins, an admin merges the placeholder into their account.
 */

const lower = (s: string) => s.trim().toLowerCase();

export async function createPlaceholder(
  ctx: Ctx,
  input: { name: string; email: string | null },
): Promise<string> {
  const id = randomUUID();
  const handle =
    lower(input.name)
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'person';
  await ctx.tx.insert(users).values({
    id,
    kind: 'placeholder',
    botWorkspaceId: ctx.workspaceId,
    // Never their real email: that stays free for the account they sign up with.
    email: `placeholder-${id}@placeholders.ordo.invalid`,
    name: input.name.trim().slice(0, 120) || 'Imported person',
    username: `${handle}-${id.slice(0, 8)}`,
    passwordHash: null,
    importedEmail: input.email,
    avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
  });
  return id;
}

const ofWorkspace = (workspaceId: string) =>
  and(eq(users.kind, 'placeholder'), eq(users.botWorkspaceId, workspaceId));

/** Placeholders as everyone sees them (bootstrap): a name and a colour. */
export async function workspacePlaceholders(db: DbOrTx, workspaceId: string): Promise<User[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      avatarColor: users.avatarColor,
    })
    .from(users)
    .where(ofWorkspace(workspaceId));
  return rows.map((r) => ({ ...r, email: '', avatarUrl: null }));
}

export async function isWorkspacePlaceholder(db: DbOrTx, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), ofWorkspace(workspaceId)));
  return !!row;
}

/** Placeholders for admins: what's attributed to each, and the member they probably are. */
export async function listPlaceholders(
  db: DbOrTx,
  workspaceId: string,
): Promise<PlaceholderSummary[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      avatarColor: users.avatarColor,
      importedEmail: users.importedEmail,
      assigned: sql<number>`(select count(*)::int from issues i where i.assignee_id = "users"."id" and i.deleted_at is null)`,
      created: sql<number>`(select count(*)::int from issues i where i.creator_id = "users"."id")`,
      comments: sql<number>`(select count(*)::int from comments c where c.author_id = "users"."id")`,
    })
    .from(users)
    .where(ofWorkspace(workspaceId))
    .orderBy(users.name);
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.kind, 'human')));
  return rows.map((p) => ({
    ...p,
    suggestedUserId:
      (
        (p.importedEmail && members.find((m) => lower(m.email) === lower(p.importedEmail!))) ||
        members.find((m) => lower(m.name) === lower(p.name))
      )?.id ?? null,
  }));
}

/** Columns that name a person; a merge moves the placeholder's mentions in them to the member. */
export const MERGED_COLUMNS = [
  issues.creatorId,
  comments.authorId,
  issueHistory.actorId,
  issueRelations.createdBy,
  issueLinks.authorUserId,
  issueLinks.createdById,
  notifications.actorId,
  projectUpdates.authorId,
  projects.createdBy,
  projects.leadId,
  domainEvents.actorId,
  files.ownerId,
  attachments.uploaderId,
];

/**
 * The other columns that refer to users, and why a merge leaves them alone. A test checks that
 * every foreign key to `users` is in one list or the other.
 */
export const UNMERGED_COLUMNS: Record<string, string> = {
  'issues.assignee_id': 'moved separately: only to issues the member can see',
  'issue_subscribers.user_id': 'moved separately (part of the primary key)',
  'audit_log.actor_id': 'audit entries stay as they happened',
  'imports.created_by_id': 'imports are started by members',
  'workspace_exports.created_by_id': 'exports are made by admins',
  'api_keys.user_id': 'placeholders never sign in',
  'auth_states.user_id': 'placeholders never sign in',
  'auth_tokens.user_id': 'placeholders never sign in',
  'sessions.user_id': 'placeholders never sign in',
  'mfa_recovery_codes.user_id': 'placeholders never sign in',
  'user_identities.user_id': 'placeholders never sign in',
  'external_accounts.user_id': 'claimed or linked by people themselves',
  'favorites.user_id': 'personal to members',
  'views.owner_id': 'personal to members',
  'notifications.user_id': "placeholders aren't notified",
  'comment_reactions.user_id': "imports bring no reactions, so placeholders don't have any",
  'team_members.user_id': "placeholders aren't members",
  'workspace_members.user_id': "placeholders aren't members",
  'invites.created_by': 'made by members',
  'issue_templates.created_by_id': 'made by members',
  'initiatives.owner_id': 'owned by members',
  'recurring_issues.created_by_id': 'made by members',
  'customers.owner_id': 'owned by members',
  'project_documents.created_by_id': 'written by members',
  'project_documents.updated_by_id': 'written by members',
  'customer_requests.created_by_id': 'added by members and integrations',
  'initiatives.created_by': 'made by members',
  'issue_templates.assignee_id': 'templates only assign members',
  'webhooks.created_by_id': 'made by admins',
  'integrations.created_by_id': 'made by admins',
  'integrations.bot_user_id': 'bots, not placeholders',
  'instance_settings.updated_by': 'changed by instance admins',
};

/**
 * Hands everything a placeholder stands for to a member: what they created, wrote and were
 * assigned (where the member can see the team; elsewhere those issues become unassigned), and
 * their subscriptions. The placeholder is then deleted.
 */
export async function mergePlaceholder(ctx: Ctx, placeholderId: string, userId: string) {
  const [placeholder] = await ctx.tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.id, placeholderId), ofWorkspace(ctx.workspaceId)));
  if (!placeholder) throw notFound('Placeholder');
  const [member] = await ctx.tx
    .select({ id: users.id, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, userId),
        eq(users.kind, 'human'),
      ),
    );
  if (!member) throw badRequest('Pick a member of this workspace');

  // A people-level rewrite, not an issue change: no history entries, nobody notified.
  const assigned = await ctx.tx
    .select({ id: issues.id, teamId: issues.teamId })
    .from(issues)
    .where(eq(issues.assigneeId, placeholder.id));
  const visible = new Set<string>();
  for (const teamId of new Set(assigned.map((a) => a.teamId))) {
    const [ok] = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, teamId, [member.id]);
    if (ok) visible.add(teamId);
  }
  const keep = assigned.filter((a) => visible.has(a.teamId)).map((a) => a.id);
  const drop = assigned.filter((a) => !visible.has(a.teamId)).map((a) => a.id);
  if (keep.length)
    await ctx.tx.update(issues).set({ assigneeId: member.id }).where(inArray(issues.id, keep));
  if (drop.length)
    await ctx.tx.update(issues).set({ assigneeId: null }).where(inArray(issues.id, drop));

  for (const column of MERGED_COLUMNS) {
    await ctx.tx.execute(
      sql`update ${column.table} set ${sql.identifier(column.name)} = ${member.id} where ${column} = ${placeholder.id}`,
    );
  }
  await ctx.tx.execute(sql`
    insert into issue_subscribers (issue_id, user_id)
    select issue_id, ${member.id} from issue_subscribers where user_id = ${placeholder.id}
    on conflict do nothing`);
  // Running the import again maps the person to the member now.
  await ctx.tx
    .update(importItems)
    .set({ entityId: member.id })
    .where(and(eq(importItems.kind, 'user'), eq(importItems.entityId, placeholder.id)));
  await ctx.tx.delete(users).where(eq(users.id, placeholder.id));

  await auditCtx(ctx, {
    action: 'placeholder.merged',
    targetType: 'user',
    targetId: member.id,
    data: { placeholder: placeholder.name, member: member.name, unassigned: drop.length },
  });
  emit(ctx, { kind: 'member', action: 'updated', id: member.id });
  emit(ctx, { kind: 'issue', action: 'updated', id: placeholder.id });
  return { assigned: keep.length, unassigned: drop.length };
}
