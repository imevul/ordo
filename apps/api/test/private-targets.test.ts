import { createECDH, createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { Bootstrap } from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type Json, signup, testApp } from './helpers.ts';

/**
 * Every outbound request to a URL someone typed must honour allowPrivateNetworkTargets. The other
 * tests boot with it on (their mock servers live on 127.0.0.1), so this file boots one app with the
 * default (off) and one with it on, drives each call site at a listener on 127.0.0.1, and checks
 * the first never connects while the second does — which proves the trigger really reaches out.
 */

/** Counts TCP connections and drops them at once, so whatever spoke to it fails fast. */
interface Trap {
  server: Server;
  port: number;
  connections: number;
}

async function trap(): Promise<Trap> {
  const t = { connections: 0 } as Trap;
  t.server = createServer((socket) => {
    t.connections++;
    socket.destroy();
  });
  await new Promise<void>((r) => t.server.listen(0, '127.0.0.1', r));
  t.port = (t.server.address() as { port: number }).port;
  return t;
}

interface World {
  app: FastifyInstance;
  owner: Client;
  member: Client;
  memberId: string;
  slug: string;
  ws: string;
  teamId: string;
  trap: Trap;
}

let n = 0;
async function world(allowPrivateNetworkTargets: boolean): Promise<World> {
  const app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets } });
  const slug = `pt-${++n}-${Date.now()}`;
  const ws = `/api/w/${slug}`;
  const owner = (await signup(app, 'Petra Private')).client;
  await owner.post('/api/workspaces', { name: 'PT', slug, teamName: 'Eng', teamKey: 'ENG' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  const member = (await signup(app, 'Max Member', { inviteToken: invite })).client;
  const memberId = (await member.get('/api/auth/me')).data.id;
  const teamId = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!.id;
  return { app, owner, member, memberId, slug, ws, teamId, trap: await trap() };
}

async function settle(app: FastifyInstance) {
  for (let i = 0; i < 3; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

const TOKEN = 'private_target_token_0123';

/** A call site: `run` points it at `origin` and answers what the app reported (null: nothing). */
interface Target {
  name: string;
  host?: string;
  /** Whether the refusal names the reason; some sites only say they couldn't connect. */
  explains?: boolean;
  run: (w: World, origin: string) => Promise<unknown>;
}

const integration = (provider: string, config: Record<string, unknown>, secrets: object) =>
  (async (w) =>
    (await w.owner.post(`${w.ws}/integrations`, { provider, config, secrets }))
      .data) satisfies Target['run'];

const apiImport = (body: Record<string, unknown>) =>
  (async (w) => {
    const res = await w.owner.post(`${w.ws}/imports`, { token: TOKEN, ...body });
    if (res.statusCode !== 200) return res.data;
    await settle(w.app);
    return (await w.owner.get(`${w.ws}/imports/${res.data.id}`)).data;
  }) satisfies Target['run'];

const webhook: Target['run'] = async (w, origin) => {
  const created = await w.owner.post(`${w.ws}/webhooks`, { url: `${origin}/hook` });
  const id = created.data.webhook.id;
  await w.owner.post(`${w.ws}/webhooks/${id}/ping`);
  await settle(w.app);
  return (await w.owner.get(`${w.ws}/webhooks/${id}/deliveries`)).data;
};

const targets: Target[] = [
  { name: 'webhook delivery', run: webhook },
  // Blocked at connect time, where undici reports only "fetch failed".
  {
    name: 'webhook delivery to a name that resolves privately',
    host: 'localhost',
    explains: false,
    run: webhook,
  },
  {
    name: 'OAuth client ID metadata document',
    run: async (w, origin) => {
      const verifier = randomBytes(32).toString('base64url');
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: `${origin}/client.json`,
        redirect_uri: 'http://localhost:4567/callback',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: `${w.app.env.publicUrl}${w.ws}/mcp`,
      });
      return (await w.owner.get(`/api/oauth/authorize?${params}`)).data;
    },
  },
  {
    name: 'SAML metadata URL',
    run: async (w, origin) =>
      (await w.owner.post(`${w.ws}/auth-providers/saml/metadata`, { url: `${origin}/metadata` }))
        .data,
  },
  {
    name: 'OpenID Connect discovery',
    explains: false,
    run: async (w, origin) => {
      const created = await w.owner.post(`${w.ws}/auth-providers`, {
        name: 'Private IdP',
        issuer: origin,
        clientId: 'ordo',
        clientSecret: 'secret',
      });
      const start = await w.app.inject({
        method: 'GET',
        url: `/api/auth/oidc/${created.data.id}/start`,
      });
      return decodeURIComponent(String(start.headers.location));
    },
  },
  {
    name: "a workspace's own AI model",
    run: async (w, origin) => {
      await w.owner.put(`${w.ws}/ai/provider`, {
        provider: 'openai',
        model: 'm',
        baseUrl: `${origin}/v1`,
        apiKey: null,
      });
      return (await w.owner.post(`${w.ws}/ai/provider/test`)).data;
    },
  },
  {
    name: 'web push endpoint',
    run: async (w, origin) => {
      const ua = createECDH('prime256v1');
      ua.generateKeys();
      const sub = await w.member.post('/api/me/push-subscriptions', {
        endpoint: `${origin}/device`,
        keys: {
          p256dh: ua.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      });
      expect(sub.statusCode, sub.body).toBe(200);
      await w.owner.post(`${w.ws}/issues`, {
        teamId: w.teamId,
        title: 'Push me',
        assigneeId: w.memberId,
      });
      await settle(w.app);
      return null;
    },
  },
  {
    name: 'GitHub integration API URL',
    run: (w, origin) =>
      integration(
        'github',
        { repos: 'acme/app', apiUrl: origin, webUrl: 'https://github.example' },
        { token: TOKEN },
      )(w),
  },
  {
    name: 'GitLab integration',
    run: (w, origin) =>
      integration('gitlab', { baseUrl: origin, projects: 'acme/app' }, { token: TOKEN })(w),
  },
  {
    name: 'Forgejo integration',
    run: (w, origin) =>
      integration('forgejo', { baseUrl: origin, repos: 'acme/app' }, { token: TOKEN })(w),
  },
  {
    name: 'Matrix homeserver',
    run: (w, origin) =>
      integration('matrix', { homeserverUrl: origin, channels: [] }, { accessToken: TOKEN })(w),
  },
  {
    name: 'Jira integration',
    run: (w, origin) =>
      integration('jira', { siteUrl: origin }, { token: TOKEN, email: 'a@example.com' })(w),
  },
  {
    name: 'IMAP intake',
    run: (w, origin) =>
      integration(
        'email',
        {
          delivery: 'imap',
          teamId: w.teamId,
          host: new URL(origin).hostname,
          port: Number(new URL(origin).port),
          secure: false,
          username: 'intake',
        },
        { password: 'pw' },
      )(w),
  },
  {
    name: 'GitHub Enterprise import',
    run: (w, origin) => apiImport({ source: 'github', apiUrl: origin, repos: ['acme/app'] })(w),
  },
  {
    name: 'GitLab import',
    run: (w, origin) => apiImport({ source: 'gitlab', baseUrl: origin, projects: ['acme/app'] })(w),
  },
  {
    name: 'Forgejo import',
    run: (w, origin) => apiImport({ source: 'forgejo', baseUrl: origin, repos: ['acme/app'] })(w),
  },
  {
    name: 'Jira import',
    run: (w, origin) =>
      apiImport({ source: 'jira', siteUrl: origin, email: 'a@example.com', projects: ['ENG'] })(w),
  },
];

let blocked: World;
let allowed: World;

beforeAll(async () => {
  [blocked, allowed] = await Promise.all([world(false), world(true)]);
});
afterAll(async () => {
  for (const w of [blocked, allowed]) {
    w.trap.server.close();
    await w.app.close();
  }
});

const originFor = (w: World, t: Target) => `https://${t.host ?? '127.0.0.1'}:${w.trap.port}`;

describe('private network targets', () => {
  it('are off by default', () => {
    expect(blocked.app.settings.get('allowPrivateNetworkTargets')).toBe(false);
  });

  it.each(targets.map((t) => [t.name, t] as const))('refuses %s', async (_name, t) => {
    const before = blocked.trap.connections;
    const outcome = await t.run(blocked, originFor(blocked, t));
    expect(blocked.trap.connections - before).toBe(0);
    if (outcome !== null && t.explains !== false)
      expect(JSON.stringify(outcome as Json)).toMatch(/private address/i);
  });

  it.each(targets.map((t) => [t.name, t] as const))(
    'reaches out for %s once allowed (the control)',
    async (_name, t) => {
      const before = allowed.trap.connections;
      await t.run(allowed, originFor(allowed, t));
      expect(allowed.trap.connections - before).toBeGreaterThan(0);
    },
  );
});
