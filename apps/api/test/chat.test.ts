import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Bootstrap, ChatService, Integration, IssueDetail } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, externalAccounts, integrations, leases } from '../src/db/schema.ts';
import { discordProvider } from '../src/integrations/discord.ts';
import { registerProvider, unregisterProvider } from '../src/integrations/registry.ts';
import { telegramCommand } from '../src/integrations/telegram.ts';
import type { IntegrationProvider } from '../src/integrations/types.ts';
import { Leases } from '../src/lib/jobs/index.ts';
import { createLinkCode } from '../src/services/chat.ts';
import { Connectors, sleep } from '../src/services/connectors.ts';
import { queueInbound } from '../src/services/integrations.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let bob: Client;
let bobId: string;
let boot: Bootstrap;
let secretTeamId: string;
const slug = `chat-${Date.now()}`;
const ws = `/api/w/${slug}`;
const alpha = () => boot.teams.find((t) => t.key === 'ALP')!;

async function settle(rounds = 2) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

/** Waits for background work (connectors) to produce something. */
async function until<T>(check: () => T | undefined | false, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    await settle(1);
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const newIssue = async (title: string, teamId = alpha().id) =>
  (await owner.post(`${ws}/issues`, { teamId, title })).data as { id: string; identifier: string };
const issueUrl = (identifier: string) => `${app.env.publicUrl}/${slug}/issue/${identifier}`;
const hookPath = (i: Integration) => i.inboundUrl!.slice(app.env.publicUrl.length);
const linkCode = async (integrationId: string, who = bob) =>
  (await who.post(`${ws}/me/chat-accounts/${integrationId}/code`)).data.code as string;
const auditActions = async () =>
  (await app.db.select().from(auditLog).where(sql`${auditLog.action} like 'chat_account.%'`)).map(
    (a) => a.action,
  );

beforeAll(async () => {
  mock = await startMockForge();
  process.env.ORDO_SLACK_API_URL = mock.url;
  process.env.ORDO_DISCORD_API_URL = mock.url;
  process.env.ORDO_TELEGRAM_API_URL = mock.url;
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  owner = (await signup(app, 'Olive Owner')).client;
  await owner.post('/api/workspaces', { name: 'Chat', slug, teamName: 'Alpha', teamKey: 'ALP' });
  secretTeamId = (await owner.post(`${ws}/teams`, { name: 'Secret', key: 'SEC', private: true }))
    .data.id;
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  bob = (await signup(app, 'Bob Member', { inviteToken: invite.token })).client;
  bobId = (await bob.get('/api/auth/me')).data.id;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
});
afterAll(async () => {
  delete process.env.ORDO_SLACK_API_URL;
  delete process.env.ORDO_DISCORD_API_URL;
  delete process.env.ORDO_TELEGRAM_API_URL;
  await app.close();
  await mock.close();
});

// ─── Slack ────────────────────────────────────────────────────────────────

describe('Slack', () => {
  let slack: Integration;
  const signingSecret = 'slack-signing-secret';

  const deliver = (
    body: string,
    contentType = 'application/json',
    opts: { secret?: string; ts?: number } = {},
  ) => {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    return app.inject({
      method: 'POST',
      url: hookPath(slack),
      payload: body,
      headers: {
        'content-type': contentType,
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': `v0=${createHmac('sha256', opts.secret ?? signingSecret)
          .update(`v0:${ts}:${body}`)
          .digest('hex')}`,
      },
    });
  };
  const command = (user: string, text: string, n = Math.random()) =>
    deliver(
      new URLSearchParams({
        command: '/ordo',
        text,
        user_id: user,
        user_name: user.toLowerCase(),
        channel_id: 'C1',
        channel_name: 'general',
        response_url: `${mock.url}/respond/${n}`,
        trigger_id: `trig-${n}`,
      }).toString(),
      'application/x-www-form-urlencoded',
    );
  const responses = () => mock.log.filter((r) => r.path.startsWith('/respond/'));
  const lastResponse = () => JSON.stringify(responses().at(-1)?.body ?? null);
  const posts = (channel: string) =>
    mock
      .calls('POST', '/chat.postMessage')
      .filter((c) => (c.body as { channel: string }).channel === channel)
      .map((c) => JSON.stringify(c.body));

  beforeAll(() => {
    mock.on('POST', '/auth.test', { ok: true, team: 'Acme', team_id: 'T1', user_id: 'UBOT' });
    mock.on('POST', '/chat.postMessage', { ok: true, ts: '1.1' });
    mock.on('POST', '/chat.unfurl', { ok: true });
    mock.on('POST', '/chat.getPermalink', {
      ok: true,
      permalink: 'https://acme.slack.com/archives/C1/p100',
    });
    mock.on('POST', '/users.info', { ok: true, user: { real_name: 'Carol Customer' } });
    mock.onPrefix('POST', '/respond/', {});
  });

  it('checks the tokens and connects', async () => {
    const bad = await owner.post(`${ws}/integrations`, {
      provider: 'slack',
      secrets: { botToken: 'nope', signingSecret },
    });
    expect(bad.statusCode).toBe(400);
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'slack',
      config: {
        delivery: 'events',
        channels: [
          { id: 'C1', events: ['issue.created', 'issue.completed', 'comment.created'] },
          { id: 'CSEC', teamIds: [secretTeamId], events: ['issue.created'] },
        ],
      },
      secrets: { botToken: 'xoxb-1', signingSecret },
    });
    expect(res.statusCode).toBe(200);
    slack = res.data;
    expect(slack.status).toBe('active');
    expect(slack.inboundUrl).toContain('/api/hooks/slack/');
    const [row] = await app.db.select().from(integrations).where(eq(integrations.id, slack.id));
    expect(row!.state.botUserId).toBe('UBOT');
  });

  it('answers the URL challenge and rejects unsigned or stale requests', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const ok = await deliver(body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ challenge: 'abc' });
    expect((await deliver(body, undefined, { secret: 'wrong' })).statusCode).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await deliver(body, undefined, { ts: stale })).statusCode).toBe(401);
  });

  it('posts subscribed activity to channels, keeping private teams to channels that name them', async () => {
    await settle();
    const before = { c1: posts('C1').length, sec: posts('CSEC').length };
    const issue = await newIssue('Flux capacitor leaks');
    await settle(3);
    expect(posts('C1').length).toBe(before.c1 + 1);
    expect(posts('C1').at(-1)).toContain(`created ${issue.identifier}`);
    expect(posts('C1').at(-1)).toContain(issueUrl(issue.identifier));
    expect(posts('CSEC').length).toBe(before.sec);

    const secret = await newIssue('Hidden plan', secretTeamId);
    await settle(3);
    expect(posts('CSEC').at(-1)).toContain(`created ${secret.identifier}`);
    expect(posts('C1').join()).not.toContain('Hidden plan');

    // Started isn't subscribed; completed is.
    const state = (name: string) => alpha().states.find((s) => s.name === name)!.id;
    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: state('In Progress') });
    await settle(3);
    expect(posts('C1').length).toBe(before.c1 + 1);
    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: state('Done') });
    await settle(3);
    expect(posts('C1').at(-1)).toContain(`moved ${issue.identifier} to Done`);
  });

  it('links an account with a one-time code', async () => {
    const services = (await bob.get(`${ws}/me/chat-accounts`)).data.services as ChatService[];
    expect(services.map((s) => s.integrationId)).toContain(slack.id);
    expect(services.find((s) => s.integrationId === slack.id)!.linkHint).toContain('/ordo link');

    const code = await linkCode(slack.id);
    expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect((await command('UBOB', `link ${code.toLowerCase()}`)).statusCode).toBe(200);
    await settle();
    expect(lastResponse()).toContain('Linked to Bob Member');
    // Single use.
    await command('UEVE', `link ${code}`);
    await settle();
    expect(lastResponse()).toContain('invalid or has expired');

    const mine = (await bob.get(`${ws}/me/chat-accounts`)).data.services as ChatService[];
    expect(mine.find((s) => s.integrationId === slack.id)!.accounts).toHaveLength(1);
    // Chat accounts can't be claimed like forge usernames, and don't show up among them.
    const claim = await bob.post(`${ws}/me/external-accounts`, {
      provider: 'slack',
      host: slack.id,
      username: 'UEVE',
    });
    expect(claim.statusCode).toBe(400);
    expect((await bob.get(`${ws}/me/external-accounts`)).data.accounts).toHaveLength(0);
    expect(await auditActions()).toContain('chat_account.linked');
  });

  it('sends personal notifications as direct messages, unless turned off', async () => {
    const issue = await newIssue('Assign me');
    await owner.patch(`${ws}/issues/${issue.id}`, { assigneeId: bobId });
    await settle(3);
    expect(posts('UBOB').at(-1)).toContain(`assigned you ${issue.identifier}`);

    const account = ((await bob.get(`${ws}/me/chat-accounts`)).data.services as ChatService[]).find(
      (s) => s.integrationId === slack.id,
    )!.accounts[0]!;
    // Someone else's account can't be changed.
    expect(
      (await owner.patch(`${ws}/me/chat-accounts/${account.id}`, { notify: false })).statusCode,
    ).toBe(404);
    await bob.patch(`${ws}/me/chat-accounts/${account.id}`, { notify: false });
    const count = posts('UBOB').length;
    await owner.post(`${ws}/issues/${issue.id}/comments`, { body: 'Ping @bob' });
    await settle(3);
    expect(posts('UBOB').length).toBe(count);
    await bob.patch(`${ws}/me/chat-accounts/${account.id}`, { notify: true });
  });

  it('drops queued direct messages when the account has moved to someone else', async () => {
    const issue = await newIssue('Queued for Bob');
    await owner.patch(`${ws}/issues/${issue.id}`, { assigneeId: bobId });
    // Re-linked to another Ordo user before the job ran.
    const ownerId = (await owner.get('/api/auth/me')).data.id as string;
    const moved = eq(externalAccounts.externalId, 'UBOB');
    await app.db.update(externalAccounts).set({ userId: ownerId }).where(moved);
    const count = posts('UBOB').length;
    try {
      await settle(3);
      expect(posts('UBOB').length).toBe(count);
    } finally {
      await app.db.update(externalAccounts).set({ userId: bobId }).where(moved);
    }
  });

  it('keeps link codes for other integrations when making a new one', async () => {
    const code = await linkCode(slack.id);
    await createLinkCode(app, bobId, boot.workspace.id, randomUUID());
    await command('UBOB', `link ${code}`);
    await settle();
    expect(lastResponse()).toContain('Linked to Bob Member');
  });

  it('creates issues from /ordo new, as the linked person', async () => {
    await command('UBOB', 'new ALP Login button is pink');
    await settle();
    expect(lastResponse()).toContain('Created ALP-');
    const identifier = /ALP-\d+/.exec(lastResponse())![0];
    const issue = (await owner.get(`${ws}/issues/${identifier}`)).data as IssueDetail;
    expect(issue.title).toBe('Login button is pink');
    expect(issue.creatorId).toBe(bobId);

    // Bob can't file into a private team he isn't in: the key is just part of the title.
    await command('UBOB', 'new SEC Sneaky');
    await settle();
    expect(lastResponse()).toContain('Created ALP-');

    await command('UEVE', 'new Something');
    await settle();
    expect(lastResponse()).toContain('Link your Ordo account first');
  });

  it('files a message from the message shortcut, quoting and linking it', async () => {
    const payload = {
      type: 'message_action',
      callback_id: 'create_issue',
      trigger_id: 'trig-shortcut',
      response_url: `${mock.url}/respond/shortcut`,
      user: { id: 'UBOB', username: 'bob' },
      channel: { id: 'C1' },
      message: { ts: '100.1', text: 'The export button does nothing', user: 'UCAROL' },
    };
    await deliver(
      new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
      'application/x-www-form-urlencoded',
    );
    await settle();
    const identifier = /ALP-\d+/.exec(lastResponse())![0];
    const issue = (await owner.get(`${ws}/issues/${identifier}`)).data as IssueDetail;
    expect(issue.title).toBe('The export button does nothing');
    expect(issue.description).toContain('> The export button does nothing');
    expect(issue.description).toContain('Carol Customer');
    expect(issue.links.map((l) => [l.kind, l.url])).toContainEqual([
      'message',
      'https://acme.slack.com/archives/C1/p100',
    ]);
  });

  it('unfurls issue links only for people who can read them', async () => {
    const open = await newIssue('Unfurl me');
    const hidden = await newIssue('Do not unfurl', secretTeamId);
    const shared = (user: string, url: string, n: string) =>
      deliver(
        JSON.stringify({
          type: 'event_callback',
          event_id: `Ev${n}`,
          event: {
            type: 'link_shared',
            user,
            channel: 'C1',
            message_ts: '1.2',
            links: [{ url }],
          },
        }),
      );
    await shared('UBOB', issueUrl(hidden.identifier), '1');
    await shared('UEVE', issueUrl(open.identifier), '2');
    await settle();
    expect(mock.calls('POST', '/chat.unfurl')).toHaveLength(0);
    await shared('UBOB', issueUrl(open.identifier), '3');
    await settle();
    const [call] = mock.calls('POST', '/chat.unfurl');
    expect(JSON.stringify(call!.body)).toContain('Unfurl me');
  });

  it('answers mentions in a thread and direct messages', async () => {
    await deliver(
      JSON.stringify({
        type: 'event_callback',
        event_id: 'EvMention',
        event: {
          type: 'app_mention',
          user: 'UBOB',
          channel: 'C1',
          ts: '5.5',
          text: '<@UBOT> help',
        },
      }),
    );
    await settle();
    const reply = mock.calls('POST', '/chat.postMessage').at(-1)!.body as Record<string, unknown>;
    expect(reply.thread_ts).toBe('5.5');
    expect(JSON.stringify(reply)).toContain('new [TEAM] title');
  });

  it('unlinks from the account page', async () => {
    const account = ((await bob.get(`${ws}/me/chat-accounts`)).data.services as ChatService[]).find(
      (s) => s.integrationId === slack.id,
    )!.accounts[0]!;
    expect((await bob.del(`${ws}/me/chat-accounts/${account.id}`)).statusCode).toBe(200);
    const after = ((await bob.get(`${ws}/me/chat-accounts`)).data.services as ChatService[]).find(
      (s) => s.integrationId === slack.id,
    )!;
    expect(after.accounts).toHaveLength(0);
    expect(await auditActions()).toContain('chat_account.unlinked');
  });
});

// ─── Discord ──────────────────────────────────────────────────────────────

describe('Discord', () => {
  let discord: Integration;
  const keys = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
    'hex',
  );

  const interact = (body: object, signWith = keys.privateKey) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    return app.inject({
      method: 'POST',
      url: hookPath(discord),
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-signature-timestamp': ts,
        'x-signature-ed25519': sign(null, Buffer.from(ts + raw), signWith).toString('hex'),
      },
    });
  };

  beforeAll(() => {
    mock.on('GET', '/users/@me', { id: 'DBOT', username: 'ordo' });
    mock.on('PUT', '/applications/424242/commands', []);
    mock.onPrefix('PATCH', '/webhooks/424242/', {});
    mock.onPrefix('POST', '/channels/', { id: 'm1' });
  });

  it('registers its commands on connect', async () => {
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'discord',
      config: { delivery: 'interactions', applicationId: '424242' },
      secrets: { botToken: 'bot-token', publicKey },
    });
    expect(res.statusCode).toBe(200);
    discord = res.data;
    expect(discord.status).toBe('active');
    const [put] = mock.calls('PUT', '/applications/424242/commands');
    expect((put!.body as { name: string }[]).map((c) => c.name)).toEqual([
      'ordo',
      'Create Ordo issue',
    ]);
  });

  it('verifies signatures and answers pings and commands in the request', async () => {
    const ping = await interact({ id: 'i0', type: 1 });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toEqual({ type: 1 });
    const forged = await interact({ id: 'i1', type: 1 }, generateKeyPairSync('ed25519').privateKey);
    expect(forged.statusCode).toBe(401);

    const res = await interact({
      id: 'i2',
      type: 2,
      token: 'itok',
      channel_id: 'D1',
      guild_id: 'G1',
      member: { user: { id: 'DU1', username: 'dora' } },
      data: { type: 1, name: 'ordo', options: [{ name: 'command', type: 3, value: 'help' }] },
    });
    expect(res.json()).toEqual({ type: 5, data: { flags: 64 } });
    await settle();
    const [edit] = mock.calls('PATCH', '/webhooks/424242/itok/messages/@original');
    expect(JSON.stringify(edit!.body)).toContain('new [TEAM] title');
  });

  it('answers !ordo messages from the gateway as replies', async () => {
    const [row] = await app.db.select().from(integrations).where(eq(integrations.id, discord.id));
    await queueInbound(app, discordProvider, row!, {
      headers: {},
      query: {},
      body: JSON.stringify({
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg1',
          channel_id: 'CH9',
          guild_id: 'G1',
          content: '!ordo help',
          author: { id: 'DU1', username: 'dora' },
        },
      }),
    });
    await settle();
    const [reply] = mock.calls('POST', '/channels/CH9/messages');
    expect(
      (reply!.body as { message_reference: { message_id: string } }).message_reference,
    ).toEqual({ message_id: 'msg1', fail_if_not_exists: false });
  });
});

// ─── Telegram ─────────────────────────────────────────────────────────────

describe('Telegram', () => {
  let telegram: Integration;
  const token = '12345:telegram-test-token-abcdefghij';
  const method = (m: string) => `/bot${token}/${m}`;
  const sent = () =>
    mock.calls('POST', method('sendMessage')).map((c) => c.body as Record<string, unknown>);

  beforeAll(() => {
    mock.on('POST', method('getMe'), { ok: true, result: { id: 9, username: 'ordo_bot' } });
    mock.on('POST', method('setWebhook'), { ok: true, result: true });
    mock.on('POST', method('deleteWebhook'), { ok: true, result: true });
    mock.on('POST', method('sendMessage'), { ok: true, result: { message_id: 1 } });
  });

  it('reads commands, with or without the bot name', () => {
    expect(telegramCommand('/new@ordo_bot ALP Fix', 'ordo_bot', false)).toBe('new ALP Fix');
    expect(telegramCommand('/new@other_bot Fix', 'ordo_bot', false)).toBeNull();
    expect(telegramCommand('/start ABCDE-FGHIJ', 'ordo_bot', true)).toBe('link ABCDE-FGHIJ');
    expect(telegramCommand('just chatting', 'ordo_bot', false)).toBeNull();
    expect(telegramCommand('link ABC', 'ordo_bot', true)).toBe('link ABC');
  });

  it('sets its webhook with a secret and checks it', async () => {
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'telegram',
      config: {
        delivery: 'webhook',
        channels: [{ id: '-100200', events: ['issue.created'] }],
      },
      secrets: { botToken: token },
    });
    expect(res.statusCode).toBe(200);
    telegram = res.data;
    const [hook] = mock.calls('POST', method('setWebhook'));
    const body = hook!.body as { url: string; secret_token: string };
    expect(body.url).toBe(telegram.inboundUrl);

    const update = (secret: string, id: number, text: string, chat = { id: 77, type: 'private' }) =>
      app.inject({
        method: 'POST',
        url: hookPath(telegram),
        payload: {
          update_id: id,
          message: { message_id: id, chat, from: { id: 77, username: 'bobtg' }, text },
        },
        headers: { 'x-telegram-bot-api-secret-token': secret },
      });
    expect((await update('wrong', 1, '/help')).statusCode).toBe(401);
    const code = await linkCode(telegram.id);
    expect((await update(body.secret_token, 2, `/link ${code}`)).statusCode).toBe(202);
    await settle();
    expect(String(sent().at(-1)!.text)).toContain('Linked to Bob Member');
    expect(sent().at(-1)!.parse_mode).toBe('HTML');
  });

  it('long-polls under a lease when switched to polling', async () => {
    let served = false;
    mock.on('POST', method('getUpdates'), () => {
      if (served) return { body: { ok: true, result: [] } };
      served = true;
      return {
        body: {
          ok: true,
          result: [
            {
              update_id: 50,
              message: {
                message_id: 50,
                chat: { id: -100200, type: 'supergroup' },
                from: { id: 77, username: 'bobtg' },
                text: '/new@ordo_bot ALP Filed from Telegram',
              },
            },
          ],
        },
      };
    });
    const res = await owner.patch(`${ws}/integrations/${telegram.id}`, {
      config: { delivery: 'longpoll' },
    });
    expect(res.data.status).toBe('active');
    expect(mock.calls('POST', method('deleteWebhook')).length).toBeGreaterThan(0);

    await app.connectors.tick();
    expect(app.connectors.active).toContain(telegram.id);
    const reply = await until(() =>
      sent().find((m) => String(m.text).includes('Created ALP-') && m.chat_id === -100200),
    );
    expect(reply).toBeTruthy();
    const [lease] = await app.db
      .select()
      .from(leases)
      .where(eq(leases.key, `connector:${telegram.id}`));
    expect(lease?.holder).toBeTruthy();

    // Switched off: the connection stops at the next tick.
    await owner.patch(`${ws}/integrations/${telegram.id}`, { enabled: false });
    await app.connectors.tick();
    expect(app.connectors.active).not.toContain(telegram.id);
  });
});

// ─── Matrix ───────────────────────────────────────────────────────────────

describe('Matrix', () => {
  const room = '!room:hs.test';
  const roomPath = encodeURIComponent(room);
  let syncs = 0;

  beforeAll(() => {
    const base = '/_matrix/client/v3';
    mock.on('GET', `${base}/account/whoami`, { user_id: '@ordo:hs.test' });
    mock.onPrefix('POST', `${base}/join/`, { room_id: room });
    mock.onPrefix('PUT', `${base}/rooms/`, { event_id: '$sent' });
    mock.on('GET', `${base}/rooms/${roomPath}/joined_members`, {
      joined: { '@ordo:hs.test': {}, '@bob:hs.test': {}, '@eve:hs.test': {} },
    });
    mock.on('GET', `${base}/sync`, (req: { path: string }) => {
      syncs++;
      if (!req.path.includes('since=')) return { body: { next_batch: 's1' } };
      if (req.path.includes('since=s1')) {
        return {
          body: {
            next_batch: 's2',
            rooms: {
              invite: { '!new:hs.test': {} },
              join: {
                [room]: {
                  timeline: {
                    events: [
                      {
                        event_id: '$m1',
                        type: 'm.room.message',
                        sender: '@bob:hs.test',
                        content: { msgtype: 'm.text', body: '!ordo help' },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return { body: { next_batch: 's2' } };
    });
  });

  it('syncs, joins rooms it is invited to and answers commands', async () => {
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'matrix',
      config: {
        homeserverUrl: mock.url,
        channels: [{ id: room, events: ['issue.created'] }],
      },
      secrets: { accessToken: 'mx-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.status).toBe('active');
    const matrix = res.data as Integration;
    // It syncs; there's no webhook to forge messages through.
    expect(matrix.inboundUrl).toBeNull();
    const [stored] = await app.db.select().from(integrations).where(eq(integrations.id, matrix.id));
    const forged = await app.inject({
      method: 'POST',
      url: `/api/hooks/matrix/${stored!.inboundToken}`,
      payload: { room, event: { event_id: '$x', type: 'm.room.message', sender: '@bob:hs.test' } },
    });
    expect(forged.statusCode).toBe(404);

    await app.connectors.tick();
    expect(app.connectors.active).toContain(matrix.id);
    const sends = () => mock.log.filter((r) => r.method === 'PUT' && r.path.includes('/send/'));
    const reply = await until(() =>
      sends().find((s) => JSON.stringify(s.body).includes('new [TEAM] title')),
    );
    const relation = (reply.body as { 'm.relates_to': { 'm.in_reply_to': { event_id: string } } })[
      'm.relates_to'
    ];
    expect(relation['m.in_reply_to'].event_id).toBe('$m1');
    expect(
      mock.log.some((r) => r.path.endsWith(`/join/${encodeURIComponent('!new:hs.test')}`)),
    ).toBe(true);
    const [row] = await app.db.select().from(integrations).where(eq(integrations.id, matrix.id));
    expect(row!.state.since).toBe('s2');
    expect(syncs).toBeGreaterThan(1);

    // The room's feed.
    const issue = await newIssue('Matrix feed item');
    await until(() =>
      sends().find((s) => JSON.stringify(s.body).includes(`created ${issue.identifier}`)),
    );
    await owner.del(`${ws}/integrations/${matrix.id}`);
    await app.connectors.tick();
    expect(app.connectors.active).not.toContain(matrix.id);
  });
});

// ─── the connector supervisor ─────────────────────────────────────────────

describe('connectors', () => {
  const started: string[] = [];
  const fake: IntegrationProvider = {
    key: 'fake-socket',
    name: 'Fake socket',
    description: 'test',
    category: 'other',
    configure: ({ config }) => ({ config, secrets: {} }),
    async connect(ictx, io) {
      started.push(ictx.integration.id);
      await io.connected();
      while (await sleep(60_000, io.signal));
    },
  };
  beforeAll(() => registerProvider(fake));
  afterAll(() => unregisterProvider(fake.key));

  it('runs each connection on one server, and hands it over when that server stops', async () => {
    const res = await owner.post(`${ws}/integrations`, { provider: 'fake-socket' });
    const id = res.data.id as string;
    const other = new Connectors(app, new Leases(app.db, 'other-server'));

    await app.connectors.tick();
    await other.tick();
    expect(app.connectors.active).toContain(id);
    expect(other.active).not.toContain(id);
    expect(started.filter((s) => s === id)).toHaveLength(1);

    // This server stops (releasing its leases); the other one takes over.
    await app.connectors.stop();
    await other.tick();
    expect(other.active).toContain(id);
    expect(started.filter((s) => s === id)).toHaveLength(2);
    await other.stop();
  });
});
