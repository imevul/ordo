import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, oauthGrants, oauthTokens } from '../src/db/schema.ts';
import { pruneOAuth } from '../src/services/oauth.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let ada: Client;
let bob: Client;
let base: string;
let resource: string;
let metadataServer: Server;
let metadataDoc: Record<string, unknown> = {};
let metadataUrl: string;

const REDIRECT = 'http://localhost:4567/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/oauth/register',
    payload: {
      client_name: 'Test agent',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      ...body,
    },
  });
  return Object.assign(res, { data: res.json() });
}

/** Form-encoded, as OAuth clients send it. */
async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(params).toString(),
  });
  return Object.assign(res, { data: res.json() });
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource,
    scope: 'mcp',
    ...extra,
  };
}

/** Consents as `who` and returns the code from the redirect. */
async function consent(clientId: string, challenge: string, who = ada) {
  const res = await who.post('/api/oauth/authorize', {
    ...authorizeParams(clientId, challenge),
    approve: true,
  });
  expect(res.statusCode, res.body).toBe(200);
  const url = new URL(res.data.redirect);
  expect(url.searchParams.get('state')).toBe('xyz');
  expect(url.searchParams.get('iss')).toBe(base);
  return url.searchParams.get('code')!;
}

/** A full sign-in: registration, consent, code exchange. */
async function connect() {
  const { data: client } = await register();
  const { verifier, challenge } = pkce();
  const code = await consent(client.client_id, challenge);
  const res = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    resource,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { clientId: client.client_id as string, ...res.data };
}

async function mcp(bearer: string, url = '/api/w/oa/mcp') {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  return Object.assign(res, { data: res.json() });
}

beforeAll(async () => {
  app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets: true } });
  base = app.env.publicUrl;
  resource = `${base}/api/w/oa/mcp`;
  ada = (await signup(app, 'Ada Lovelace')).client;
  bob = (await signup(app, 'Bob Babbage')).client;
  for (const slug of ['oa', 'oa-other'])
    await ada.post('/api/workspaces', { name: slug, slug, teamName: 'Eng', teamKey: 'ENG' });
  metadataServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(metadataDoc));
  });
  await new Promise<void>((r) => metadataServer.listen(0, '127.0.0.1', r));
  metadataUrl = `http://127.0.0.1:${(metadataServer.address() as AddressInfo).port}/client.json`;
});

afterAll(async () => {
  metadataServer.close();
  await app.close();
});

describe('discovery', () => {
  it('serves authorization server and protected resource metadata', async () => {
    const as = (await app.inject('/.well-known/oauth-authorization-server')).json();
    expect(as.issuer).toBe(base);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint).toBe(`${base}/api/oauth/token`);

    const res = await app.inject('/.well-known/oauth-protected-resource/api/w/oa/mcp');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.json()).toMatchObject({ resource, authorization_servers: [base] });
  });

  it('points unauthenticated MCP requests at the metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/w/oa/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/api/w/oa/mcp"`,
    );
  });
});

describe('registration', () => {
  it('registers public and confidential clients', async () => {
    const pub = await register();
    expect(pub.statusCode).toBe(201);
    expect(pub.data.client_secret).toBeUndefined();
    const conf = await register({ token_endpoint_auth_method: 'client_secret_post' });
    expect(conf.data.client_secret).toBeTruthy();
  });

  it('refuses unsafe redirect URIs', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://x.example/#a'])
      expect((await register({ redirect_uris: [uri] })).data.error).toBe('invalid_redirect_uri');
    // Native apps: loopback http and their own schemes.
    expect((await register({ redirect_uris: ['cursor://anysphere/cb'] })).statusCode).toBe(201);
  });
});

describe('authorization', () => {
  it('shows the consent screen what is being asked', async () => {
    const { data: client } = await register();
    const res = await ada.get(
      `/api/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, pkce().challenge))}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data).toMatchObject({
      client: { name: 'Test agent', host: 'localhost:4567', verified: false },
      workspace: { slug: 'oa' },
    });
  });

  it('shows bad clients to the person and sends other errors back to the app', async () => {
    const { data: client } = await register();
    const q = (extra: Record<string, string>) =>
      ada.get(
        `/api/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, pkce().challenge, extra))}`,
      );
    const wrongRedirect = await q({ redirect_uri: 'https://elsewhere.example/cb' });
    expect(wrongRedirect.statusCode).toBe(400);
    expect(wrongRedirect.data.details).toBeUndefined();

    const noPkce = await q({ code_challenge_method: 'plain' });
    expect(new URL(noPkce.data.details.redirect).searchParams.get('error')).toBe('invalid_request');
    const badResource = await q({ resource: 'https://other.example/mcp' });
    expect(new URL(badResource.data.details.redirect).searchParams.get('error')).toBe(
      'invalid_target',
    );
  });

  it('needs a member of the workspace, signed in with a session', async () => {
    const { data: client } = await register();
    const params = { ...authorizeParams(client.client_id, pkce().challenge), approve: true };
    expect((await bob.post('/api/oauth/authorize', params)).statusCode).toBe(404);
    const anon = await app.inject({ method: 'POST', url: '/api/oauth/authorize', payload: params });
    expect(anon.statusCode).toBe(401);
  });

  it('tells the app when the person declines', async () => {
    const { data: client } = await register();
    const res = await ada.post('/api/oauth/authorize', {
      ...authorizeParams(client.client_id, pkce().challenge),
      approve: false,
    });
    expect(new URL(res.data.redirect).searchParams.get('error')).toBe('access_denied');
  });

  it('accepts any loopback port (RFC 8252)', async () => {
    const { data: client } = await register();
    const res = await ada.post('/api/oauth/authorize', {
      ...authorizeParams(client.client_id, pkce().challenge, {
        redirect_uri: 'http://localhost:9999/callback',
      }),
      approve: true,
    });
    expect(res.data.redirect).toMatch(/^http:\/\/localhost:9999\/callback\?code=/);
  });
});

describe('tokens', () => {
  it('exchanges a code once, only with the right verifier', async () => {
    const { data: client } = await register();
    const { verifier, challenge } = pkce();
    const code = await consent(client.client_id, challenge);
    const wrong = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce().verifier,
      client_id: client.client_id,
    });
    expect(wrong.data.error).toBe('invalid_grant');
    // The failed attempt used the code up.
    const again = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
    });
    expect(again.data.error).toBe('invalid_grant');

    const code2 = await consent(client.client_id, challenge);
    const ok = await token({
      grant_type: 'authorization_code',
      code: code2,
      code_verifier: verifier,
      client_id: client.client_id,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.data).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
  });

  it("won't hand one app's code to another", async () => {
    const { data: a } = await register();
    const { data: b } = await register();
    const { verifier, challenge } = pkce();
    const code = await consent(a.client_id, challenge);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: b.client_id,
    });
    expect(res.data.error).toBe('invalid_grant');
  });

  it('authenticates confidential clients by post or Basic', async () => {
    const { data: client } = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    const { verifier, challenge } = pkce();
    const code = await consent(client.client_id, challenge);
    const params = { grant_type: 'authorization_code', code, code_verifier: verifier };
    const noSecret = await token({ ...params, client_id: client.client_id });
    expect(noSecret.statusCode).toBe(401);
    expect(noSecret.data.error).toBe('invalid_client');
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const code2 = await consent(client.client_id, challenge);
    const ok = await token({ ...params, code: code2 }, { authorization: `Basic ${basic}` });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('are accepted from other origins', async () => {
    const res = await token(
      { grant_type: 'client_credentials', client_id: 'nobody' },
      { origin: 'https://claude.ai', 'sec-fetch-site': 'cross-site' },
    );
    expect(res.data.error).toBe('invalid_client');
    // The consent itself is cookie-authenticated and stays same-site only.
    const consentRes = await app.inject({
      method: 'POST',
      url: '/api/oauth/authorize',
      headers: { cookie: ada.cookie, origin: 'https://evil.example' },
      payload: {},
    });
    expect(consentRes.statusCode).toBe(403);
  });
});

describe('using tokens', () => {
  it('opens the MCP endpoint of that workspace and nothing else', async () => {
    const { access_token } = await connect();
    const ok = await mcp(access_token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.data.result.tools.length).toBeGreaterThan(0);

    const other = await mcp(access_token, '/api/w/oa-other/mcp');
    expect(other.statusCode).toBe(401);
    for (const url of ['/api/me/api-keys', '/api/w/oa/bootstrap']) {
      const res = await app.inject({ url, headers: { authorization: `Bearer ${access_token}` } });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('rotates refresh tokens and ends the grant when one is replayed', async () => {
    const { clientId, refresh_token } = await connect();
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: clientId,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.data.refresh_token).not.toBe(refresh_token);

    // A second use right away is a client racing itself: refused, but nothing is revoked.
    const race = await token({ grant_type: 'refresh_token', refresh_token, client_id: clientId });
    expect(race.data.error).toBe('invalid_grant');
    expect((await mcp(refreshed.data.access_token)).statusCode).toBe(200);

    // Later, it means the token leaked.
    await app.db
      .update(oauthTokens)
      .set({ usedAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(oauthTokens.kind, 'refresh'));
    const replay = await token({ grant_type: 'refresh_token', refresh_token, client_id: clientId });
    expect(replay.data.error).toBe('invalid_grant');
    expect((await mcp(refreshed.data.access_token)).statusCode).toBe(401);
  });

  it('revokes through the revocation endpoint', async () => {
    const { clientId, access_token, refresh_token } = await connect();
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ token: refresh_token, client_id: clientId }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect((await mcp(access_token)).statusCode).toBe(401);
  });

  it('lists connected apps, and disconnecting one ends its tokens', async () => {
    const { access_token } = await connect();
    const list = (await ada.get('/api/me/oauth-grants')).data;
    expect(list[0]).toMatchObject({ client: { name: 'Test agent' }, workspace: { slug: 'oa' } });
    expect((await bob.get('/api/me/oauth-grants')).data).toEqual([]);
    // Someone else's grant can't be removed.
    await bob.del(`/api/me/oauth-grants/${list[0].id}`);
    expect((await mcp(access_token)).statusCode).toBe(200);

    await ada.del(`/api/me/oauth-grants/${list[0].id}`);
    expect((await mcp(access_token)).statusCode).toBe(401);
    const actions = (await app.db.select({ action: auditLog.action }).from(auditLog)).map(
      (r) => r.action,
    );
    expect(actions).toContain('oauth.authorized');
    expect(actions).toContain('oauth.revoked');
  });

  it('prunes grants whose tokens all expired', async () => {
    const { access_token } = await connect();
    const before = (await app.db.select().from(oauthGrants)).length;
    const [row] = await app.db
      .select({ grantId: oauthTokens.grantId })
      .from(oauthTokens)
      .orderBy(oauthTokens.createdAt)
      .limit(1);
    await app.db
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(oauthTokens.grantId, row!.grantId));
    await pruneOAuth(app.db);
    expect((await app.db.select().from(oauthGrants)).length).toBe(before - 1);
    expect((await mcp(access_token)).statusCode).toBe(200);
  });
});

describe('client ID metadata documents', () => {
  it('reads the app from the document its client_id points at', async () => {
    metadataDoc = {
      client_id: metadataUrl,
      client_name: 'Docs Agent',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    };
    const { verifier, challenge } = pkce();
    const info = await ada.get(
      `/api/oauth/authorize?${new URLSearchParams(authorizeParams(metadataUrl, challenge))}`,
    );
    expect(info.statusCode, info.body).toBe(200);
    expect(info.data.client).toEqual({
      name: 'Docs Agent',
      host: new URL(metadataUrl).host,
      verified: true,
    });
    const code = await consent(metadataUrl, challenge);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: metadataUrl,
    });
    expect((await mcp(res.data.access_token)).statusCode).toBe(200);
  });

  it("refuses a document that isn't about itself", async () => {
    const url = metadataUrl.replace('client.json', 'other.json');
    metadataDoc = {
      client_id: 'https://someone-else.example/client.json',
      redirect_uris: [REDIRECT],
    };
    const res = await ada.get(
      `/api/oauth/authorize?${new URLSearchParams(authorizeParams(url, pkce().challenge))}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('invalid_client');
  });
});
