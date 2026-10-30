import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProvider, unregisterProvider } from '../src/integrations/registry.ts';
import { saveFile, signedFileUrl } from '../src/services/files.ts';
import { type Client, signup, testApp } from './helpers.ts';

// Routes whose query strings answer bad input their own way: a redirect, a 404, a closed socket,
// a JSON 400 for the consent page, or (hooks) never at all. SCIM's are in scim.test.ts.

let app: FastifyInstance;
let user: Client;
let userId: string;
const slug = `cbq-${Date.now()}`;

beforeAll(async () => {
  app = await testApp();
  user = (await signup(app, 'Quinn Query')).client;
  userId = (await user.get('/api/auth/me')).data.id;
  await user.post('/api/workspaces', { name: 'Cbq', slug, teamName: 'Core', teamKey: 'CBQ' });
});
afterAll(() => app.close());

const errorOf = (location: string | undefined) =>
  new URL(location ?? '', 'http://x').searchParams.get('error');

describe('sign-in', () => {
  it('discovery and provider lists answer a malformed query with a 400', async () => {
    expect((await user.get('/api/auth/discover?email=a@b.test')).statusCode).toBe(200);
    expect((await user.get('/api/auth/discover?email=a@b.test&email=c@d.test')).statusCode).toBe(
      400,
    );
    expect((await user.get(`/api/auth/providers?workspace=${slug}`)).statusCode).toBe(200);
    expect((await user.get('/api/auth/providers?workspace=a&workspace=b')).statusCode).toBe(400);
  });

  it('a mangled start link goes back to the sign-in page', async () => {
    for (const query of ['mode=bogus', 'mode=login&mode=test', 'redirect=/a&redirect=/b']) {
      const res = await user.get(`/api/auth/sso/${randomUUID()}/start?${query}`);
      expect(res.statusCode, query).toBe(302);
      expect(res.headers.location, query).toMatch(/^\/login\?error=/);
      expect(errorOf(res.headers.location), query).toContain("isn't valid");
    }
    // A plain link still can't start linking an identity.
    expect((await user.get(`/api/auth/sso/${randomUUID()}/start?mode=link`)).statusCode).toBe(400);
  });

  it('a repeated SAML state is refused like a missing one', async () => {
    const res = await user.get('/api/auth/saml/complete?state=a&state=b');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?error=/);
  });
});

describe('integration callbacks', () => {
  it('GitHub redirects a malformed link back to the app', async () => {
    for (const path of [
      '/api/integrations/github/callback?code=a&code=b&state=s',
      '/api/integrations/github/setup?installation_id=1&installation_id=2&state=s',
      '/api/integrations/github/authorized?code=c&state=s&state=t',
    ]) {
      const res = await user.get(path);
      expect(res.statusCode, path).toBe(302);
      expect(errorOf(res.headers.location), path).toContain('malformed');
    }
  });

  it('Slack redirects a malformed link back to the app', async () => {
    const res = await user.get('/api/integrations/slack/callback?code=a&state=s&error=x&error=y');
    expect(res.statusCode).toBe(302);
    expect(errorOf(res.headers.location)).toContain('malformed');
  });
});

describe('OAuth consent', () => {
  it('refuses a repeated parameter on the consent page, without redirecting', async () => {
    const res = await user.get('/api/oauth/authorize?client_id=a&client_id=b&response_type=code');
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('invalid_request');
    expect(res.data.details).toBeUndefined();
  });
});

describe('signed files', () => {
  it('answers a malformed exp or sig with the same 404 as a wrong one', async () => {
    const file = await saveFile(app, {
      workspaceId: null,
      ownerId: userId,
      kind: 'avatar',
      filename: 'a.bin',
      body: Buffer.from('hello'),
    });
    const url = signedFileUrl(app, file.id)!;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    const { searchParams } = new URL(url, 'http://x');
    const exp = searchParams.get('exp')!;
    const sig = searchParams.get('sig')!;
    for (const query of [
      `exp=${exp}&exp=${exp}&sig=${sig}`,
      `exp=${exp}&sig=${sig}&sig=${sig}`,
      `exp=soon&sig=${sig}`,
      `exp=${exp}`,
      '',
      `exp=${exp}&sig=wrong`,
    ]) {
      const res = await app.inject({ method: 'GET', url: `/api/files/${file.id}?${query}` });
      expect(res.statusCode, query).toBe(404);
    }
  });
});

describe('realtime', () => {
  const close = (query: string) =>
    new Promise<number>((resolve) => {
      app
        .injectWS(`/api/ws?${query}`, { headers: { cookie: user.cookie } })
        .then((socket) => socket.on('close', (c) => resolve(c)));
    });

  it('closes with 4401, which the client does not retry, on a malformed query', async () => {
    expect(await close(`workspace=${slug}&workspace=${slug}`)).toBe(4401);
    expect(await close('')).toBe(4401);
    expect(await close('workspace=no-such-workspace')).toBe(4404);
  });
});

describe('inbound hooks', () => {
  beforeAll(() => {
    registerProvider({
      key: 'echoq',
      name: 'Echo',
      description: 'Answers with the query it was given',
      category: 'other',
      configure: ({ config, secrets }) => ({ config, secrets }),
      challenge: async (_app, _key, req) => ({ status: 200, body: JSON.stringify(req.query) }),
      handleInbound: async () => {},
    });
  });
  afterAll(() => unregisterProvider('echoq'));

  it('gives providers one string per key, the first of a repeated one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/echoq/k?a=1&b=2&a=3&empty=',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ a: '1', b: '2', empty: '' });
  });
});
