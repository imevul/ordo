import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, sessions, users, webauthnChallenges, workspaces } from '../src/db/schema.ts';
import { Client, captureMail, signup, testApp } from './helpers.ts';
import { SoftAuthenticator } from './soft-authenticator.ts';

let app: FastifyInstance;
let inbox: ReturnType<typeof captureMail>;
const site = { origin: 'http://localhost:3000', rpId: 'localhost' };
const password = 'correct horse battery';

beforeAll(async () => {
  app = await testApp({ settingsFromEnv: { signupMode: 'open' } });
  inbox = captureMail(app);
});
afterAll(() => app.close());

/** Signs up, then adds a passkey from a software authenticator. */
async function withPasskey(name = 'Pat Passkey') {
  const { client, email } = await signup(app, name);
  const key = new SoftAuthenticator(site);
  const { challengeId, options } = (await client.post('/api/me/passkeys/options', { password }))
    .data;
  const added = await client.post('/api/me/passkeys', {
    challengeId,
    response: key.register(options),
    name: 'Laptop',
  });
  expect(added.statusCode, added.body).toBe(200);
  const id = (await client.get('/api/auth/me')).data.id as string;
  return { client, email, key, id, passkeyId: added.data.id as string };
}

/** Starts a passwordless sign-in and answers it with `answer`. */
async function signInWith(answer: (options: { challenge: string }) => Record<string, unknown>) {
  const client = new Client(app);
  const { challengeId, options } = (await client.post('/api/auth/passkey/options')).data;
  const res = await client.post('/api/auth/passkey', { challengeId, response: answer(options) });
  return { client, res, challengeId, options };
}

describe('passkeys', () => {
  it('are offered on secure origins', async () => {
    expect((await new Client(app).get('/api/config')).data.passkeyOrigin).toBe(site.origin);
  });

  it('are added after confirming the password, and the owner is told', async () => {
    const { client, email } = await signup(app, 'Ada Adder');
    const without = await client.post('/api/me/passkeys/options', {});
    expect(without.data.messageKey).toBe('current_password_wrong');

    const key = new SoftAuthenticator(site);
    const { challengeId, options } = (await client.post('/api/me/passkeys/options', { password }))
      .data;
    // Discoverable, so it can sign in on its own.
    expect(options.authenticatorSelection.residentKey).toBe('required');
    const response = key.register(options);
    const added = await client.post('/api/me/passkeys', { challengeId, response, name: 'Phone' });
    expect(added.data).toMatchObject({ name: 'Phone', lastUsedAt: null });
    expect((await client.get('/api/me/passkeys')).data).toHaveLength(1);
    // A challenge is good once.
    const again = await client.post('/api/me/passkeys', { challengeId, response });
    expect(again.data.messageKey).toBe('passkey_failed');

    await app.jobs.drain();
    expect(inbox.find((m) => m.to === email && /passkey was added/.test(m.subject))).toBeTruthy();
    const me = (await client.get('/api/auth/me')).data.id;
    const actions = await app.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorId, me));
    expect(actions.map((a) => a.action)).toContain('auth.passkey_added');
  });

  it('refuses a registration from another site', async () => {
    const { client } = await signup(app, 'Eve Elsewhere');
    const key = new SoftAuthenticator(site);
    for (const bad of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }]) {
      const { challengeId, options } = (await client.post('/api/me/passkeys/options', { password }))
        .data;
      const res = await client.post('/api/me/passkeys', {
        challengeId,
        response: key.register(options, bad),
      });
      expect(res.data.messageKey).toBe('passkey_failed');
    }
  });

  it('sign in without a password', async () => {
    const { key, id } = await withPasskey('Sam Signin');
    const { client, res } = await signInWith((o) => key.authenticate(o));
    expect(res.statusCode, res.body).toBe(200);
    expect((await client.get('/api/auth/me')).data.id).toBe(id);
    const [login] = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, id), eq(auditLog.action, 'auth.login')));
    expect(login!.data).toEqual({ method: 'passkey' });
    expect((await client.get('/api/me/passkeys')).data[0].lastUsedAt).toBeTruthy();
  });

  it('refuses sign-ins it should', async () => {
    const { key, id } = await withPasskey('Rae Refused');
    const refused = async (answer: (o: { challenge: string }) => Record<string, unknown>) => {
      const { res } = await signInWith(answer);
      expect(res.statusCode).toBe(400);
      expect(res.data.messageKey).toBe('passkey_failed');
    };
    await refused((o) => key.authenticate(o, { origin: 'https://evil.example' }));
    await refused((o) => key.authenticate(o, { rpId: 'evil.example' }));
    // Passwordless needs the user verified (PIN, biometrics), not just present.
    await refused((o) => key.authenticate(o, { userVerified: false }));
    await refused((o) => key.authenticate(o, { userHandle: 'c29tZW9uZS1lbHNl' }));
    await refused((o) => key.authenticate(o, { type: 'webauthn.create' }));

    // A challenge is good once, and only before it expires.
    const ok = await signInWith((o) => key.authenticate(o, { counter: 7 }));
    expect(ok.res.statusCode).toBe(200);
    // A counter that went backwards: a cloned authenticator.
    await refused((o) => key.authenticate(o, { counter: 3 }));
    const replay = await new Client(app).post('/api/auth/passkey', {
      challengeId: ok.challengeId,
      response: key.authenticate(ok.options),
    });
    expect(replay.data.messageKey).toBe('passkey_failed');
    const client = new Client(app);
    const { challengeId, options } = (await client.post('/api/auth/passkey/options')).data;
    await app.db
      .update(webauthnChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(webauthnChallenges.id, challengeId));
    const expired = await client.post('/api/auth/passkey', {
      challengeId,
      response: key.authenticate(options),
    });
    expect(expired.data.messageKey).toBe('passkey_failed');

    // A challenge made for adding a passkey can't sign in.
    const owner = await signup(app, 'Pia Purpose');
    const registration = (await owner.client.post('/api/me/passkeys/options', { password })).data;
    const wrong = await new Client(app).post('/api/auth/passkey', {
      challengeId: registration.challengeId,
      response: key.authenticate(registration.options),
    });
    expect(wrong.data.messageKey).toBe('passkey_failed');

    // Disabled accounts stay out.
    await app.db.update(users).set({ disabledAt: sql`now()` }).where(eq(users.id, id));
    const disabled = await signInWith((o) => key.authenticate(o, { counter: 20 }));
    expect(disabled.res.data.messageKey).toBe('account_disabled');
  });

  it('are renamed and removed, removal needing the password', async () => {
    const { client, email, passkeyId } = await withPasskey('Rob Remover');
    const renamed = await client.patch(`/api/me/passkeys/${passkeyId}`, { name: 'Work laptop' });
    expect(renamed.data.name).toBe('Work laptop');
    expect((await client.req('DELETE', `/api/me/passkeys/${passkeyId}`, {})).statusCode).toBe(400);
    expect(
      (await client.req('DELETE', `/api/me/passkeys/${passkeyId}`, { password })).statusCode,
    ).toBe(200);
    expect((await client.get('/api/me/passkeys')).data).toHaveLength(0);
    await app.jobs.drain();
    expect(inbox.find((m) => m.to === email && /passkey was removed/.test(m.subject))).toBeTruthy();
  });

  it('need a recent sign-in instead of a password on accounts without one', async () => {
    const { client, id } = await signup(app, 'Sol Sso').then(async (s) => ({
      ...s,
      id: (await s.client.get('/api/auth/me')).data.id as string,
    }));
    await app.db.update(users).set({ passwordHash: null }).where(eq(users.id, id));
    expect((await client.post('/api/me/passkeys/options', {})).statusCode).toBe(200);
    await app.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(sessions.userId, id));
    const stale = await client.post('/api/me/passkeys/options', {});
    expect(stale.data.messageKey).toBe('reauth_needed');
  });

  it('count as a non-SSO sign-in where SSO is required', async () => {
    const owner = await withPasskey('Olga Owner');
    await owner.client.post('/api/workspaces', {
      name: 'Strict',
      slug: 'passkey-strict',
      teamName: 'Core',
      teamKey: 'STR',
    });
    const invite = (await owner.client.post('/api/w/passkey-strict/invites', {})).data[0].token;
    const member = await signup(app, 'Mia Member', { inviteToken: invite });
    const memberKey = new SoftAuthenticator(site);
    const reg = (await member.client.post('/api/me/passkeys/options', { password })).data;
    await member.client.post('/api/me/passkeys', {
      challengeId: reg.challengeId,
      response: memberKey.register(reg.options),
    });
    await app.db
      .update(workspaces)
      .set({ settings: sql`${workspaces.settings} || '{"requireSso": true}'::jsonb` })
      .where(eq(workspaces.slug, 'passkey-strict'));

    const asMember = await signInWith((o) => memberKey.authenticate(o));
    expect((await asMember.client.get('/api/w/passkey-strict/bootstrap')).data.error).toBe(
      'sso_required',
    );
    // Owners keep a way in; it's audited as a bypass with the method used.
    const asOwner = await signInWith((o) => owner.key.authenticate(o));
    expect((await asOwner.client.get('/api/w/passkey-strict/bootstrap')).statusCode).toBe(200);
    const [bypass] = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, owner.id), eq(auditLog.action, 'auth.sso_bypass')))
      .orderBy(sql`${auditLog.createdAt} desc`)
      .limit(1);
    expect(bypass!.data).toEqual({ method: 'passkey' });
  });
});
