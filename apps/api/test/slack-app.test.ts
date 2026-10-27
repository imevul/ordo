import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrations, users } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let other: Client;
const slug = `slackapp-${Date.now()}`;
const ws = `/api/w/${slug}`;
const otherWs = `/api/w/${slug}-b`;
const signingSecret = 'app-signing-secret';

async function settle() {
  for (let i = 0; i < 2; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

const signed = (body: string, secret = signingSecret, contentType = 'application/json') => {
  const ts = Math.floor(Date.now() / 1000);
  return app.inject({
    method: 'POST',
    url: '/api/hooks/slack/app',
    payload: body,
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': String(ts),
      'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`,
    },
  });
};

/** Starts "Add to Slack" in a workspace and follows Slack back to Ordo. */
async function addToSlack(who: Client, path: string) {
  const { url } = (await who.post(`${path}/integrations/slack/install`)).data as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  return who.get(`/api/integrations/slack/callback?code=the-code&state=${state}`);
}

beforeAll(async () => {
  mock = await startMockForge();
  process.env.ORDO_SLACK_API_URL = mock.url;
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  const o = await signup(app, 'Ines Instance');
  owner = o.client;
  await app.db.update(users).set({ isInstanceAdmin: true }).where(eq(users.email, o.email));
  await owner.post('/api/workspaces', { name: 'Slacky', slug, teamName: 'Alpha', teamKey: 'ALP' });
  other = (await signup(app, 'Otto Other')).client;
  await other.post('/api/workspaces', {
    name: 'Other',
    slug: `${slug}-b`,
    teamName: 'Beta',
    teamKey: 'BET',
  });
  mock.on('POST', '/oauth.v2.access', {
    ok: true,
    access_token: 'xoxb-from-oauth',
    bot_user_id: 'UAPP',
    team: { id: 'T9', name: 'Nine' },
  });
  mock.on('POST', '/chat.postMessage', { ok: true, ts: '9.9' });
  mock.on('POST', '/auth.revoke', { ok: true });
});
afterAll(async () => {
  delete process.env.ORDO_SLACK_API_URL;
  await app.close();
  await mock.close();
});

describe('one-click Slack', () => {
  it('offers a filled-in manifest to instance admins and keeps the app credentials', async () => {
    const before = (await owner.get(`${ws}/integrations/slack/app`)).data;
    expect(before.app).toBeNull();
    const manifest = JSON.parse(
      new URL(before.manifests.events).searchParams.get('manifest_json')!,
    );
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `${app.env.publicUrl}/api/hooks/slack/app`,
    );
    expect(manifest.oauth_config.redirect_urls).toEqual([
      `${app.env.publicUrl}/api/integrations/slack/callback`,
    ]);
    const socket = JSON.parse(new URL(before.manifests.socket).searchParams.get('manifest_json')!);
    expect(socket.settings.socket_mode_enabled).toBe(true);
    expect(socket.settings.event_subscriptions.request_url).toBeUndefined();

    // Workspace admins who don't run the instance can't register it.
    expect(
      (
        await other.put(`${otherWs}/integrations/slack/app`, {
          delivery: 'events',
          clientId: '1.2',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await owner.put(`${ws}/integrations/slack/app`, { delivery: 'events', clientId: 'nope' }))
        .statusCode,
    ).toBe(400);
    const saved = await owner.put(`${ws}/integrations/slack/app`, {
      delivery: 'events',
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret,
    });
    expect(saved.statusCode).toBe(200);
    expect((await owner.get(`${ws}/integrations/slack/app`)).data.app).toEqual({
      delivery: 'events',
      clientId: '123.456',
    });
  });

  it("answers Slack's URL check on the shared address, signed by the app", async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'xyz' });
    const ok = await signed(body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ challenge: 'xyz' });
    expect((await signed(body, 'wrong')).statusCode).toBe(401);
  });

  it('connects a Slack workspace with OAuth', async () => {
    const back = await addToSlack(owner, ws);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`/${slug}/settings/integrations`);
    const exchange = mock.calls('POST', '/oauth.v2.access').at(-1)!;
    expect(exchange.headers.authorization).toBe(
      `Basic ${Buffer.from('123.456:client-secret').toString('base64')}`,
    );
    expect(exchange.path).toContain('code=the-code');

    const [row] = await app.db
      .select()
      .from(integrations)
      .where(and(eq(integrations.provider, 'slack'), eq(integrations.externalId, 'T9')));
    expect(row).toMatchObject({
      name: 'Slack · Nine',
      config: { mode: 'app', delivery: 'events' },
    });
    expect(row!.state).toMatchObject({ teamId: 'T9', botUserId: 'UAPP' });
    // The list shows no webhook URL of its own: the app's is shared.
    const listed = (await owner.get(`${ws}/integrations`)).data.integrations;
    expect(listed.find((i: { id: string }) => i.id === row!.id).inboundUrl).toBeNull();

    // A state is good once, and only for the person who started.
    const { url } = (await owner.post(`${ws}/integrations/slack/install`)).data;
    const state = new URL(url).searchParams.get('state');
    const stolen = await other.get(`/api/integrations/slack/callback?code=c&state=${state}`);
    expect(stolen.headers.location).toContain('error=');
  });

  it('routes events to the workspace connected to their Slack team', async () => {
    const before = mock.calls('POST', '/chat.postMessage').length;
    const event = (team: string, id: string) =>
      JSON.stringify({
        type: 'event_callback',
        team_id: team,
        event_id: id,
        event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'help' },
      });
    expect((await signed(event('T9', 'Ev1'))).statusCode).toBe(200);
    await settle();
    const reply = mock.calls('POST', '/chat.postMessage').slice(before);
    expect(reply).toHaveLength(1);
    expect(reply[0]!.headers.authorization).toBe('Bearer xoxb-from-oauth');
    // A Slack workspace nobody connected has no hook here.
    expect((await signed(event('T404', 'Ev2'))).statusCode).toBe(404);
  });

  it('keeps one Slack workspace in one Ordo workspace and revokes the token on removal', async () => {
    const elsewhere = await addToSlack(other, otherWs);
    expect(decodeURIComponent(elsewhere.headers.location as string)).toContain(
      'Nine is already connected to another Ordo workspace',
    );
    const [row] = await app.db.select().from(integrations).where(eq(integrations.externalId, 'T9'));
    expect((await owner.del(`${ws}/integrations/${row!.id}`)).statusCode).toBe(200);
    expect(mock.calls('POST', '/auth.revoke').at(-1)!.headers.authorization).toBe(
      'Bearer xoxb-from-oauth',
    );
    // Now the other workspace may have it.
    expect((await addToSlack(other, otherWs)).headers.location).toBe(
      `/${slug}-b/settings/integrations`,
    );
  });
});
