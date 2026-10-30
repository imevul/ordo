import type { Bootstrap, Integration, Team } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrations } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

/** Every provider's settings go through its shared schema: bad input is a 400 naming the field. */

let app: FastifyInstance;
let owner: Client;
const ws = '/api/w/settings';
let team: Team;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Sam Settings')).client;
  await owner.post('/api/workspaces', {
    name: 'Settings',
    slug: 'settings',
    teamName: 'Engineering',
    teamKey: 'ENG',
  });
  team = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!;
});

afterAll(() => app.close());

const connect = (provider: string, config: object, secrets: object = {}) =>
  owner.post(`${ws}/integrations`, { provider, config, secrets });

describe('integration settings', () => {
  it.each([
    ['github', { repos: 'acme/app' }, {}, 'secrets.token: A personal access token is required'],
    [
      'github',
      { repos: 'acme' },
      { token: 't' },
      `config.repos.0: "acme" isn't a repository name (owner/name)`,
    ],
    ['github', { repos: 'acme/app', delivery: 'pol' }, { token: 't' }, 'config.delivery: '],
    [
      'gitlab',
      { baseUrl: 'ftp://gitlab.example.com', projects: 'a/b' },
      { token: 't' },
      'config.baseUrl: The GitLab URL is not valid',
    ],
    ['gitlab', { projects: '' }, { token: 't' }, 'config.projects: List at least one project'],
    [
      'forgejo',
      { repos: 'acme/app' },
      { token: 't' },
      'config.baseUrl: The server URL is required',
    ],
    ['slack', {}, { botToken: 'nope' }, 'secrets.botToken: The bot token starts with xoxb-'],
    [
      'slack',
      { delivery: 'socket' },
      { botToken: 'xoxb-1' },
      'secrets.appToken: Socket Mode needs an app-level token',
    ],
    [
      'slack',
      { channels: [{ id: '' }] },
      { botToken: 'xoxb-1', signingSecret: 's' },
      'config.channels.0.id: Every channel needs an id',
    ],
    [
      'discord',
      { applicationId: 'abc', delivery: 'gateway' },
      { botToken: 'b' },
      'config.applicationId: The application id is a number',
    ],
    [
      'discord',
      { applicationId: '123456789' },
      { botToken: 'b' },
      'secrets.publicKey: The public key (64 hex characters) is required',
    ],
    [
      'matrix',
      { homeserverUrl: 'matrix' },
      { accessToken: 'a' },
      'config.homeserverUrl: The homeserver URL is not valid',
    ],
    ['telegram', {}, { botToken: '123' }, 'secrets.botToken: The bot token looks like'],
    [
      'jira',
      { siteUrl: 'https://acme.atlassian.net', mode: 'mirror', projects: [{ key: 'abc' }] },
      { token: 't' },
      'config.projects.0.teamId: Choose an Ordo team for ABC',
    ],
    [
      'jira',
      { siteUrl: 'https://acme.atlassian.net', projects: [{ key: '1x' }] },
      { token: 't' },
      "config.projects.0.key: 1X isn't a Jira project key",
    ],
    ['email', { delivery: 'webhook' }, {}, 'config.teamId: Pick the team that receives the issues'],
    [
      'email',
      {
        delivery: 'imap',
        teamId: '00000000-0000-4000-8000-000000000000',
        host: 'imap.example.com',
        username: 'u',
      },
      {},
      'secrets.password: Enter the mailbox password',
    ],
  ])('%s %j %j → 400', async (provider, config, secrets, message) => {
    const res = await connect(provider, config, secrets);
    expect(res.statusCode).toBe(400);
    expect(res.data.message).toContain(message);
  });

  it('stores the normal form: trimmed URLs, clean lists, defaults', async () => {
    const res = await connect(
      'github',
      {
        apiUrl: ' http://127.0.0.1:9/api/v3/ ',
        repos: 'acme/app, acme/app\n/acme/api/',
        delivery: 'poll',
        unknown: 'dropped',
      },
      { token: 'ghp_x' },
    );
    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, (res.data as Integration).id));
    expect(row!.config).toEqual({
      mode: 'token',
      apiUrl: 'http://127.0.0.1:9/api/v3',
      webUrl: 'https://github.com',
      repos: ['acme/app', 'acme/api'],
      delivery: 'poll',
      commentOnPullRequests: false,
    });
  });

  it('turns settings saved before a stricter check into a 400 on update, not a 500', async () => {
    const res = await connect('email', { delivery: 'webhook', teamId: team.id });
    expect(res.statusCode).toBe(200);
    const { id } = res.data as Integration;
    // As if saved by an older version that didn't check the team.
    await app.db
      .update(integrations)
      .set({ config: { delivery: 'webhook', teamId: 'ENG', legacy: true } })
      .where(eq(integrations.id, id));

    // Settings that don't touch the config still save.
    expect((await owner.patch(`${ws}/integrations/${id}`, { name: 'Support' })).statusCode).toBe(
      200,
    );
    const stale = await owner.patch(`${ws}/integrations/${id}`, {
      config: { address: 'help@ordo.test' },
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.data.message).toContain('config.teamId');

    const fixed = await owner.patch(`${ws}/integrations/${id}`, { config: { teamId: team.id } });
    expect(fixed.statusCode).toBe(200);
    const [row] = await app.db.select().from(integrations).where(eq(integrations.id, id));
    expect(row!.config).toEqual({ delivery: 'webhook', teamId: team.id });
  });
});
