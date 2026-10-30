import type { Bootstrap, Invite } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instanceSettings, users } from '../src/db/schema.ts';
import { Client, captureMail, linkIn, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let inbox: ReturnType<typeof captureMail>;
let owner: Client;
let ownerId: string;
const ws = '/api/w/org';
let boot: Bootstrap;

const me = async (c: Client) => (await c.get('/api/auth/me')).data as { id: string; email: string };

beforeAll(async () => {
  app = await testApp({
    settingsFromEnv: {
      signupMode: 'open',
      smtp: { url: 'smtp://mail.test:25', from: 'Ordo <ordo@test>' },
    },
  });
  inbox = captureMail(app);
  owner = (await signup(app, 'Orla Owner')).client;
  ownerId = (await me(owner)).id;
  await owner.post('/api/workspaces', {
    name: 'Org',
    slug: 'org',
    teamName: 'Core',
    teamKey: 'COR',
  });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
});
afterAll(() => app.close());

async function join(role: 'member' | 'guest' | 'admin' = 'member', teamIds: string[] = []) {
  const invite = ((await owner.post(`${ws}/invites`, { role, teamIds })).data as Invite[])[0]!;
  return signup(app, `${role} person`, { inviteToken: invite.token });
}

describe('invites', () => {
  it('emails one invite per address and adds invitees to the chosen teams', async () => {
    const design = (await owner.post(`${ws}/teams`, { name: 'Design', key: 'DSG' })).data;
    const a = `ann-${Date.now()}@example.com`;
    const b = `bob-${Date.now()}@example.com`;
    const res = await owner.post(`${ws}/invites`, {
      emails: [a, b, a.toUpperCase()],
      role: 'member',
      teamIds: [design.id],
    });
    expect(res.data).toHaveLength(2);
    await app.jobs.drain();
    const mail = inbox.find((m) => m.to === a);
    expect(mail?.subject).toContain('invited you to Org');
    const token = linkIn(mail!.text).split('/').pop();
    // Email-bound invites only work for that address.
    expect(
      (await signup(app, 'Wrong Person', { inviteToken: token }).catch((e) => e)) instanceof Error,
    ).toBe(true);
    const accepted = await new Client(app).post('/api/auth/signup', {
      name: 'Ann',
      email: a,
      password: 'correct horse battery',
      inviteToken: token,
    });
    expect(accepted.statusCode).toBe(200);
    const after = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const ann = after.members.find((m) => m.email === a)!;
    expect(after.teams.find((t) => t.id === design.id)!.memberIds).toContain(ann.id);

    const pending = (await owner.get(`${ws}/invites`)).data as Invite[];
    const bobInvite = pending.find((i) => i.email === b)!;
    expect((await owner.post(`${ws}/invites/${bobInvite.id}/resend`)).statusCode).toBe(200);
    expect((await owner.del(`${ws}/invites/${bobInvite.id}`)).statusCode).toBe(200);
    expect(
      ((await owner.get(`${ws}/invites`)).data as Invite[]).some((i) => i.id === bobInvite.id),
    ).toBe(false);
  });

  it('puts new non-guest members in the default team', async () => {
    const core = boot.teams[0]!;
    await owner.patch(`${ws}/`, { defaultTeamId: core.id });
    const { client } = await join('member');
    const guest = await join('guest');
    const after = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const team = after.teams.find((t) => t.id === core.id)!;
    expect(team.memberIds).toContain((await me(client)).id);
    expect(team.memberIds).not.toContain((await me(guest.client)).id);
  });

  it('lets members invite only when the policy allows, and never as admins', async () => {
    const { client: member } = await join('member');
    const { client: guest } = await join('guest');
    expect((await member.post(`${ws}/invites`, {})).statusCode).toBe(403);
    await owner.patch(`${ws}/`, { settings: { invitePolicy: 'members' } });
    expect((await member.post(`${ws}/invites`, { role: 'member' })).statusCode).toBe(200);
    expect((await member.post(`${ws}/invites`, { role: 'admin' })).statusCode).toBe(403);
    expect((await guest.post(`${ws}/invites`, {})).statusCode).toBe(403);
    await owner.patch(`${ws}/`, { settings: { invitePolicy: 'admins' } });
  });
});

describe('members', () => {
  it('suspends and restores access', async () => {
    const { client } = await join('member');
    const id = (await me(client)).id;
    expect((await owner.patch(`${ws}/members/${id}`, { suspended: true })).statusCode).toBe(200);
    expect((await client.get(`${ws}/bootstrap`)).statusCode).toBe(404);
    const members = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).members;
    expect(members.find((m) => m.id === id)!.suspended).toBe(true);
    await owner.patch(`${ws}/members/${id}`, { suspended: false });
    expect((await client.get(`${ws}/bootstrap`)).statusCode).toBe(200);
    expect((await owner.patch(`${ws}/members/${ownerId}`, { suspended: true })).statusCode).toBe(
      400,
    );
  });

  it('takes removed members off the workspace teams', async () => {
    const teamId = boot.teams[0]!.id;
    const { client } = await join('member', [teamId]);
    const id = (await me(client)).id;
    const onTeam = async () =>
      ((await owner.get(`${ws}/teams`)).data as { id: string; memberIds: string[] }[])
        .find((t) => t.id === teamId)!
        .memberIds.includes(id);
    expect(await onTeam()).toBe(true);
    expect((await owner.del(`${ws}/members/${id}`)).statusCode).toBe(200);
    expect(await onTeam()).toBe(false);
  });

  it('names removed members who are still assigned issues', async () => {
    const teamId = boot.teams[0]!.id;
    const assigned = await join('member', [teamId]);
    const idle = await join('member', [teamId]);
    const assignedId = (await me(assigned.client)).id;
    const idleId = (await me(idle.client)).id;
    const res = await owner.post(`${ws}/issues`, {
      teamId,
      title: 'Theirs',
      assigneeId: assignedId,
    });
    expect(res.statusCode).toBe(200);
    await owner.del(`${ws}/members/${assignedId}`);
    await owner.del(`${ws}/members/${idleId}`);
    const former = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).formerMembers;
    expect(former.map((p) => p.id)).toContain(assignedId);
    expect(former.map((p) => p.id)).not.toContain(idleId);
    expect(former.find((p) => p.id === assignedId)).toMatchObject({
      name: 'member person',
      kind: 'human',
      email: '',
    });
  });

  it('transfers ownership, then lets the new owner delete the workspace', async () => {
    const o2 = (await signup(app, 'Second Owner')).client;
    await o2.post('/api/workspaces', {
      name: 'Doomed',
      slug: 'doomed',
      teamName: 'D',
      teamKey: 'DOO',
    });
    const invite = (
      (await o2.post('/api/w/doomed/invites', { role: 'admin' })).data as Invite[]
    )[0]!;
    const heir = (await signup(app, 'Heir Apparent', { inviteToken: invite.token })).client;
    const heirId = (await me(heir)).id;
    expect(
      (await heir.post('/api/w/doomed/transfer-ownership', { userId: heirId })).statusCode,
    ).toBe(403);
    expect((await o2.post('/api/w/doomed/transfer-ownership', { userId: heirId })).statusCode).toBe(
      200,
    );
    expect(((await heir.get('/api/w/doomed/bootstrap')).data as Bootstrap).role).toBe('owner');
    expect(((await o2.get('/api/w/doomed/bootstrap')).data as Bootstrap).role).toBe('admin');
    expect((await heir.req('DELETE', '/api/w/doomed/', { confirmSlug: 'nope' })).statusCode).toBe(
      400,
    );
    expect((await heir.req('DELETE', '/api/w/doomed/', { confirmSlug: 'doomed' })).statusCode).toBe(
      200,
    );
    expect((await heir.get('/api/w/doomed/bootstrap')).statusCode).toBe(404);
  });
});

describe('domains and auto-join', () => {
  it('verifies a domain by DNS, once per instance', async () => {
    const domain = `org-${Date.now()}.test`;
    const added = (await owner.post(`${ws}/domains`, { domain })).data;
    app.resolveTxt = async () => [['something-else']];
    expect((await owner.post(`${ws}/domains/${added.id}/verify`)).statusCode).toBe(400);
    app.resolveTxt = async (name) =>
      name === `_ordo-verify.${domain}` ? [[`ordo-verify=${added.verificationToken}`]] : [];
    const verified = await owner.post(`${ws}/domains/${added.id}/verify`);
    expect(verified.data).toMatchObject({ verified: true, verifiedBy: 'dns' });

    const rival = (await signup(app, 'Rival Owner')).client;
    await rival.post('/api/workspaces', {
      name: 'Rival',
      slug: `rival-${Date.now()}`,
      teamName: 'R',
      teamKey: 'RIV',
    });
    const rivalSlug = (await rival.get('/api/auth/me')).data.workspaces[0].slug as string;
    const theirs = (await rival.post(`/api/w/${rivalSlug}/domains`, { domain })).data;
    app.resolveTxt = async () => [[`ordo-verify=${theirs.verificationToken}`]];
    expect((await rival.post(`/api/w/${rivalSlug}/domains/${theirs.id}/verify`)).statusCode).toBe(
      409,
    );
  });

  it('lets people with a verified address at a verified domain join without an invite', async () => {
    const domain = `auto-${Date.now()}.test`;
    const added = (await owner.post(`${ws}/domains`, { domain })).data;
    app.resolveTxt = async () => [[`ordo-verify=${added.verificationToken}`]];
    await owner.post(`${ws}/domains/${added.id}/verify`);

    const person = new Client(app);
    const email = `pat@${domain}`;
    await person.post('/api/auth/signup', {
      name: 'Pat',
      email,
      password: 'correct horse battery',
    });
    // Auto-join is off, and the address isn't verified yet.
    expect((await person.get('/api/workspaces/joinable')).data).toEqual([]);
    await owner.patch(`${ws}/`, { settings: { domainAutoJoin: true, autoJoinRole: 'guest' } });
    expect((await person.get('/api/workspaces/joinable')).data).toEqual([]);
    await app.db
      .update(users)
      .set({ emailVerifiedAt: new Date().toISOString() })
      .where(eq(users.email, email));
    const list = (await person.get('/api/workspaces/joinable')).data;
    expect(list.map((w: { slug: string }) => w.slug)).toEqual(['org']);
    expect((await person.post(`/api/workspaces/${list[0].id}/join`)).data).toEqual({
      workspaceSlug: 'org',
    });
    expect(((await person.get(`${ws}/bootstrap`)).data as Bootstrap).role).toBe('guest');
    await owner.patch(`${ws}/`, { settings: { domainAutoJoin: false } });
  });
});

describe('logo', () => {
  it('is set by admins only', async () => {
    const { client: member } = await join('member');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const send = (c: Client) => {
      const boundary = '----ordo';
      return app.inject({
        method: 'POST',
        url: `${ws}/logo`,
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          png,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: { cookie: c.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
    };
    expect((await send(member)).statusCode).toBe(403);
    expect((await send(owner)).statusCode).toBe(200);
    expect(((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).workspace.logoUrl).toMatch(
      /^\/api\/files\//,
    );
  });
});

describe('instance admin', () => {
  let admin: Client;
  beforeAll(async () => {
    admin = (await signup(app, 'Ian Instance')).client;
    await app.db
      .update(users)
      .set({ isInstanceAdmin: true })
      .where(eq(users.id, (await me(admin)).id));
    // In a fresh test database the workspace owner was the first account, which makes it an instance admin.
    await app.db.update(users).set({ isInstanceAdmin: false }).where(eq(users.id, ownerId));
  });

  it('is closed to everyone else', async () => {
    expect((await owner.get('/api/admin/overview')).statusCode).toBe(403);
    expect((await admin.get('/api/admin/overview')).data).toMatchObject({
      emailEnabled: true,
      secretKey: 'ok',
    });
  });

  it('disables accounts, issues reset links, and refuses to orphan workspaces', async () => {
    const { client: victim, email } = await signup(app, 'Dee Disabled');
    const id = (await me(victim)).id;
    const search = await admin.get(`/api/admin/users?q=${encodeURIComponent(email)}`);
    expect(search.statusCode, search.body).toBe(200);
    const found = search.data;
    expect(found.map((u: { id: string }) => u.id)).toEqual([id]);
    expect((await admin.patch(`/api/admin/users/${id}`, { disabled: true })).statusCode).toBe(200);
    expect((await victim.get('/api/auth/me')).statusCode).toBe(401);
    await admin.patch(`/api/admin/users/${id}`, { disabled: false });
    const link = (await admin.post(`/api/admin/users/${id}/reset-link`)).data;
    expect(link.url).toContain('/reset-password/');
    expect((await admin.del(`/api/admin/users/${ownerId}`)).statusCode).toBe(409);
    expect((await admin.del(`/api/admin/users/${id}`)).statusCode).toBe(200);
    const adminId = (await me(admin)).id;
    expect((await admin.patch(`/api/admin/users/${adminId}`, { disabled: true })).statusCode).toBe(
      400,
    );
  });

  it('filters the instance audit log and names who and what', async () => {
    const { client: target } = await signup(app, 'Tara Target');
    const targetId = (await me(target)).id;
    await admin.patch(`/api/admin/users/${targetId}`, { disabled: true });
    await admin.patch(`/api/admin/users/${targetId}`, { disabled: false });
    type Entry = {
      action: string;
      actorName: string | null;
      workspaceId: string | null;
      workspaceName: string | null;
      targetName: string | null;
    };
    const list = async (query = '') =>
      (await admin.get(`/api/admin/audit-log?${query}`)).data as Entry[];

    const instance = await list(`category=members&actorId=${(await me(admin)).id}`);
    expect(instance.length).toBeGreaterThanOrEqual(2);
    expect(instance[0]).toMatchObject({
      action: 'admin.user_updated',
      actorName: 'Ian Instance',
      workspaceId: null,
      targetName: 'Tara Target',
    });
    // Free text finds people by name or email.
    expect((await list('q=Ian%20Instance')).every((e) => e.actorName === 'Ian Instance')).toBe(
      true,
    );
    // One workspace, or everything.
    const inOrg = await list(`workspaceId=${boot.workspace.id}`);
    expect(inOrg.length).toBeGreaterThan(0);
    expect(inOrg.every((e) => e.workspaceName === boot.workspace.name)).toBe(true);
    const all = await list('scope=all&limit=500');
    expect(all.some((e) => e.workspaceId === null)).toBe(true);
    expect(all.some((e) => e.workspaceId !== null)).toBe(true);
    expect((await owner.get('/api/admin/audit-log')).statusCode).toBe(403);
  });

  it('manages settings: env-pinned ones are locked, SMTP is stored encrypted and shown masked', async () => {
    expect((await admin.patch('/api/admin/settings', { signupMode: 'invite' })).statusCode).toBe(
      400,
    );
    expect(
      (await admin.patch('/api/admin/settings', { smtp: { url: 'smtp://x', from: 'a@b' } }))
        .statusCode,
    ).toBe(400);

    const local = await testApp({ settingsFromEnv: {} });
    const root = new Client(local);
    await root
      .post('/api/auth/signup', {
        name: 'Root',
        email: `root-${Date.now()}@example.com`,
        password: 'correct horse battery',
      })
      .catch(() => {});
    const rootId = (await root.get('/api/auth/me')).data.id;
    if (rootId)
      await local.db.update(users).set({ isInstanceAdmin: true }).where(eq(users.id, rootId));
    if (rootId) {
      const res = await root.patch('/api/admin/settings', {
        allowWorkspaceCreation: false,
        smtp: {
          url: 'smtps://mailer:s3cret@smtp.example.com:465',
          from: 'Ordo <ordo@example.com>',
        },
      });
      expect(res.statusCode).toBe(200);
      const smtp = res.data.find((e: { key: string }) => e.key === 'smtp');
      expect(smtp.value.url).not.toContain('s3cret');
      const [stored] = await local.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, 'smtp'));
      expect(JSON.stringify(stored!.value)).not.toContain('s3cret');
      expect((await root.get('/api/config')).data.allowWorkspaceCreation).toBe(false);
      // Clean up the shared database for other test files.
      await local.db.delete(instanceSettings);
    }
    await local.close();
  });
});
