import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, sessions, userIdentities, users, workspaceMembers } from '../src/db/schema.ts';
import { Client, signup, testApp } from './helpers.ts';
import { type MockIdp, startMockIdp } from './mock-idp.ts';

let app: FastifyInstance;
let idp: MockIdp;
let owner: Client;
let wsId: string;
let providerId: string;
const slug = `sso-${Date.now()}`;
const ws = `/api/w/${slug}`;
const domain = `${slug}.test`;
let sub = 0;

beforeAll(async () => {
  idp = await startMockIdp();
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  owner = (await signup(app, 'Sso Owner')).client;
  await owner.post('/api/workspaces', { name: 'Acme', slug, teamName: 'Core', teamKey: 'COR' });
  wsId = (await owner.get(`${ws}/bootstrap`)).data.workspace.id;
  const added = (await owner.post(`${ws}/domains`, { domain })).data;
  app.resolveTxt = async () => [[`ordo-verify=${added.verificationToken}`]];
  await owner.post(`${ws}/domains/${added.id}/verify`);
  const created = await owner.post(`${ws}/auth-providers`, {
    name: 'Acme ID',
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    groupClaim: 'groups',
    groupRoles: { 'ordo-admins': 'admin', contractors: 'guest' },
  });
  expect(created.statusCode).toBe(200);
  providerId = created.data.id;
});
afterAll(async () => {
  await app.close();
  await idp.close();
});

const cookieOf = (set: string | string[] | undefined, name: string) =>
  (Array.isArray(set) ? set : [set]).find((c) => c?.startsWith(`${name}=`))?.split(';')[0];

/** Runs the whole browser round trip: start → IdP → callback. Returns the final redirect. */
async function sso(
  claims: Record<string, unknown>,
  opts: { client?: Client; mode?: 'login' | 'link' | 'test'; stateCookie?: string } = {},
) {
  const client = opts.client ?? new Client(app);
  idp.next = claims;
  const start = await app.inject({
    method: 'GET',
    url: `/api/auth/oidc/${providerId}/start?mode=${opts.mode ?? 'login'}`,
    headers: client.cookie ? { cookie: client.cookie } : {},
  });
  if (start.statusCode !== 302) return { client, start, location: '', res: start };
  const state = opts.stateCookie ?? cookieOf(start.headers['set-cookie'], 'ordo_oidc')!;
  const authorize = await fetch(start.headers.location as string, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  const res = await app.inject({
    method: 'GET',
    url: back.pathname + back.search,
    headers: { cookie: [client.cookie, state].filter(Boolean).join('; ') },
  });
  const session = cookieOf(res.headers['set-cookie'], 'ordo_session');
  if (session) client.cookie = session;
  return { client, start, res, location: String(res.headers.location ?? '') };
}

const person = (local: string, extra: Record<string, unknown> = {}) => ({
  sub: `user-${++sub}`,
  email: `${local}-${sub}@${domain}`,
  email_verified: true,
  name: `${local} person`,
  ...extra,
});

const roleOf = async (email: string) => {
  const [row] = await app.db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(users.email, email), eq(workspaceMembers.workspaceId, wsId)));
  return row?.role ?? null;
};

describe('providers', () => {
  it('never returns the client secret and is admin-only', async () => {
    const list = await owner.get(`${ws}/auth-providers`);
    expect(list.data.redirectUri).toBe(`${app.env.publicUrl}/api/auth/oidc/callback`);
    expect(JSON.stringify(list.data)).not.toContain(idp.clientSecret);
    const member = (await sso(person('member'))).client;
    expect((await member.get(`${ws}/auth-providers`)).statusCode).toBe(403);
  });

  it('keeps unmentioned fields on update', async () => {
    await owner.patch(`${ws}/auth-providers/${providerId}`, { name: 'Acme Identity' });
    const [p] = (await owner.get(`${ws}/auth-providers`)).data.providers;
    expect(p).toMatchObject({ name: 'Acme Identity', groupClaim: 'groups', enabled: true });
    expect(p.groupRoles).toEqual({ 'ordo-admins': 'admin', contractors: 'guest' });
  });

  it('is discoverable by email domain', async () => {
    const found = await new Client(app).get(`/api/auth/discover?email=x@${domain}`);
    expect(found.data.options).toEqual([{ providerId, name: 'Acme Identity', workspace: 'Acme' }]);
    expect(
      (await new Client(app).get('/api/auth/discover?email=x@example.com')).data.options,
    ).toEqual([]);
  });

  it('shows admins the received claims in test mode without signing anyone in', async () => {
    const { res } = await sso(person('tester'), { client: owner, mode: 'test' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('tester person');
    expect(cookieOf(res.headers['set-cookie'], 'ordo_session')).toBeUndefined();
  });
});

describe('sign-in', () => {
  it('creates and joins new users from a verified domain', async () => {
    const claims = person('new');
    const { client, location } = await sso(claims);
    expect(location).toBe(`/${slug}`);
    const me = (await client.get('/api/auth/me')).data;
    expect(me.email).toBe(claims.email);
    expect(await roleOf(claims.email)).toBe('member');
    // Same subject again signs in the same user.
    const again = await sso({ ...claims, email: claims.email });
    expect((await again.client.get('/api/auth/me')).data.id).toBe(me.id);
  });

  it('refuses unverified emails and other domains (no account, no takeover)', async () => {
    const unverified = person('unverified', { email_verified: false });
    expect((await sso(unverified)).location).toMatch(/^\/login\?error=/);
    const [none] = await app.db.select().from(users).where(eq(users.email, unverified.email));
    expect(none).toBeUndefined();

    // A real account elsewhere: the IdP claiming its address must not get in.
    const victim = await signup(app, 'Victim Person');
    const res = await sso(person('x', { email: victim.email }));
    expect(res.location).toMatch(/^\/login\?error=.*linked/);
    const victimId = (await victim.client.get('/api/auth/me')).data.id;
    expect(
      await app.db.select().from(userIdentities).where(eq(userIdentities.userId, victimId)),
    ).toEqual([]);
  });

  it('lets signed-in users link an identity explicitly', async () => {
    const someone = await signup(app, 'Linker Person');
    const claims = person('linker', { email: someone.email });
    await sso(claims, { client: someone.client, mode: 'link' });
    const ids = (await someone.client.get('/api/me/identities')).data;
    expect(ids).toHaveLength(1);
    // Now the identity signs them in, though the domain isn't trusted.
    const fresh = await sso(claims);
    expect((await fresh.client.get('/api/auth/me')).data.email).toBe(someone.email);
    // Someone else can't link the same identity.
    const other = await signup(app, 'Other Person');
    const taken = await sso(claims, { client: other.client, mode: 'link' });
    expect(taken.location).toContain('error=');
  });

  it('rejects a mismatched state or issuer', async () => {
    const wrongState = await sso(person('state'), { stateCookie: 'ordo_oidc=nope' });
    expect(wrongState.location).toMatch(/^\/login\?error=/);
    idp.tamper = { iss: 'http://evil.test' };
    const wrongIssuer = await sso(person('issuer'));
    expect(decodeURIComponent(wrongIssuer.location)).toMatch(
      /^\/login\?error=Sign-in failed \(.*JWT claim/,
    );
    expect(cookieOf(wrongIssuer.res.headers['set-cookie'], 'ordo_session')).toBeUndefined();
  });

  it('refuses disabled accounts', async () => {
    const claims = person('disabled');
    await sso(claims);
    await app.db
      .update(users)
      .set({ disabledAt: new Date().toISOString() })
      .where(eq(users.email, claims.email));
    expect((await sso(claims)).location).toMatch(/^\/login\?error=.*disabled/);
  });

  it('maps groups to roles at every sign-in, never demoting owners', async () => {
    const claims = person('grouped', { groups: ['ordo-admins'] });
    await sso(claims);
    expect(await roleOf(claims.email)).toBe('admin');
    await sso({ ...claims, groups: ['contractors'] });
    expect(await roleOf(claims.email)).toBe('guest');
  });

  it("won't unlink someone's only way to sign in", async () => {
    const { client } = await sso(person('only'));
    const [identity] = (await client.get('/api/me/identities')).data;
    expect((await client.del(`/api/me/identities/${identity.id}`)).statusCode).toBe(400);
  });
});

describe('require SSO', () => {
  let passwordMember: Client;
  let ssoMember: Client;

  beforeAll(async () => {
    const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
    passwordMember = (await signup(app, 'Password Member', { inviteToken: invite.token })).client;
    ssoMember = (await sso(person('enforced'))).client;
    await owner.patch(`${ws}/`, { settings: { requireSso: true, ssoSessionMaxAgeHours: 8 } });
  });

  it('blocks password sessions with a pointer to the provider', async () => {
    const res = await passwordMember.get(`${ws}/bootstrap`);
    expect(res.statusCode).toBe(403);
    expect(res.data.error).toBe('sso_required');
    expect(res.data.details.options[0].providerId).toBe(providerId);
    expect((await ssoMember.get(`${ws}/bootstrap`)).statusCode).toBe(200);
  });

  it('applies to the WebSocket too', async () => {
    const code = await new Promise<number>((resolve) => {
      app
        .injectWS(`/api/ws?workspace=${slug}`, { headers: { cookie: passwordMember.cookie } })
        .then((socket) => socket.on('close', (c) => resolve(c)));
    });
    expect(code).toBe(4403);
  });

  it('keeps an audited password fallback for owners', async () => {
    expect((await owner.get(`${ws}/bootstrap`)).statusCode).toBe(200);
    const me = (await owner.get('/api/auth/me')).data;
    const fresh = new Client(app);
    await fresh.post('/api/auth/login', { email: me.email, password: 'correct horse battery' });
    const rows = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.sso_bypass'), eq(auditLog.workspaceId, wsId)));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rejects API keys unless allowed', async () => {
    const key = (await ssoMember.post('/api/me/api-keys', { name: 'cli' })).data.token;
    const call = () =>
      app.inject({
        method: 'GET',
        url: `${ws}/bootstrap`,
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await call()).statusCode).toBe(403);
    await owner.patch(`${ws}/`, { settings: { allowApiKeysUnderSso: true } });
    expect((await call()).statusCode).toBe(200);
  });

  it('ends SSO sessions after the max age', async () => {
    const claims = person('aged');
    const { client } = await sso(claims);
    const [user] = await app.db.select().from(users).where(eq(users.email, claims.email));
    const [s] = await app.db.select().from(sessions).where(eq(sessions.userId, user!.id));
    expect(new Date(s!.ssoExpiresAt!).getTime() - Date.now()).toBeGreaterThan(7.9 * 3_600_000);
    await app.db
      .update(sessions)
      .set({ ssoExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(sessions.userId, user!.id));
    expect((await client.get('/api/auth/me')).statusCode).toBe(401);
  });
});
