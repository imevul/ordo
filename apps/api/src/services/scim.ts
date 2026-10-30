import { AVATAR_COLORS, type ScimToken } from '@ordo/shared';
import { and, asc, count, eq, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import {
  scimTokens,
  scimUsers,
  users,
  workspaceDomains,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { SCIM_TOKEN_PREFIX } from '../lib/auth.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { one } from '../lib/errors.ts';
import { auditCtx } from './audit.ts';
import type { Ctx } from './context.ts';
import { removeMember, setSuspended } from './members.ts';
import { domainVerifiedFor, uniqueUsername } from './sso.ts';
import { joinWorkspace, workspaceSettings } from './workspaces.ts';

/**
 * SCIM 2.0 (RFC 7643/7644): the workspace's identity provider keeps its members in step with the
 * directory. A token belongs to one workspace and acts as that workspace's "Directory sync" bot.
 *
 * What a directory may touch: people at the workspace's verified domains, and anyone it
 * provisioned. It can create accounts only at verified domains, change someone's name or email
 * only when both addresses are on verified domains (accounts are shared between workspaces), and
 * never suspend or remove an owner.
 */

export const SCIM_SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

/** An error in SCIM's own shape; `scimType` is one of RFC 7644 §3.12's keywords. */
export class ScimError extends Error {
  constructor(
    public status: number,
    message: string,
    public scimType?: string,
  ) {
    super(message);
  }
}

// ─── tokens ──────────────────────────────────────────────────────────────

export const toScimToken = (
  row: typeof scimTokens.$inferSelect,
  createdBy: string | null = null,
): ScimToken => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdBy,
  lastUsedAt: row.lastUsedAt,
  createdAt: row.createdAt,
});

export async function createScimToken(ctx: Ctx, name: string) {
  const token = `${SCIM_TOKEN_PREFIX}${randomToken(30)}`;
  const row = one(
    await ctx.tx
      .insert(scimTokens)
      .values({
        workspaceId: ctx.workspaceId,
        name,
        tokenHash: sha256(token),
        prefix: token.slice(0, SCIM_TOKEN_PREFIX.length + 4),
        createdById: ctx.userId,
      })
      .returning(),
  );
  await auditCtx(ctx, {
    action: 'scim.token_created',
    targetType: 'scim_token',
    targetId: row.id,
    data: { name },
  });
  return { token, row };
}

/** The workspace a token provisions, or null. Marks it used (at most once a minute). */
export async function scimTokenWorkspace(db: DbOrTx, token: string) {
  if (!token.startsWith(SCIM_TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({
      id: scimTokens.id,
      workspaceId: scimTokens.workspaceId,
      lastUsedAt: scimTokens.lastUsedAt,
    })
    .from(scimTokens)
    .where(eq(scimTokens.tokenHash, sha256(token)));
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > 60_000)
    db.update(scimTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(scimTokens.id, row.id))
      .catch(() => {});
  return row;
}

/** The workspace's "Directory sync" bot, created on first use; SCIM changes are its doing. */
export async function directoryBot(db: DbOrTx, workspaceId: string): Promise<string> {
  const email = `scim-${workspaceId}@bots.ordo.invalid`;
  const [found] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), eq(users.kind, 'bot')));
  if (found) return found.id;
  const [bot] = await db
    .insert(users)
    .values({
      kind: 'bot',
      botWorkspaceId: workspaceId,
      email,
      name: 'Directory sync',
      username: `scim-${workspaceId.slice(0, 8)}`,
      passwordHash: null,
      avatarColor: AVATAR_COLORS[2]!,
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  return bot?.id ?? directoryBot(db, workspaceId);
}

// ─── users ───────────────────────────────────────────────────────────────

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  createdAt: users.createdAt,
  role: workspaceMembers.role,
  suspendedAt: workspaceMembers.suspendedAt,
  joinedAt: workspaceMembers.joinedAt,
  scimId: scimUsers.id,
  externalId: scimUsers.externalId,
  updatedAt: scimUsers.updatedAt,
};
type UserRow = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  role: string;
  suspendedAt: string | null;
  joinedAt: string;
  scimId: string | null;
  externalId: string | null;
  updatedAt: string | null;
};

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

/** Members the directory may see: provisioned by it, or at one of the verified domains. */
export function visible(ctx: Ctx) {
  const verified = ctx.tx
    .select({ domain: workspaceDomains.domain })
    .from(workspaceDomains)
    .where(
      and(
        eq(workspaceDomains.workspaceId, ctx.workspaceId),
        isNotNull(workspaceDomains.verifiedAt),
      ),
    );
  return and(
    eq(workspaceMembers.workspaceId, ctx.workspaceId),
    eq(users.kind, 'human'),
    or(isNotNull(scimUsers.id), inArray(sql`lower(split_part(${users.email}, '@', 2))`, verified)),
  );
}

const selectUsers = (ctx: Ctx) =>
  ctx.tx
    .select(userColumns)
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .leftJoin(
      scimUsers,
      and(eq(scimUsers.workspaceId, workspaceMembers.workspaceId), eq(scimUsers.userId, users.id)),
    );

export function toScimUser(row: UserRow, baseUrl: string) {
  return {
    schemas: [SCIM_SCHEMA.user],
    id: row.id,
    ...(row.externalId && { externalId: row.externalId }),
    userName: row.email,
    name: { formatted: row.name },
    displayName: row.name,
    emails: [{ value: row.email, type: 'work', primary: true }],
    active: !row.suspendedAt,
    meta: {
      resourceType: 'User',
      created: row.joinedAt,
      lastModified: row.updatedAt ?? row.joinedAt,
      location: `${baseUrl}/Users/${row.id}`,
    },
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The filters identity providers send: `attribute eq "value"`, joined by `and`. Attribute names
 * are case-insensitive (RFC 7643 §2.1), and so is userName.
 */
function userFilter(filter: string | undefined): SQL[] {
  if (!filter?.trim()) return [];
  const clauses = filter.split(/\s+and\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/i);
  return clauses.map((clause) => {
    const m = /^\s*([\w.:]+(?:\[[^\]]*\])?(?:\.value)?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(
      clause,
    );
    if (!m) throw new ScimError(400, `Unsupported filter: ${clause}`, 'invalidFilter');
    const attr = m[1]!.toLowerCase();
    const value = m[2]!.replace(/\\(.)/g, '$1');
    if (attr === 'username' || attr.startsWith('emails'))
      return sql`lower(${users.email}) = ${value.toLowerCase()}`;
    if (attr === 'externalid') return eq(scimUsers.externalId, value);
    if (attr === 'id') return UUID.test(value) ? eq(users.id, value) : sql`false`;
    throw new ScimError(400, `Unsupported filter attribute: ${m[1]}`, 'invalidFilter');
  });
}

export async function listScimUsers(
  ctx: Ctx,
  baseUrl: string,
  q: { filter?: string; startIndex?: string; count?: string },
) {
  const where = and(visible(ctx), ...userFilter(q.filter));
  const startIndex = Math.max(1, Number(q.startIndex) || 1);
  const pageSize = Math.min(200, Math.max(0, q.count === undefined ? 100 : Number(q.count) || 0));
  const [{ total }] = (await ctx.tx
    .select({ total: count() })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .leftJoin(
      scimUsers,
      and(eq(scimUsers.workspaceId, workspaceMembers.workspaceId), eq(scimUsers.userId, users.id)),
    )
    .where(where)) as [{ total: number }];
  const rows = pageSize
    ? await selectUsers(ctx)
        .where(where)
        .orderBy(asc(workspaceMembers.joinedAt), asc(users.id))
        .limit(pageSize)
        .offset(startIndex - 1)
    : [];
  return {
    schemas: [SCIM_SCHEMA.list],
    totalResults: total,
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((r) => toScimUser(r, baseUrl)),
  };
}

async function loadUser(ctx: Ctx, id: string) {
  if (!UUID.test(id)) throw new ScimError(404, 'User not found');
  const [row] = await selectUsers(ctx).where(and(visible(ctx), eq(users.id, id)));
  if (!row) throw new ScimError(404, 'User not found');
  return row;
}

export const getScimUser = async (ctx: Ctx, baseUrl: string, id: string) =>
  toScimUser(await loadUser(ctx, id), baseUrl);

/** What a SCIM request wants changed about a user, whatever shape it came in. */
interface UserChanges {
  email?: string;
  displayName?: string;
  formatted?: string;
  givenName?: string;
  familyName?: string;
  externalId?: string | null;
  active?: boolean;
}

const str = (v: unknown, attr: string) => {
  if (typeof v !== 'string') throw new ScimError(400, `${attr} must be a string`, 'invalidValue');
  return v.trim();
};

/** Entra sends booleans as "True"/"False". */
const bool = (v: unknown, attr: string) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  throw new ScimError(400, `${attr} must be a boolean`, 'invalidValue');
};

/** The primary (else the first) address from an `emails` value, or a bare address string. */
function emailFrom(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const entries = list.filter(
    (e): e is { value: string; primary?: unknown } =>
      !!e && typeof e === 'object' && typeof (e as { value?: unknown }).value === 'string',
  );
  const primary = entries.find((e) => e.primary === true || e.primary === 'true') ?? entries[0];
  return primary?.value.trim();
}

/** Applies one attribute (a top-level name or a PATCH path) to the changes. */
function applyAttribute(changes: UserChanges, path: string, value: unknown, remove = false) {
  const p = path.toLowerCase();
  // Extension schemas (enterprise: department, manager…) aren't kept.
  if (p.startsWith('urn:') && !p.startsWith(SCIM_SCHEMA.user.toLowerCase())) return;
  const attr = p.startsWith(`${SCIM_SCHEMA.user.toLowerCase()}:`)
    ? p.slice(SCIM_SCHEMA.user.length + 1)
    : p;
  if (attr === 'active') {
    if (!remove) changes.active = bool(value, 'active');
  } else if (attr === 'username') {
    if (!remove) changes.email = str(value, 'userName');
  } else if (attr === 'displayname') {
    if (!remove) changes.displayName = str(value, 'displayName');
  } else if (attr === 'externalid') {
    changes.externalId = remove ? null : str(value, 'externalId');
  } else if (attr === 'name') {
    if (remove || !value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) applyAttribute(changes, `name.${k}`, v);
  } else if (attr === 'name.formatted') {
    if (!remove) changes.formatted = str(value, 'name.formatted');
  } else if (attr === 'name.givenname') {
    if (!remove) changes.givenName = str(value, 'name.givenName');
  } else if (attr === 'name.familyname') {
    if (!remove) changes.familyName = str(value, 'name.familyName');
  } else if (attr.startsWith('emails')) {
    // emails, emails[type eq "work"].value, emails[primary eq true].value
    const email = remove ? undefined : emailFrom(value);
    if (email) changes.email = email;
  }
  // Anything else (title, phoneNumbers, locale…) isn't something Ordo keeps.
}

/** A full User resource (POST, PUT) as changes. */
function resourceChanges(body: unknown): UserChanges {
  if (!body || typeof body !== 'object')
    throw new ScimError(400, 'Expected a User', 'invalidSyntax');
  const changes: UserChanges = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'schemas' || k === 'id' || k === 'meta') continue;
    applyAttribute(changes, k, v);
  }
  return changes;
}

/**
 * PATCH operations as changes, in each vendor's dialect: `Replace` capitalised (Entra), no path
 * with an object of attributes (Okta, Entra), paths into names and emails, string booleans.
 */
function patchChanges(body: unknown): UserChanges {
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops)) throw new ScimError(400, 'Expected Operations', 'invalidSyntax');
  const changes: UserChanges = {};
  for (const op of ops as { op?: unknown; path?: unknown; value?: unknown }[]) {
    const kind = typeof op?.op === 'string' ? op.op.toLowerCase() : '';
    if (!['add', 'replace', 'remove'].includes(kind))
      throw new ScimError(400, `Unsupported operation: ${String(op?.op)}`, 'invalidSyntax');
    const remove = kind === 'remove';
    if (typeof op.path === 'string' && op.path) applyAttribute(changes, op.path, op.value, remove);
    else if (op.value && typeof op.value === 'object' && !Array.isArray(op.value))
      for (const [k, v] of Object.entries(op.value)) applyAttribute(changes, k, v, remove);
    else throw new ScimError(400, 'An operation without a path needs an object value', 'noTarget');
  }
  return changes;
}

const nameFrom = (c: UserChanges) =>
  c.displayName ||
  c.formatted ||
  (c.givenName && c.familyName ? `${c.givenName} ${c.familyName}` : undefined) ||
  undefined;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function attach(ctx: Ctx, userId: string, externalId: string | null | undefined) {
  await ctx.tx
    .insert(scimUsers)
    .values({ workspaceId: ctx.workspaceId, userId, externalId: externalId ?? null })
    .onConflictDoUpdate({
      target: [scimUsers.workspaceId, scimUsers.userId],
      set: {
        ...(externalId !== undefined && { externalId }),
        updatedAt: new Date().toISOString(),
      },
    });
}

/** POST /Users: creates the account if needed, adds it to the workspace and links it. */
export async function createScimUser(ctx: Ctx, baseUrl: string, body: unknown) {
  const changes = resourceChanges(body);
  const email = changes.email?.toLowerCase();
  if (!email || !EMAIL.test(email))
    throw new ScimError(400, 'userName must be an email address', 'invalidValue');
  if (!(await domainVerifiedFor(ctx.tx, ctx.workspaceId, email)))
    throw new ScimError(
      400,
      `${domainOf(email)} isn't a verified domain of this workspace`,
      'invalidValue',
    );

  let [user] = await ctx.tx
    .select({ id: users.id, kind: users.kind })
    .from(users)
    .where(eq(users.email, email));
  if (user && user.kind !== 'human')
    throw new ScimError(409, 'That address belongs to a bot', 'uniqueness');
  const meta = { via: 'scim' };
  if (!user) {
    const local = email.split('@')[0]!;
    [user] = await ctx.tx
      .insert(users)
      .values({
        email,
        name: nameFrom(changes) || local,
        username: await uniqueUsername(ctx.tx, local),
        passwordHash: null,
        emailVerifiedAt: new Date().toISOString(),
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
      })
      .returning({ id: users.id, kind: users.kind });
    await auditCtx(ctx, {
      action: 'auth.signup',
      targetType: 'user',
      targetId: user!.id,
      data: meta,
    });
  }
  const userId = user!.id;
  const [member] = await ctx.tx
    .select({ role: workspaceMembers.role, scimId: scimUsers.id })
    .from(workspaceMembers)
    .leftJoin(
      scimUsers,
      and(eq(scimUsers.workspaceId, workspaceMembers.workspaceId), eq(scimUsers.userId, userId)),
    )
    .where(
      and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)),
    );
  if (member?.scimId) throw new ScimError(409, 'That user is already provisioned', 'uniqueness');
  if (!member) {
    const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    const role = workspaceSettings(ws!).scimDefaultRole;
    await joinWorkspace(ctx.tx, ctx.workspaceId, userId, role);
    await auditCtx(ctx, {
      action: 'member.joined',
      targetType: 'user',
      targetId: userId,
      data: { role, ...meta },
    });
  }
  await attach(ctx, userId, changes.externalId);
  if (changes.active === false) {
    if (member?.role === 'owner')
      throw new ScimError(403, "Owners can't be suspended", 'mutability');
    await setSuspended(ctx, userId, true);
  }
  return toScimUser(await loadUser(ctx, userId), baseUrl);
}

/** PUT and PATCH: the same rules, from a whole resource or from operations. */
export async function updateScimUser(
  ctx: Ctx,
  baseUrl: string,
  id: string,
  body: unknown,
  kind: 'put' | 'patch',
) {
  const row = await loadUser(ctx, id);
  const changes = kind === 'put' ? resourceChanges(body) : patchChanges(body);
  const owner = row.role === 'owner';
  if (changes.active === false && owner)
    throw new ScimError(403, "Owners can't be suspended from the directory", 'mutability');

  const ownDomain = await domainVerifiedFor(ctx.tx, ctx.workspaceId, row.email);
  const email = changes.email?.toLowerCase();
  if (email && email !== row.email) {
    if (!EMAIL.test(email))
      throw new ScimError(400, 'userName must be an email address', 'invalidValue');
    if (!ownDomain || !(await domainVerifiedFor(ctx.tx, ctx.workspaceId, email)))
      throw new ScimError(
        400,
        'Email addresses change only between verified domains of this workspace',
        'invalidValue',
      );
    const [taken] = await ctx.tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken) throw new ScimError(409, 'Another account uses that address', 'uniqueness');
    await ctx.tx
      .update(users)
      .set({ email, emailVerifiedAt: new Date().toISOString() })
      .where(eq(users.id, id));
    await auditCtx(ctx, {
      action: 'auth.email_changed',
      targetType: 'user',
      targetId: id,
      data: { via: 'scim' },
    });
  }
  // Names are global too: only for people at this workspace's domains.
  const name = nameFrom(changes);
  if (name && name !== row.name && ownDomain)
    await ctx.tx.update(users).set({ name }).where(eq(users.id, id));
  await attach(ctx, id, changes.externalId);
  if (changes.active !== undefined) await setSuspended(ctx, id, !changes.active);
  return toScimUser(await loadUser(ctx, id), baseUrl);
}

/** DELETE /Users/:id: takes them out of the workspace (their account stays). */
export async function deleteScimUser(ctx: Ctx, id: string) {
  const row = await loadUser(ctx, id);
  if (row.role === 'owner')
    throw new ScimError(403, "Owners can't be removed from the directory", 'mutability');
  await removeMember(ctx, id);
  await ctx.tx
    .delete(scimUsers)
    .where(and(eq(scimUsers.workspaceId, ctx.workspaceId), eq(scimUsers.userId, id)));
}

// ─── discovery ───────────────────────────────────────────────────────────

export function serviceProviderConfig(baseUrl: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'A token from Settings → Authentication → Directory sync',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: SCIM_SCHEMA.user,
      meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/User` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: SCIM_SCHEMA.group,
      meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/Group` },
    },
  ];
}

const attribute = (
  name: string,
  extra: Partial<{
    type: string;
    multiValued: boolean;
    required: boolean;
    mutability: string;
    uniqueness: string;
    subAttributes: unknown[];
  }> = {},
) => ({
  name,
  type: 'string',
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

export function schemas(baseUrl: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: SCIM_SCHEMA.user,
      name: 'User',
      description: 'A workspace member',
      attributes: [
        attribute('userName', { required: true, uniqueness: 'server' }),
        attribute('name', {
          type: 'complex',
          subAttributes: [attribute('formatted'), attribute('givenName'), attribute('familyName')],
        }),
        attribute('displayName'),
        attribute('emails', {
          type: 'complex',
          multiValued: true,
          subAttributes: [
            attribute('value'),
            attribute('type'),
            attribute('primary', { type: 'boolean' }),
          ],
        }),
        attribute('active', { type: 'boolean' }),
        attribute('externalId'),
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCIM_SCHEMA.user}` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: SCIM_SCHEMA.group,
      name: 'Group',
      description: 'A directory group; linked to a team, it decides who is on it',
      attributes: [
        attribute('displayName', { required: true }),
        attribute('members', {
          type: 'complex',
          multiValued: true,
          subAttributes: [attribute('value'), attribute('display')],
        }),
        attribute('externalId'),
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCIM_SCHEMA.group}` },
    },
  ];
}
