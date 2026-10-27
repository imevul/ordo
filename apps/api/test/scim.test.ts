import type { Bootstrap } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, teamMembers, users, workspaceMembers } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let wsId: string;
let teamId: string;
let token: string;
const slug = `scim-${Date.now()}`;
const ws = `/api/w/${slug}`;
const domain = `${slug}.test`;
const other = `other-${slug}.test`;
let n = 0;

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

async function verify(client: Client, base: string, name: string) {
  const added = (await client.post(`${base}/domains`, { domain: name })).data;
  app.resolveTxt = async () => [[`ordo-verify=${added.verificationToken}`]];
  expect((await client.post(`${base}/domains/${added.id}/verify`)).statusCode).toBe(200);
}

beforeAll(async () => {
  app = await testApp({ settingsFromEnv: { signupMode: 'open' } });
  owner = (await signup(app, 'Scim Owner')).client;
  await owner.post('/api/workspaces', { name: 'Hooli', slug, teamName: 'Core', teamKey: 'COR' });
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  wsId = boot.workspace.id;
  teamId = boot.teams[0]!.id;
  await verify(owner, ws, domain);
  await verify(owner, ws, other);
  token = (await owner.post(`${ws}/scim/tokens`, { name: 'Okta' })).data.token;
});
afterAll(() => app.close());

const scim = (method: string, path: string, body?: unknown, bearer = token) =>
  app.inject({
    method: method as 'GET',
    url: `/api/scim/v2${path}`,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body !== undefined && { 'content-type': 'application/scim+json' }),
    },
    ...(body !== undefined && { payload: JSON.stringify(body) }),
  });
const json = (res: { body: string }) => JSON.parse(res.body);

/** What Okta posts when someone is assigned the app. */
const oktaUser = (local: string, extra: Record<string, unknown> = {}) => {
  const email = `${local}-${++n}@${domain}`;
  return {
    schemas: [USER],
    userName: email,
    name: { givenName: 'Gavin', familyName: `Belson${n}` },
    emails: [{ primary: true, value: email, type: 'work' }],
    displayName: `Gavin Belson${n}`,
    locale: 'en-US',
    externalId: `00u${n}abcdEFGH`,
    groups: [],
    password: 'ignored-by-ordo',
    active: true,
    ...extra,
  };
};

const member = async (userId: string) => {
  const [row] = await app.db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, userId)));
  return row ?? null;
};

const provision = async (local: string, extra: Record<string, unknown> = {}) => {
  const body = oktaUser(local, extra);
  const res = await scim('POST', '/Users', body);
  expect(res.statusCode).toBe(201);
  return { body, user: json(res) };
};

describe('tokens', () => {
  it('are admin-only, shown once, and scoped to their workspace both ways', async () => {
    const list = (await owner.get(`${ws}/scim/tokens`)).data;
    expect(list.baseUrl).toBe(`${app.env.publicUrl}/api/scim/v2`);
    expect(list.tokens[0]).toMatchObject({ name: 'Okta', createdBy: 'Scim Owner' });
    expect(JSON.stringify(list)).not.toContain(token);

    // Another workspace with its own token sees nothing of this one.
    const rival = (await signup(app, 'Rival Owner')).client;
    const rivalSlug = `${slug}-rival`;
    await rival.post('/api/workspaces', {
      name: 'Rival',
      slug: rivalSlug,
      teamName: 'R',
      teamKey: 'RIV',
    });
    const rivalToken = (await rival.post(`/api/w/${rivalSlug}/scim/tokens`, { name: 'x' })).data
      .token;
    const { user } = await provision('scoped');
    expect((await scim('GET', `/Users/${user.id}`, undefined, rivalToken)).statusCode).toBe(404);
    expect(json(await scim('GET', '/Users', undefined, rivalToken)).totalResults).toBe(0);
    const rivalMember = await scim('POST', '/Users', oktaUser('rival'), rivalToken);
    expect(rivalMember.statusCode).toBe(400);

    const { client: plain } = await signup(app, 'Plain Member');
    expect((await plain.post(`${ws}/scim/tokens`, { name: 'nope' })).statusCode).toBe(404);
  });

  it("aren't API keys, and API keys aren't SCIM tokens", async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
    const apiKey = (await owner.post('/api/me/api-keys', { name: 'k' })).data.token;
    const res = await scim('GET', '/Users', undefined, apiKey);
    expect(res.statusCode).toBe(401);
    expect(json(res)).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
    });
  });

  it('stop working when deleted', async () => {
    const extra = (await owner.post(`${ws}/scim/tokens`, { name: 'Temp' })).data;
    expect((await scim('GET', '/Users', undefined, extra.token)).statusCode).toBe(200);
    await owner.del(`${ws}/scim/tokens/${extra.id}`);
    expect((await scim('GET', '/Users', undefined, extra.token)).statusCode).toBe(401);
  });
});

describe('discovery', () => {
  it('describes the service', async () => {
    const config = json(await scim('GET', '/ServiceProviderConfig'));
    expect(config).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
    const types = json(await scim('GET', '/ResourceTypes'));
    expect(types.Resources.map((r: { id: string }) => r.id)).toContain('User');
    const schemas = json(await scim('GET', '/Schemas'));
    expect(schemas.Resources[0].id).toBe(USER);
  });
});

describe('users', () => {
  it('provisions the way Okta does: look up, create, then find', async () => {
    const body = oktaUser('okta');
    const before = json(
      await scim(
        'GET',
        `/Users?filter=${encodeURIComponent(`userName eq "${body.userName}"`)}&startIndex=1&count=100`,
      ),
    );
    expect(before).toMatchObject({ totalResults: 0, Resources: [] });
    const res = await scim('POST', '/Users', body);
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toContain('application/scim+json');
    const created = json(res);
    expect(created).toMatchObject({
      userName: body.userName,
      displayName: body.displayName,
      externalId: body.externalId,
      active: true,
      emails: [{ value: body.userName, primary: true }],
    });
    const [account] = await app.db.select().from(users).where(eq(users.id, created.id));
    expect(account).toMatchObject({ passwordHash: null, name: body.displayName });
    expect(account!.emailVerifiedAt).not.toBeNull();
    expect((await member(created.id))!.role).toBe('member');
    const found = json(
      await scim(
        'GET',
        `/Users?filter=${encodeURIComponent(`userName eq "${body.userName.toUpperCase()}"`)}`,
      ),
    );
    expect(found.Resources.map((r: { id: string }) => r.id)).toEqual([created.id]);
    expect((await scim('POST', '/Users', body)).statusCode).toBe(409);
  });

  it('joins with the default role chosen in settings', async () => {
    await owner.patch(`${ws}/`, { settings: { scimDefaultRole: 'guest' } });
    const { user } = await provision('guest');
    expect((await member(user.id))!.role).toBe('guest');
    await owner.patch(`${ws}/`, { settings: { scimDefaultRole: 'member' } });
  });

  it('only at verified domains, and links people who already have an account', async () => {
    const outside = oktaUser('outside', { userName: `someone-${++n}@elsewhere.example` });
    outside.emails = [{ primary: true, value: outside.userName, type: 'work' }];
    const refused = await scim('POST', '/Users', outside);
    expect(refused.statusCode).toBe(400);
    expect(json(refused).scimType).toBe('invalidValue');

    // An account from before, not yet in this workspace.
    const email = `existing-${++n}@${domain}`;
    const { client } = await signup(app, 'Existing Person');
    const [me] = await app.db
      .select()
      .from(users)
      .where(eq(users.email, (await client.get('/api/auth/me')).data.email));
    await app.db.update(users).set({ email }).where(eq(users.id, me!.id));
    const linked = await scim('POST', '/Users', {
      ...oktaUser('x'),
      userName: email,
      emails: [{ value: email, primary: true }],
    });
    expect(linked.statusCode).toBe(201);
    expect(json(linked).id).toBe(me!.id);
    expect(await member(me!.id)).not.toBeNull();
  });

  it("lists members at the workspace's domains, but not others", async () => {
    const all = json(await scim('GET', '/Users?count=200'));
    const names = all.Resources.map((r: { userName: string }) => r.userName);
    expect(names.every((u: string) => u.endsWith(domain) || u.endsWith(other))).toBe(true);
    // The owner signed up at example.com, which this workspace doesn't verify.
    expect(names.some((u: string) => u.endsWith('@example.com'))).toBe(false);
  });

  it('pages and filters', async () => {
    for (let i = 0; i < 3; i++) await provision('page');
    const total = json(await scim('GET', '/Users?count=0')).totalResults;
    expect(total).toBeGreaterThanOrEqual(3);
    const page = json(await scim('GET', '/Users?startIndex=2&count=2'));
    expect(page).toMatchObject({ startIndex: 2, itemsPerPage: 2, totalResults: total });
    const { body, user } = await provision('filters');
    const q = (f: string) => scim('GET', `/Users?filter=${encodeURIComponent(f)}`);
    for (const f of [
      `externalId eq "${body.externalId}"`,
      `emails[type eq "work"].value eq "${body.userName}"`,
      `emails.value eq "${body.userName}"`,
      `userName eq "${body.userName}" and externalId eq "${body.externalId}"`,
      `id eq "${user.id}"`,
    ])
      expect(
        json(await q(f)).Resources.map((r: { id: string }) => r.id),
        f,
      ).toEqual([user.id]);
    expect(
      json(await q(`userName eq "${body.userName}" and externalId eq "nope"`)).totalResults,
    ).toBe(0);
    const bad = await q('name.familyName co "Bel"');
    expect(bad.statusCode).toBe(400);
    expect(json(bad).scimType).toBe('invalidFilter');
  });
});

describe('updates in each dialect', () => {
  it("Entra's capitalised ops, path-less values and string booleans", async () => {
    const { user } = await provision('entra');
    const off = await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [{ op: 'Replace', value: { active: 'False' } }],
    });
    expect(off.statusCode).toBe(200);
    expect(json(off).active).toBe(false);
    expect((await member(user.id))!.suspendedAt).not.toBeNull();
    const on = await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [{ op: 'Replace', path: 'active', value: 'True' }],
    });
    expect(json(on).active).toBe(true);
    expect((await member(user.id))!.suspendedAt).toBeNull();
  });

  it("Entra's attribute paths: names, work email, externalId", async () => {
    const { user } = await provision('paths');
    const email = `renamed-${++n}@${other}`;
    const res = await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [
        { op: 'Add', path: 'displayName', value: 'Richard Hendricks' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: email },
        { op: 'Replace', path: 'externalId', value: 'entra-object-id' },
        {
          op: 'Add',
          path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
          value: 'Engineering',
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({
      displayName: 'Richard Hendricks',
      userName: email,
      externalId: 'entra-object-id',
    });
    const outside = await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [{ op: 'Replace', path: 'userName', value: `x-${++n}@elsewhere.example` }],
    });
    expect(outside.statusCode).toBe(400);
  });

  it("Okta's path-less replace and full PUT", async () => {
    const { body, user } = await provision('oktaput');
    const off = await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [{ op: 'replace', value: { active: false } }],
    });
    expect(json(off).active).toBe(false);
    const put = await scim('PUT', `/Users/${user.id}`, {
      ...body,
      id: user.id,
      name: { givenName: 'Gavin', familyName: 'Belson', formatted: 'Gavin Belson' },
      displayName: undefined,
      active: true,
    });
    expect(put.statusCode).toBe(200);
    expect(json(put)).toMatchObject({ displayName: 'Gavin Belson', active: true });
  });

  it('refuses unknown operations', async () => {
    const { user } = await provision('badop');
    const res = await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [{ op: 'move', path: 'active', value: false }],
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).scimType).toBe('invalidSyntax');
  });
});

describe('lifecycle', () => {
  it('deletes by removing the membership and team places, not the account', async () => {
    const { user } = await provision('leaver');
    await owner.post(`${ws}/teams/${teamId}/members`, { userId: user.id, role: 'member' });
    const [onTeam] = await app.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)));
    expect(onTeam).toBeDefined();
    expect((await scim('DELETE', `/Users/${user.id}`)).statusCode).toBe(204);
    expect(await member(user.id)).toBeNull();
    const left = await app.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)));
    expect(left).toEqual([]);
    const [account] = await app.db.select().from(users).where(eq(users.id, user.id));
    expect(account).toBeDefined();
    expect((await scim('GET', `/Users/${user.id}`)).statusCode).toBe(404);
  });

  it('never suspends or removes an owner', async () => {
    const { user } = await provision('boss');
    await owner.patch(`${ws}/members/${user.id}`, { role: 'owner' });
    const off = await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(off.statusCode).toBe(403);
    expect(json(off).scimType).toBe('mutability');
    expect((await scim('DELETE', `/Users/${user.id}`)).statusCode).toBe(403);
    expect((await member(user.id))!.role).toBe('owner');
  });

  it('is audited as the Directory sync bot', async () => {
    const { user } = await provision('audited');
    await scim('PATCH', `/Users/${user.id}`, {
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    const [row] = await app.db
      .select({ actor: users.name, data: auditLog.data })
      .from(auditLog)
      .innerJoin(users, eq(users.id, auditLog.actorId))
      .where(and(eq(auditLog.action, 'member.suspended'), eq(auditLog.targetId, user.id)));
    expect(row).toEqual({ actor: 'Directory sync', data: { via: 'scim' } });
  });
});

describe('groups', () => {
  const team = async (name: string) => {
    const key = name.slice(0, 3).toUpperCase() + String(++n).padStart(2, '0');
    const res = await owner.post(`${ws}/teams`, { name, key });
    expect(res.statusCode).toBe(200);
    return res.data.id as string;
  };
  const teamMembersOf = async (id: string) =>
    (
      await app.db
        .select({ id: teamMembers.userId })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, id))
    )
      .map((r) => r.id)
      .sort();
  const group = async (displayName: string, members: string[] = []) => {
    const res = await scim('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName,
      members: members.map((value) => ({ value, display: value })),
    });
    expect(res.statusCode).toBe(201);
    return json(res);
  };
  const patch = (id: string, Operations: unknown[]) =>
    scim('PATCH', `/Groups/${id}`, { schemas: [PATCH], Operations });

  it("mirror the directory's groups: create, filter, rename, members in each dialect", async () => {
    const a = (await provision('ga')).user.id;
    const b = (await provision('gb')).user.id;
    const c = (await provision('gc')).user.id;
    const g = await group(`Engineers ${n}`, [a, '00000000-0000-4000-8000-000000000000']);
    // Unknown member ids are ignored.
    expect(g.members.map((m: { value: string }) => m.value)).toEqual([a]);

    const found = json(
      await scim(
        'GET',
        `/Groups?filter=${encodeURIComponent(`displayName eq "${g.displayName}"`)}&excludedAttributes=members`,
      ),
    );
    expect(found.Resources).toHaveLength(1);
    expect(found.Resources[0].members).toBeUndefined();

    // Entra: add and remove with lists, rename without a path.
    await patch(g.id, [{ op: 'Add', path: 'members', value: [{ value: b }, { value: c }] }]);
    await patch(g.id, [{ op: 'Remove', path: 'members', value: [{ value: a }] }]);
    await patch(g.id, [{ op: 'Replace', value: { id: g.id, displayName: 'Engineering' } }]);
    let now = json(await scim('GET', `/Groups/${g.id}`));
    expect(now.displayName).toBe('Engineering');
    expect(now.members.map((m: { value: string }) => m.value).sort()).toEqual([b, c].sort());

    // Okta: remove by filter, replace the list.
    await patch(g.id, [{ op: 'remove', path: `members[value eq "${b}"]` }]);
    now = json(await scim('GET', `/Groups/${g.id}`));
    expect(now.members.map((m: { value: string }) => m.value)).toEqual([c]);
    await patch(g.id, [{ op: 'replace', path: 'members', value: [{ value: a }] }]);
    now = json(await scim('GET', `/Groups/${g.id}`));
    expect(now.members.map((m: { value: string }) => m.value)).toEqual([a]);

    expect((await scim('DELETE', `/Groups/${g.id}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Groups/${g.id}`)).statusCode).toBe(404);
  });

  it('decide who is on a linked team, after the admin sees what changes', async () => {
    const a = (await provision('la')).user.id;
    const b = (await provision('lb')).user.id;
    const teamId = await team(`Platform ${n}`);
    const ownerId = (await owner.get('/api/auth/me')).data.id;
    const g = await group(`platform-${n}`, [a, b]);

    const preview = (await owner.post(`${ws}/scim/groups/${g.id}/preview`, { teamId })).data;
    expect(preview.add.map((p: { id: string }) => p.id).sort()).toEqual([a, b].sort());
    expect(preview.remove.map((p: { id: string }) => p.id)).toEqual([ownerId]);

    expect((await owner.put(`${ws}/scim/groups/${g.id}/team`, { teamId })).statusCode).toBe(200);
    expect(await teamMembersOf(teamId)).toEqual([a, b].sort());
    const listed = (await owner.get(`${ws}/scim/groups`)).data;
    expect(listed.find((x: { id: string }) => x.id === g.id)).toMatchObject({
      teamId,
      memberCount: 2,
    });
    const teams = (await owner.get(`${ws}/teams`)).data as { id: string; managedBy: string[] }[];
    expect(teams.find((t) => t.id === teamId)!.managedBy).toEqual([g.displayName]);

    // Directory changes follow.
    await patch(g.id, [{ op: 'Remove', path: 'members', value: [{ value: b }] }]);
    expect(await teamMembersOf(teamId)).toEqual([a]);

    // By hand: membership is the directory's, roles are still ours.
    const add = await owner.post(`${ws}/teams/${teamId}/members`, { userId: b, role: 'member' });
    expect(add.statusCode).toBe(409);
    expect(add.data.messageKey).toBe('team_managed');
    expect((await owner.del(`${ws}/teams/${teamId}/members/${a}`)).statusCode).toBe(409);
    expect(
      (await owner.patch(`${ws}/teams/${teamId}/members/${a}`, { role: 'admin' })).statusCode,
    ).toBe(200);

    // A second group adds its people; unlinking leaves the team as it is.
    const g2 = await group(`platform-extra-${n}`, [b]);
    await owner.put(`${ws}/scim/groups/${g2.id}/team`, { teamId });
    expect(await teamMembersOf(teamId)).toEqual([a, b].sort());
    await owner.put(`${ws}/scim/groups/${g2.id}/team`, { teamId: null });
    expect(await teamMembersOf(teamId)).toEqual([a]);
    await owner.put(`${ws}/scim/groups/${g.id}/team`, { teamId: null });
    expect(await teamMembersOf(teamId)).toEqual([a]);
    expect(
      (await owner.post(`${ws}/teams/${teamId}/members`, { userId: b, role: 'member' })).statusCode,
    ).toBe(200);
  });

  it('link themselves to the team of the same name when asked to', async () => {
    const a = (await provision('na')).user.id;
    const name = `Design ${n}`;
    const teamId = await team(name);
    const unmatched = await group(name.toLowerCase(), [a]);
    expect(
      (await owner.get(`${ws}/scim/groups`)).data.find((x: { id: string }) => x.id === unmatched.id)
        .teamId,
    ).toBeNull();
    await owner.patch(`${ws}/`, { settings: { scimMatchGroupsByName: true } });
    const matched = await group(name.toUpperCase(), [a]);
    expect(
      (await owner.get(`${ws}/scim/groups`)).data.find((x: { id: string }) => x.id === matched.id)
        .teamId,
    ).toBe(teamId);
    expect(await teamMembersOf(teamId)).toEqual([a]);
    await owner.patch(`${ws}/`, { settings: { scimMatchGroupsByName: false } });
  });

  it('stay in their workspace', async () => {
    const g = await group(`private-${n}`);
    const rival = (await signup(app, 'Group Rival')).client;
    const rivalSlug = `${slug}-groups`;
    await rival.post('/api/workspaces', {
      name: 'R',
      slug: rivalSlug,
      teamName: 'R',
      teamKey: 'RGR',
    });
    const rivalToken = (await rival.post(`/api/w/${rivalSlug}/scim/tokens`, { name: 'x' })).data
      .token;
    expect((await scim('GET', `/Groups/${g.id}`, undefined, rivalToken)).statusCode).toBe(404);
    expect(
      (await rival.put(`/api/w/${rivalSlug}/scim/groups/${g.id}/team`, { teamId: null }))
        .statusCode,
    ).toBe(404);
  });
});
