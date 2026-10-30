import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issues, jobs, notifications, schedules, sessions, users } from '../src/db/schema.ts';
import { proxyTrust } from '../src/env.ts';
import { enqueue } from '../src/lib/jobs/index.ts';
import { Client, captureMail, linkIn, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let inbox: ReturnType<typeof captureMail>;
const PASSWORD = 'correct horse battery';

beforeAll(async () => {
  app = await testApp({
    // As behind one reverse proxy, so the throttling tests can tell a proxied client from a direct one.
    trustProxy: 1,
    settingsFromEnv: {
      signupMode: 'open',
      smtp: { url: 'smtp://mail.test:25', from: 'Ordo <ordo@test>' },
    },
  });
  inbox = captureMail(app);
});
afterAll(() => app.close());

// Jobs run in parallel, so find emails by recipient and subject rather than by order.
const lastMailTo = (to: string, subject: RegExp = /./) =>
  inbox.filter((m) => m.to === to && subject.test(m.subject)).at(-1);
const tokenFrom = (to: string, subject?: RegExp) =>
  linkIn(lastMailTo(to, subject)?.text ?? '')
    .split('/')
    .pop()!;
/** Makes every schedule due (they run at most once per interval), then runs jobs twice: tick, then emails. */
async function runSchedulesNow() {
  await app.db.update(schedules).set({ nextRunAt: sql`now()` });
  await app.jobs.drain();
  await app.jobs.drain();
}

/** The code for now, or `steps` 30-second steps away (one either side is accepted). */
const codeFor = (secret: string, steps = 0) =>
  new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() + steps * 30_000 });

describe('email verification', () => {
  it('sends a link on sign-up that verifies the address', async () => {
    const { client, email } = await signup(app, 'Vera Verify');
    await app.jobs.drain();
    expect(lastMailTo(email, /verify/i)).toBeDefined();
    expect((await client.get('/api/me/account')).data.emailVerified).toBe(false);
    const token = tokenFrom(email, /verify/i);
    expect((await client.post('/api/auth/verify-email', { token })).statusCode).toBe(200);
    expect((await client.get('/api/me/account')).data.emailVerified).toBe(true);
    // Links work once.
    expect((await client.post('/api/auth/verify-email', { token })).statusCode).toBe(400);
  });
});

describe('password reset', () => {
  it('resets by email, signs out other sessions, and works once', async () => {
    const { client: old, email } = await signup(app, 'Rex Reset');
    expect((await new Client(app).post('/api/auth/forgot', { email })).statusCode).toBe(200);
    // Unknown addresses get the same answer.
    expect(
      (await new Client(app).post('/api/auth/forgot', { email: 'nobody@example.com' })).statusCode,
    ).toBe(200);
    await app.jobs.drain();
    const token = tokenFrom(email, /reset/i);

    const fresh = new Client(app);
    const reset = await fresh.post('/api/auth/reset', { token, password: 'a brand new password' });
    expect(reset.data).toMatchObject({ ok: true, signedIn: true });
    expect((await fresh.get('/api/auth/me')).statusCode).toBe(200);
    expect((await old.get('/api/auth/me')).statusCode).toBe(401);
    expect(
      (await new Client(app).post('/api/auth/reset', { token, password: 'another password!' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await new Client(app).post('/api/auth/login', { email, password: 'a brand new password' }))
        .statusCode,
    ).toBe(200);
  });
});

describe('email change', () => {
  it('confirms the new address before switching, and tells the old one', async () => {
    const { client, email } = await signup(app, 'Eli Email');
    const next = `eli-new-${Date.now()}@example.com`;
    expect(
      (await client.post('/api/me/email', { email: next, password: 'wrong' })).statusCode,
    ).toBe(400);
    expect((await client.post('/api/me/email', { email: next, password: PASSWORD })).data).toEqual({
      pending: true,
    });
    await app.jobs.drain();
    expect((await client.get('/api/me/account')).data.email).toBe(email);
    expect(
      (await client.post('/api/auth/confirm-email-change', { token: tokenFrom(next, /confirm/i) }))
        .statusCode,
    ).toBe(200);
    await app.jobs.drain();
    const account = (await client.get('/api/me/account')).data;
    expect(account).toMatchObject({ email: next, emailVerified: true });
    expect(lastMailTo(email, /changed/i)).toBeDefined();
  });
});

describe('email change and two-factor setup', () => {
  const withKey = (token: string, url: string, payload: object) =>
    app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}` } });

  it('need a recent sign-in on accounts without a password', async () => {
    const { client } = await signup(app, 'Sid Sso');
    const id = (await client.get('/api/auth/me')).data.id as string;
    await app.db.update(users).set({ passwordHash: null }).where(eq(users.id, id));
    await app.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(sessions.userId, id));
    const next = `sid-new-${Date.now()}@example.com`;
    const email = await client.post('/api/me/email', { email: next });
    expect(email.statusCode).toBe(403);
    expect(email.data.messageKey).toBe('reauth_needed');
    const totp = await client.post('/api/me/2fa/setup', {});
    expect(totp.statusCode).toBe(403);
    expect(totp.data.messageKey).toBe('reauth_needed');

    await app.db
      .update(sessions)
      .set({ createdAt: new Date().toISOString() })
      .where(eq(sessions.userId, id));
    expect((await client.post('/api/me/email', { email: next })).data).toEqual({ pending: true });
    expect((await client.post('/api/me/2fa/setup', {})).data.uri).toMatch(/^otpauth:/);
  });

  it("can't be done with an API key, with or without a password", async () => {
    for (const sso of [false, true]) {
      const { client } = await signup(app, sso ? 'Kim Keyless' : 'Kit Key');
      const id = (await client.get('/api/auth/me')).data.id as string;
      const token = (await client.post('/api/me/api-keys', { name: 'cli' })).data.token as string;
      if (sso) await app.db.update(users).set({ passwordHash: null }).where(eq(users.id, id));
      const body = sso ? {} : { password: PASSWORD };
      const email = await withKey(token, '/api/me/email', {
        ...body,
        email: `key-${sso}-${Date.now()}@example.com`,
      });
      expect(email.json().message).toBe('Use a browser session for this');
      const totp = await withKey(token, '/api/me/2fa/setup', body);
      expect(totp.json().message).toBe('Use a browser session for this');
    }
  });
});

describe('sign-in throttling', () => {
  it('counts wrong passwords per account, not per address', async () => {
    const { email } = await signup(app, 'Spray Target');
    for (let i = 0; i < 10; i++) {
      const res = await new Client(app, { ip: `10.201.0.${i + 1}` }).post('/api/auth/login', {
        email,
        password: 'wrong password',
      });
      expect(res.statusCode).toBe(401);
    }
    const right = await new Client(app).post('/api/auth/login', { email, password: PASSWORD });
    expect(right.statusCode).toBe(429);
  });

  it('takes the client address from the proxy, not from what the client wrote', async () => {
    const email = `nobody-${Date.now()}@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.202.0.1',
      headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' },
      payload: { email, password: 'x' },
    });
    // Exposed directly, the header is the client's own word and ignored.
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '8.8.8.8',
      headers: { 'x-forwarded-for': '6.6.6.6' },
      payload: { email, password: 'x' },
    });
    const rows = await app.db.execute<{ ip: string }>(
      sql`select ip from audit_log where action = 'auth.login_failed' and data->>'email' = ${email} order by created_at`,
    );
    expect(rows.map((r) => r.ip)).toEqual(['7.7.7.7', '8.8.8.8']);
  });

  it('believes no X-Forwarded-For by default, even from a private address', async () => {
    const direct = await testApp({ trustProxy: proxyTrust(undefined) });
    try {
      const email = `nobody-${Date.now()}@example.com`;
      await direct.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '172.17.0.1',
        headers: { 'x-forwarded-for': '6.6.6.6' },
        payload: { email, password: 'x' },
      });
      const rows = await direct.db.execute<{ ip: string }>(
        sql`select ip from audit_log where action = 'auth.login_failed' and data->>'email' = ${email}`,
      );
      expect(rows.map((r) => r.ip)).toEqual(['172.17.0.1']);
    } finally {
      await direct.close();
    }
  });

  it('reads ORDO_TRUST_PROXY as a hop count, never as "trust everything"', () => {
    expect(proxyTrust(undefined)).toBe(false);
    expect(proxyTrust('')).toBe(false);
    expect(proxyTrust('true')).toBe(1);
    expect(proxyTrust('false')).toBe(false);
    expect(proxyTrust('2')).toBe(2);
    expect(proxyTrust('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});

describe('two-factor authentication', () => {
  it('enrols, then requires a code (or a recovery code) to sign in', async () => {
    const { client, email } = await signup(app, 'Tia Totp');
    const setup = (await client.post('/api/me/2fa/setup', { password: PASSWORD })).data;
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\//);
    expect((await client.post('/api/me/2fa/enable', { code: '000000' })).statusCode).toBe(400);
    const enabled = await client.post('/api/me/2fa/enable', { code: codeFor(setup.secret) });
    expect(enabled.data.recoveryCodes).toHaveLength(10);

    const login = await new Client(app).post('/api/auth/login', { email, password: PASSWORD });
    expect(login.data).toMatchObject({ mfaRequired: true });
    expect(login.headers['set-cookie']).toBeUndefined();

    const second = new Client(app);
    expect(
      (await second.post('/api/auth/mfa', { mfaToken: login.data.mfaToken, code: '123456' }))
        .statusCode,
    ).toBe(401);
    // A wrong code doesn't burn the step.
    const used = codeFor(setup.secret);
    expect(
      (
        await second.post('/api/auth/mfa', {
          mfaToken: login.data.mfaToken,
          code: used,
        })
      ).statusCode,
    ).toBe(200);
    expect((await second.get('/api/auth/me')).statusCode).toBe(200);
    // That code is spent, even with a fresh password step.
    const replay = await new Client(app).post('/api/auth/login', { email, password: PASSWORD });
    expect(
      (
        await new Client(app).post('/api/auth/mfa', {
          mfaToken: replay.data.mfaToken,
          code: used,
        })
      ).statusCode,
    ).toBe(401);

    const recovery = enabled.data.recoveryCodes[0];
    const login2 = await new Client(app).post('/api/auth/login', { email, password: PASSWORD });
    expect(
      (
        await new Client(app).post('/api/auth/mfa', {
          mfaToken: login2.data.mfaToken,
          code: recovery,
        })
      ).statusCode,
    ).toBe(200);
    const login3 = await new Client(app).post('/api/auth/login', { email, password: PASSWORD });
    expect(
      (
        await new Client(app).post('/api/auth/mfa', {
          mfaToken: login3.data.mfaToken,
          code: recovery,
        })
      ).statusCode,
    ).toBe(401);

    expect(
      (
        await client.post('/api/me/2fa/disable', {
          password: PASSWORD,
          code: codeFor(setup.secret, 1),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await new Client(app).post('/api/auth/login', { email, password: PASSWORD })).data,
    ).toEqual({ ok: true });
  });

  it('locks the account after repeated wrong codes, whatever address they come from', async () => {
    const { client, email } = await signup(app, 'Guess Ing');
    const setup = (await client.post('/api/me/2fa/setup', { password: PASSWORD })).data;
    await client.post('/api/me/2fa/enable', { code: codeFor(setup.secret) });
    const login = await new Client(app).post('/api/auth/login', { email, password: PASSWORD });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const guess = await new Client(app, { ip: `10.200.0.${i + 1}` }).post('/api/auth/mfa', {
        mfaToken: login.data.mfaToken,
        code: '000000',
      });
      statuses.push(guess.statusCode);
    }
    expect(statuses.slice(0, 9).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(9)).toEqual([429, 400]);
    // The step is spent, and the password alone won't start a new one while locked.
    const right = await new Client(app).post('/api/auth/mfa', {
      mfaToken: login.data.mfaToken,
      code: codeFor(setup.secret),
    });
    expect(right.statusCode).toBe(400);
    const again = await new Client(app).post('/api/auth/login', { email, password: PASSWORD });
    expect(again.statusCode).toBe(429);
    expect(again.data.messageKey).toBe('too_many_attempts');
  });

  it('stores the secret encrypted', async () => {
    const { client, email } = await signup(app, 'Enc Rypted');
    const setup = (await client.post('/api/me/2fa/setup', { password: PASSWORD })).data;
    const [row] = await app.db
      .select({ s: users.totpSecret })
      .from(users)
      .where(eq(users.email, email));
    expect(row!.s).toMatch(/^v1\./);
    expect(row!.s).not.toContain(setup.secret);
  });
});

describe('sessions', () => {
  it('lists sessions and revokes them', async () => {
    const { client, email } = await signup(app, 'Sam Sessions');
    const other = new Client(app);
    await other.post('/api/auth/login', { email, password: PASSWORD });
    const list = (await client.get('/api/me/sessions')).data;
    expect(list).toHaveLength(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const otherSession = list.find((s: { current: boolean }) => !s.current);
    expect((await client.del(`/api/me/sessions/${otherSession.id}`)).statusCode).toBe(200);
    expect((await other.get('/api/auth/me')).statusCode).toBe(401);
    expect((await client.get('/api/auth/me')).statusCode).toBe(200);
  });
});

describe('language', () => {
  it('defaults to English and keeps the choice on the account', async () => {
    const { client } = await signup(app, 'Lars Locale');
    expect((await client.get('/api/auth/me')).data.locale).toBe('en');
    const res = await client.patch('/api/me/preferences', { locale: 'sv' });
    expect(res.statusCode).toBe(200);
    expect(res.data.locale).toBe('sv');
    expect((await client.get('/api/auth/me')).data.locale).toBe('sv');
    expect((await client.get('/api/me/account')).data.preferences.locale).toBe('sv');
    // Other preferences are untouched; unknown languages are refused.
    expect((await client.get('/api/me/account')).data.preferences.weekStartsOn).toBe(1);
    expect((await client.patch('/api/me/preferences', { locale: 'de' })).statusCode).toBe(400);
  });

  it("signs up in the page's language and writes emails in the account's language", async () => {
    const { client, email } = await signup(app, 'Siri Svensk', { locale: 'sv' });
    expect((await client.get('/api/auth/me')).data.locale).toBe('sv');
    await app.jobs.drain();
    expect(lastMailTo(email)?.subject).toBe('Bekräfta din e-postadress');

    await new Client(app).post('/api/auth/forgot', { email });
    await app.jobs.drain();
    const reset = lastMailTo(email, /lösenord/)!;
    expect(reset.subject).toBe('Återställ ditt lösenord i Ordo');
    expect(reset.text).toContain('Hej Siri Svensk,');

    await client.patch('/api/me/preferences', { locale: 'nb' });
    await new Client(app).post('/api/auth/forgot', { email });
    await app.jobs.drain();
    expect(lastMailTo(email, /passord/)?.subject).toBe('Tilbakestill passordet ditt i Ordo');
  });

  it('marks common errors so the web app can show them in its language', async () => {
    const { email } = await signup(app, 'Ella Error');
    const wrong = await new Client(app).post('/api/auth/login', { email, password: 'nope nope' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.data).toMatchObject({
      error: 'unauthorized',
      message: 'Wrong email or password',
      messageKey: 'wrong_credentials',
    });
    const missing = await new Client(app).get('/api/me/account');
    expect(missing.data.messageKey).toBe('not_signed_in');
  });
});

describe('avatars', () => {
  // 1×1 transparent PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  const upload = (client: Client, body: Buffer, filename: string) => {
    const boundary = '----ordo-test';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: '/api/me/avatar',
      payload,
      headers: {
        cookie: client.cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  };

  it('accepts images only and serves them through signed URLs', async () => {
    const { client } = await signup(app, 'Ava Avatar');
    expect((await upload(client, Buffer.from('<svg onload=alert(1)>'), 'x.svg')).statusCode).toBe(
      400,
    );
    const res = await upload(client, png, 'me.png');
    expect(res.statusCode).toBe(200);
    const url = res.json().avatarUrl as string;
    const file = await app.inject({ method: 'GET', url });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(
      (await app.inject({ method: 'GET', url: url.replace(/sig=.{4}/, 'sig=AAAA') })).statusCode,
    ).toBe(404);
    expect((await client.get('/api/auth/me')).data.avatarUrl).toMatch(/^\/api\/files\//);
  });
});

describe('notification emails', () => {
  it('batches unread notifications into one email, honouring preferences', async () => {
    const owner = (await signup(app, 'Nora Notify')).client;
    await owner.post('/api/workspaces', {
      name: 'Mailers',
      slug: 'mailers',
      teamName: 'Mail',
      teamKey: 'MAI',
    });
    const invite = (await owner.post('/api/w/mailers/invites', {})).data[0];
    const { client: dev, email: devEmail } = await signup(app, 'Dev Digest', {
      inviteToken: invite.token,
    });
    const devId = (await dev.get('/api/auth/me')).data.id;
    const boot = (await owner.get('/api/w/mailers/bootstrap')).data;
    await owner.post('/api/w/mailers/issues', {
      teamId: boot.teams[0].id,
      title: 'Fix the build',
      assigneeId: devId,
    });
    await owner.post('/api/w/mailers/issues', {
      teamId: boot.teams[0].id,
      title: 'Ship it',
      assigneeId: devId,
    });
    // Past the grace period.
    await app.db
      .update(notifications)
      .set({ createdAt: sql`now() - interval '5 minutes'` })
      .where(eq(notifications.userId, devId));
    const before = inbox.length;
    await runSchedulesNow();
    const sent = inbox.slice(before).filter((m) => m.to === devEmail && !/verify/i.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('2 updates in Mailers');
    expect(sent[0]!.text).toContain('Fix the build');

    // Turning email off settles new notifications without sending.
    await dev.patch('/api/me/preferences', { notifications: { emailDigest: 'off' } });
    await owner.post('/api/w/mailers/issues', {
      teamId: boot.teams[0].id,
      title: 'Quiet one',
      assigneeId: devId,
    });
    await app.db
      .update(notifications)
      .set({ createdAt: sql`now() - interval '5 minutes'` })
      .where(eq(notifications.userId, devId));
    const mark = inbox.length;
    await runSchedulesNow();
    expect(
      inbox.slice(mark).filter((m) => m.to === devEmail && !/verify/i.test(m.subject)),
    ).toHaveLength(0);
    const pending = await app.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, devId));
    expect(pending.every((n) => n.emailedAt)).toBe(true);
  });

  it('lists items oldest first and sends each digest exactly once when the job is retried', async () => {
    const owner = (await signup(app, 'Rita Retry')).client;
    await owner.post('/api/workspaces', {
      name: 'Retries',
      slug: 'retries',
      teamName: 'Retry',
      teamKey: 'RET',
    });
    const invite = (await owner.post('/api/w/retries/invites', {})).data[0];
    const join = () => signup(app, 'Retry Member', { inviteToken: invite.token });
    const [a, b] = [await join(), await join()];
    const aId = (await a.client.get('/api/auth/me')).data.id;
    const bId = (await b.client.get('/api/auth/me')).data.id;
    const teamId = (await owner.get('/api/w/retries/bootstrap')).data.teams[0].id;
    for (const [title, assigneeId] of [
      ['Second for A', aId],
      ['First for A', aId],
      ['Only for B', bId],
    ]) {
      await owner.post('/api/w/retries/issues', { teamId, title, assigneeId });
    }
    // Created out of order on purpose; A's are older than B's, so A's digest is queued first.
    const age = async (title: string, minutes: number) => {
      const [issue] = await app.db.select().from(issues).where(eq(issues.title, title));
      await app.db
        .update(notifications)
        .set({ createdAt: sql`now() - make_interval(mins => ${minutes})` })
        .where(eq(notifications.issueId, issue!.id));
    };
    await age('First for A', 30);
    await age('Second for A', 20);
    await age('Only for B', 10);

    // B's email can't be queued on the first attempt, after A's has been.
    await app.db.execute(
      sql.raw(`
      create function fail_retry_mail() returns trigger language plpgsql as $$
      begin
        if new.name = 'email.send' and new.payload->>'to' = '${b.email}' then
          raise exception 'mail queue unavailable';
        end if;
        return new;
      end $$;
      create trigger fail_retry_mail before insert on jobs
        for each row execute function fail_retry_mail();`),
    );
    const mark = inbox.length;
    await enqueue(app.db, 'notifications.email');
    await app.jobs.drain();
    const [failed] = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.name, 'notifications.email'), eq(jobs.status, 'pending')))
      .orderBy(desc(jobs.id))
      .limit(1);
    expect(failed!.attempts).toBe(1);
    expect(failed!.lastError).toContain('insert into "jobs"');

    await app.db.execute(sql`
      drop trigger fail_retry_mail on jobs;
      drop function fail_retry_mail();`);
    await app.db.update(jobs).set({ runAt: sql`now()` }).where(eq(jobs.id, failed!.id));
    await app.jobs.drain();
    await app.jobs.drain();

    const sent = (to: string) =>
      inbox.slice(mark).filter((m) => m.to === to && !/verify/i.test(m.subject));
    expect(sent(a.email)).toHaveLength(1);
    expect(sent(b.email)).toHaveLength(1);
    const text = sent(a.email)[0]!.text;
    expect(text.indexOf('First for A')).toBeGreaterThan(-1);
    expect(text.indexOf('First for A')).toBeLessThan(text.indexOf('Second for A'));
    expect(sent(b.email)[0]!.text).toContain('Only for B');
    const rows = await app.db
      .select()
      .from(notifications)
      .where(inArray(notifications.userId, [aId, bId]));
    expect(rows.every((n) => n.emailedAt)).toBe(true);
  });
});
