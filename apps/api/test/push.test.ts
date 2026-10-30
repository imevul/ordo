import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Bootstrap } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pushSubscriptions } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let server: Server;
let base = '';
let owner: Client;
let member: Client;
const ws = '/api/w/push';
const ids: Record<string, string> = {};
const received: { path: string; headers: Record<string, unknown>; body: Buffer }[] = [];

const ua = createECDH('prime256v1');
ua.generateKeys();
const auth = Buffer.alloc(16, 3);

const expand = (prk: Buffer, info: string | Buffer, n: number) =>
  createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest()
    .subarray(0, n);

function open(body: Buffer) {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 86);
  const shared = ua.computeSecret(asPublic);
  const ikm = expand(
    createHmac('sha256', auth).update(shared).digest(),
    Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]),
    32,
  );
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const d = createDecipheriv(
    'aes-128-gcm',
    expand(prk, 'Content-Encoding: aes128gcm\0', 16),
    expand(prk, 'Content-Encoding: nonce\0', 12),
  );
  d.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([d.update(body.subarray(86, -16)), d.final()]);
  return JSON.parse(plain.subarray(0, -1).toString());
}

async function settle() {
  for (let i = 0; i < 2; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url!.includes('gone') ? 410 : 201;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets: true } });
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Push',
    slug: 'push',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  member = (
    await signup(app, 'Mona Member', {
      inviteToken: (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token,
    })
  ).client;
  ids.member = (await member.get('/api/auth/me')).data.id;
  ids.team = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!.id;
});

afterAll(async () => {
  await app.close();
  server.close();
});

describe('web push', () => {
  it('hands out one stable public key', async () => {
    const a = (await member.get('/api/push/key')).data.publicKey;
    expect(Buffer.from(a, 'base64url')).toHaveLength(65);
    expect((await owner.get('/api/push/key')).data.publicKey).toBe(a);
  });

  it('takes https subscriptions from signed-in people', async () => {
    const keys = {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    };
    expect(
      (await member.post('/api/me/push-subscriptions', { endpoint: 'http://example.com/x', keys }))
        .statusCode,
    ).toBe(400);
    const ok = await member.post('/api/me/push-subscriptions', {
      endpoint: 'https://push.example.com/device-1',
      keys,
    });
    expect(ok.statusCode).toBe(200);
    expect((await member.del('/api/me/push-subscriptions')).statusCode).toBe(400);
    await member.req('DELETE', '/api/me/push-subscriptions', {
      endpoint: 'https://push.example.com/device-1',
    });
    expect(
      await app.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, ids.member!)),
    ).toHaveLength(0);
  });

  it('pushes notifications, encrypted for the device, and drops gone ones', async () => {
    // The receiver here is plain HTTP on localhost, which the API wouldn't accept from a browser.
    const keys = {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    };
    await app.db.insert(pushSubscriptions).values([
      { userId: ids.member!, endpoint: `${base}/device`, ...keys },
      { userId: ids.member!, endpoint: `${base}/gone`, ...keys },
    ]);
    const issue = (
      await owner.post(`${ws}/issues`, {
        teamId: ids.team,
        title: 'Fix login',
        assigneeId: ids.member,
      })
    ).data as { identifier: string };
    await settle();
    const push = received.find((r) => r.path === '/device')!;
    expect(push.headers['content-encoding']).toBe('aes128gcm');
    expect(String(push.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    expect(open(push.body)).toMatchObject({
      title: `${issue.identifier} Fix login`,
      body: 'Olga Owner assigned you',
      url: `/push/issue/${issue.identifier}`,
    });
    const left = await app.db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, ids.member!));
    expect(left.map((s) => s.endpoint)).toEqual([`${base}/device`]);
  });

  it("writes the push in its reader's language", async () => {
    await member.patch('/api/me/preferences', { locale: 'nb' });
    const before = received.length;
    await owner.post(`${ws}/issues`, { teamId: ids.team, title: 'Norsk', assigneeId: ids.member });
    await settle();
    const push = received.slice(before).find((r) => r.path === '/device')!;
    expect(open(push.body).body).toBe('Olga Owner gjorde deg ansvarlig');
  });
});
