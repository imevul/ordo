import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, issues, users } from '../src/db/schema.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { BlockedTargetError, isPrivateAddress, safeFetch } from '../src/lib/safeFetch.ts';
import { Keyring, SecretKeyMissingError } from '../src/lib/secrets.ts';
import { Client, freshDatabase, signup, testApp } from './helpers.ts';

describe('keyring', () => {
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);

  it('round-trips and binds ciphertexts to their location', () => {
    const k = new Keyring(a);
    const sealed = k.encrypt('hunter2', 'integrations:1:token');
    expect(sealed).toMatch(/^v1\./);
    expect(k.decrypt(sealed, 'integrations:1:token')).toBe('hunter2');
    expect(() => k.decrypt(sealed, 'integrations:2:token')).toThrow();
  });

  it('decrypts with the previous key during rotation', () => {
    const old = new Keyring(a).encrypt('s3cret', 'x');
    const rotated = new Keyring(b, a);
    expect(rotated.decrypt(old, 'x')).toBe('s3cret');
    expect(rotated.needsRotation(old)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('s3cret', 'x'))).toBe(false);
    expect(() => new Keyring(b).decrypt(old, 'x')).toThrow(/unknown key/);
  });

  it('refuses to encrypt without a key', () => {
    expect(() => new Keyring(null).encrypt('x', 'y')).toThrow(SecretKeyMissingError);
  });
});

describe('safeFetch', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` });
        return res.end();
      }
      if (req.url === '/big') return res.end('x'.repeat(2048));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('classifies private addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      '::ffff:10.0.0.1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('blocks private targets by IP and by hostname', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/ok`)).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    await expect(safeFetch(`http://localhost:${port}/ok`)).rejects.toThrow();
  });

  it('allows private targets when permitted, follows redirects and caps size', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/redirect`, { allowPrivate: true });
    expect(res.json()).toEqual({ ok: true });
    expect(res.url).toContain('/ok');
    await expect(
      safeFetch(`http://127.0.0.1:${port}/big`, { allowPrivate: true, maxBytes: 100 }),
    ).rejects.toThrow(/larger/);
  });
});

describe('instance', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // A fresh database so "first user" really is the first.
    process.env.FOUNDATIONS_DB_URL ??= await freshDatabase('foundations');
    app = await testApp({ databaseUrl: process.env.FOUNDATIONS_DB_URL, settingsFromEnv: {} });
  });
  afterAll(() => app.close());

  it('makes the first account the instance admin, and only the first', async () => {
    const first = await signup(app, 'Root Admin', {});
    expect((await first.client.get('/api/auth/me')).data.isInstanceAdmin).toBe(true);
    // Default sign-up mode is invite-only, so the next person needs an open instance.
    await app.settings.set('signupMode', 'open', null);
    const second = await signup(app, 'Plain User');
    expect((await second.client.get('/api/auth/me')).data.isInstanceAdmin).toBe(false);
  });

  it('resolves settings env → database → default, without a restart', async () => {
    await app.settings.set('allowWorkspaceCreation', false, null);
    const cfg = (await new Client(app).get('/api/config')).data;
    expect(cfg).toMatchObject({ signupMode: 'open', allowWorkspaceCreation: false });
    const entry = app.settings.describe().find((e) => e.key === 'allowWorkspaceCreation');
    expect(entry).toMatchObject({ value: false, source: 'db' });
    expect(
      app.settings.describe().find((e) => e.key === 'allowPrivateNetworkTargets')?.source,
    ).toBe('default');

    const pinned = await testApp({
      databaseUrl: process.env.FOUNDATIONS_DB_URL,
      settingsFromEnv: { signupMode: 'invite' },
    });
    expect(pinned.settings.describe().find((e) => e.key === 'signupMode')).toMatchObject({
      value: 'invite',
      source: 'env',
    });
    await pinned.close();
    await app.settings.set('allowWorkspaceCreation', true, null);
  });

  it('only lets enabled humans with a password sign in', async () => {
    const { client, email } = await signup(app, 'Dana Disabled');
    expect((await client.get('/api/auth/me')).statusCode).toBe(200);
    await app.db
      .update(users)
      .set({ disabledAt: new Date().toISOString() })
      .where(eq(users.email, email));
    // Existing sessions stop working immediately…
    expect((await client.get('/api/auth/me')).statusCode).toBe(401);
    // …and signing in again is refused.
    const login = await new Client(app).post('/api/auth/login', {
      email,
      password: 'correct horse battery',
    });
    expect(login.statusCode).toBe(403);

    await app.db.insert(users).values({
      email: 'bot@ordo.test',
      name: 'Bot',
      username: 'bot-test',
      kind: 'bot',
      passwordHash: await hashPassword('correct horse battery'),
    });
    const bot = await new Client(app).post('/api/auth/login', {
      email: 'bot@ordo.test',
      password: 'correct horse battery',
    });
    expect(bot.statusCode).toBe(401);

    await app.db
      .insert(users)
      .values({ email: 'sso@ordo.test', name: 'SSO', username: 'sso-only', passwordHash: null });
    const sso = await new Client(app).post('/api/auth/login', {
      email: 'sso@ordo.test',
      password: 'anything at all',
    });
    expect(sso.statusCode).toBe(401);
  });

  it('writes audit entries for sign-in, failures and API keys', async () => {
    const { client, email } = await signup(app, 'Audrey Audit');
    await new Client(app).post('/api/auth/login', { email, password: 'wrong password!' });
    await client.post('/api/auth/login', { email, password: 'correct horse battery' });
    const key = await client.post('/api/me/api-keys', { name: 'ci' });
    await client.del(`/api/me/api-keys/${key.data.id}`);
    const me = (await client.get('/api/auth/me')).data;
    const actions = (await app.db.select().from(auditLog).where(eq(auditLog.actorId, me.id))).map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.signup',
        'auth.login_failed',
        'auth.login',
        'api_key.created',
        'api_key.revoked',
      ]),
    );
  });

  it('shows workspace audit entries to admins only', async () => {
    const owner = (await signup(app, 'Olive Owner')).client;
    await owner.post('/api/workspaces', {
      name: 'Audited',
      slug: 'audited',
      teamName: 'Core',
      teamKey: 'COR',
    });
    await owner.patch('/api/w/audited/', { name: 'Audited Inc' });
    const log = await owner.get('/api/w/audited/audit-log');
    expect(log.data.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['workspace.created', 'workspace.updated']),
    );
    const invite = await owner.post('/api/w/audited/invites', {});
    const member = (await signup(app, 'Max Member', { inviteToken: invite.data[0].token })).client;
    expect((await member.get('/api/w/audited/audit-log')).statusCode).toBe(403);
  });

  it('filters the audit log and pages through it', async () => {
    const owner = (await signup(app, 'Fern Filter')).client;
    await owner.post('/api/workspaces', {
      name: 'Filtered',
      slug: 'filtered',
      teamName: 'Core',
      teamKey: 'FIL',
    });
    const ws = '/api/w/filtered';
    const ownerId = (await owner.get('/api/auth/me')).data.id as string;
    await owner.patch(`${ws}/`, { name: 'Filtered Inc' });
    await owner.post(`${ws}/teams`, { name: 'Design', key: 'DES' });
    const invite = await owner.post(`${ws}/invites`, {});
    const joiner = await signup(app, 'Jo Joiner', { inviteToken: invite.data[0].token });
    const joinerId = (await joiner.client.get('/api/auth/me')).data.id as string;
    const list = async (query: string) =>
      (await owner.get(`${ws}/audit-log?${query}`)).data as {
        id: string;
        action: string;
        actorId: string;
        createdAt: string;
      }[];

    expect((await list('category=teams')).map((e) => e.action)).toEqual(['team.created']);
    expect((await list('category=members')).map((e) => e.action).sort()).toEqual([
      'invite.accepted',
      'invite.created',
    ]);
    expect((await list(`actorId=${joinerId}`)).every((e) => e.actorId === joinerId)).toBe(true);
    expect((await list(`actorId=${ownerId}`)).some((e) => e.action === 'workspace.updated')).toBe(
      true,
    );
    // Free text reaches the details too.
    expect((await list('q=Filtered%20Inc')).map((e) => e.action)).toEqual(['workspace.updated']);
    expect(
      await list(`from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`),
    ).toEqual([]);
    expect(
      await list(`to=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`),
    ).toEqual([]);

    // Pages don't skip or repeat entries.
    const all = await list('limit=500');
    const seen: string[] = [];
    let page = await list('limit=2');
    while (page.length) {
      seen.push(...page.map((e) => e.id));
      const last = page.at(-1)!;
      page = await list(`limit=2&before=${encodeURIComponent(last.createdAt)}&beforeId=${last.id}`);
    }
    expect(seen).toEqual(all.map((e) => e.id));
    expect((await owner.get(`${ws}/audit-log?category=nope`)).statusCode).toBe(400);
  });

  it('keeps issues when their creator is deleted', async () => {
    const { client, email } = await signup(app, 'Gone Soon');
    await client.post('/api/workspaces', {
      name: 'Gone',
      slug: 'gone',
      teamName: 'Gone',
      teamKey: 'GON',
    });
    const boot = (await client.get('/api/w/gone/bootstrap')).data;
    const issue = (
      await client.post('/api/w/gone/issues', { teamId: boot.teams[0].id, title: 'Outlives me' })
    ).data;
    await app.db.delete(users).where(eq(users.email, email));
    const [row] = await app.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row).toMatchObject({ title: 'Outlives me', creatorId: null });
  });
});

describe('cross-site protection', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(() => app.close());

  it('rejects cookie-authenticated cross-site writes, but not bearer tokens', async () => {
    const { client } = await signup(app, 'Cross Site');
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { name: 'evil' },
      headers: { cookie: client.cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { name: 'evil' },
      headers: { cookie: client.cookie, origin: 'https://evil.example', host: 'localhost:80' },
    });
    expect(badOrigin.statusCode).toBe(403);
    const sameOrigin = await app.inject({
      method: 'POST',
      url: '/api/me/api-keys',
      payload: { name: 'fine' },
      headers: {
        cookie: client.cookie,
        origin: 'http://localhost:80',
        host: 'localhost:80',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(sameOrigin.statusCode).toBe(200);
    const bearer = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: {
        authorization: `Bearer ${sameOrigin.json().token}`,
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(bearer.statusCode).toBe(200);
  });
});
