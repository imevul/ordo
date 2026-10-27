import type { AiSettings, Bootstrap } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instanceSettings, users } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { type ForgeRequest, startMockForge } from './mock-forge.ts';

/** Claude and an OpenAI-compatible server, played by one mock that answers what tests queue. */
let mock: Awaited<ReturnType<typeof startMockForge>>;
let claudeApp: FastifyInstance;
let localApp: FastifyInstance;
let offApp: FastifyInstance;
let owner: Client;
let member: Client;
let boot: Bootstrap;
const ws = '/api/w/aiws';
const answers: string[] = [];

const claudeReply = (text: string) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const promptOf = (r: ForgeRequest) => {
  const body = r.body as { messages: { content: string }[] };
  return body.messages.at(-1)!.content;
};

/** A client of `app` signed in as the same person as `c`. */
function as(app: FastifyInstance, c: Client) {
  const other = new (c.constructor as new (app: FastifyInstance) => Client)(app);
  other.cookie = c.cookie;
  return other;
}

beforeAll(async () => {
  mock = await startMockForge();
  mock.on('POST', '/v1/messages', () => ({ body: claudeReply(answers.shift() ?? 'ready') }));
  const ai = (s: Partial<AiSettings>): AiSettings => ({
    provider: 'anthropic',
    model: 'claude-test',
    baseUrl: mock.url,
    apiKey: 'sk-ant-test-key',
    ...s,
  });
  claudeApp = await testApp({ settingsFromEnv: { ai: ai({}) } });
  localApp = await testApp({
    settingsFromEnv: {
      ai: ai({ provider: 'openai', model: 'qwen3', baseUrl: `${mock.url}/v1`, apiKey: null }),
    },
  });
  offApp = await testApp({ settingsFromEnv: { ai: null } });

  owner = (await signup(claudeApp, 'Ada AI')).client;
  await owner.post('/api/workspaces', {
    name: 'AI',
    slug: 'aiws',
    teamName: 'Engine',
    teamKey: 'ENG',
  });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(claudeApp, 'Max Member', { inviteToken: invite })).client;
  await owner.patch('/api/me', { username: 'ada-ai' });
  await owner.post(`${ws}/teams`, { name: 'Secret', key: 'SEC', private: true });
  await owner.post(`${ws}/labels`, { name: 'Bug', color: '#ef4444' });
  await owner.post(`${ws}/labels`, { name: 'Performance', color: '#22c55e' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  const eng = boot.teams.find((t) => t.key === 'ENG')!;
  const sec = boot.teams.find((t) => t.key === 'SEC')!;
  await owner.post(`${ws}/issues`, {
    teamId: eng.id,
    title: 'Export to CSV times out on large workspaces',
    description: 'Exports with 50k issues never finish.',
  });
  await owner.post(`${ws}/issues/ENG-1/comments`, { body: 'Seen on our staging too.' });
  await owner.post(`${ws}/issues`, {
    teamId: eng.id,
    title: 'CSV export hangs for big workspaces',
  });
  await owner.post(`${ws}/issues`, { teamId: sec.id, title: 'Secret CSV export plan' });
});

afterAll(async () => {
  await Promise.all([claudeApp.close(), localApp.close(), offApp.close()]);
  await mock.close();
});

describe('availability', () => {
  it('is off unless an instance admin sets up a model', async () => {
    const off = as(offApp, owner);
    expect((await off.get(`${ws}/bootstrap`)).data.ai).toBeNull();
    const res = await off.post(`${ws}/ai/issues/ENG-1/summary`);
    expect(res.statusCode).toBe(403);
    expect(res.data.error).toBe('ai_unavailable');
    expect(boot.ai).toEqual({
      provider: 'anthropic',
      model: 'claude-test',
      enabled: true,
      source: 'instance',
    });
  });

  it('can be turned off per workspace by its admins', async () => {
    expect((await member.patch(ws, { settings: { aiEnabled: false } })).statusCode).toBe(403);
    await owner.patch(ws, { settings: { aiEnabled: false } });
    expect((await owner.get(`${ws}/bootstrap`)).data.ai.enabled).toBe(false);
    const before = mock.log.length;
    const res = await owner.post(`${ws}/ai/issues/ENG-1/summary`);
    expect(res.statusCode).toBe(403);
    expect(mock.log.length).toBe(before);
    await owner.patch(ws, { settings: { aiEnabled: true } });
  });
});

describe('with the Claude API', () => {
  it('summarizes what the asker can see', async () => {
    answers.push('Exports **time out** for big workspaces.');
    const res = await owner.post(`${ws}/ai/issues/ENG-1/summary`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data.summary).toBe('Exports **time out** for big workspaces.');
    const call = mock.calls('POST', '/v1/messages').at(-1)!;
    expect(call.headers.authorization).toBe('Bearer sk-ant-test-key');
    expect((call.body as { model: string }).model).toBe('claude-test');
    expect(promptOf(call)).toContain('Seen on our staging too.');
    expect(promptOf(call)).toContain('ada-ai');

    // A private team's issue doesn't exist for a member, so nothing is sent.
    const before = mock.log.length;
    expect((await member.post(`${ws}/ai/issues/SEC-1/summary`)).statusCode).toBe(404);
    expect(mock.log.length).toBe(before);
  });

  it('drafts an issue with structured output and known labels only', async () => {
    const eng = boot.teams.find((t) => t.key === 'ENG')!;
    answers.push(
      JSON.stringify({
        title: 'Speed up CSV export',
        description: '## Context\nExports are slow.',
        priority: 2,
        labels: ['performance', 'Made up'],
      }),
    );
    const res = await member.post(`${ws}/ai/draft`, {
      teamId: eng.id,
      text: 'csv export slow!! fix pls',
    });
    expect(res.statusCode, res.body).toBe(200);
    const perf = boot.labels.find((l) => l.name === 'Performance')!;
    expect(res.data).toEqual({
      title: 'Speed up CSV export',
      description: '## Context\nExports are slow.',
      priority: 2,
      labelIds: [perf.id],
    });
    const body = mock.calls('POST', '/v1/messages').at(-1)!.body as {
      output_config: { format: { type: string } };
    };
    expect(body.output_config.format.type).toBe('json_schema');
    expect(promptOf(mock.calls('POST', '/v1/messages').at(-1)!)).toContain('Performance');

    // Members can't draft into a team they can't see.
    const sec = boot.teams.find((t) => t.key === 'SEC')!;
    expect((await member.post(`${ws}/ai/draft`, { teamId: sec.id, text: 'x' })).statusCode).toBe(
      404,
    );
  });

  it('suggests triage, keeping only candidates the asker can see', async () => {
    answers.push(
      JSON.stringify({
        priority: 2,
        labels: ['Bug', 'Bug'],
        duplicates: [
          { identifier: 'ENG-1', reason: 'Same export timeout.' },
          { identifier: 'SEC-1', reason: 'Not a candidate.' },
        ],
        reason: 'Exports failing blocks customers.',
      }),
    );
    const res = await member.post(`${ws}/ai/issues/ENG-2/triage`);
    expect(res.statusCode, res.body).toBe(200);
    const bug = boot.labels.find((l) => l.name === 'Bug')!;
    expect(res.data).toMatchObject({
      priority: 2,
      labelIds: [bug.id],
      duplicates: [{ identifier: 'ENG-1', reason: 'Same export timeout.' }],
      reason: 'Exports failing blocks customers.',
    });
    const prompt = promptOf(mock.calls('POST', '/v1/messages').at(-1)!);
    expect(prompt).toContain('Export to CSV times out');
    expect(prompt).not.toContain('Secret CSV export plan');
  });

  it('reports answers it cannot use', async () => {
    answers.push('Sorry, no JSON today.');
    const res = await owner.post(`${ws}/ai/issues/ENG-2/triage`);
    expect(res.statusCode).toBe(502);
    expect(res.data.error).toBe('ai_failed');
  });
});

describe('with an OpenAI-compatible endpoint', () => {
  it('sends chat completions, retries without json_schema and strips thinking', async () => {
    const eng = boot.teams.find((t) => t.key === 'ENG')!;
    let calls = 0;
    mock.on('POST', '/v1/chat/completions', (r: ForgeRequest) => {
      calls++;
      if ((r.body as { response_format?: unknown }).response_format)
        return { status: 400, body: { error: { message: 'response_format not supported' } } };
      return {
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: `<think>hmm</think>\`\`\`json\n${JSON.stringify({
                  title: 'Local draft',
                  description: 'Body',
                  priority: 0,
                  labels: [],
                })}\n\`\`\``,
              },
            },
          ],
        },
      };
    });
    const local = as(localApp, owner);
    const res = await local.post(`${ws}/ai/draft`, { teamId: eng.id, text: 'notes' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data.title).toBe('Local draft');
    expect(calls).toBe(2);
    const last = mock.calls('POST', '/v1/chat/completions').at(-1)!;
    expect(last.headers.authorization).toBeUndefined();
    expect((last.body as { model: string }).model).toBe('qwen3');

    mock.on('POST', '/v1/chat/completions', {
      choices: [{ finish_reason: 'stop', message: { content: 'A local summary.' } }],
    });
    const summary = await local.post(`${ws}/ai/issues/ENG-1/summary`);
    expect(summary.data.summary).toBe('A local summary.');

    mock.on('POST', '/v1/chat/completions', () => ({
      status: 500,
      body: { error: 'model not loaded' },
    }));
    const failed = await local.post(`${ws}/ai/issues/ENG-1/summary`);
    expect(failed.statusCode).toBe(502);
    expect(failed.data.message).toContain('model not loaded');
  });
});

describe("a workspace's own model", () => {
  it('is used instead of the instance one, keeps its key to itself and can be removed', async () => {
    // No instance model, but private addresses (the mock) are allowed.
    const app = await testApp({ settingsFromEnv: { ai: null, allowPrivateNetworkTargets: true } });
    try {
      const admin = as(app, owner);
      const before = (await admin.get(`${ws}/ai/settings`)).data;
      expect(before).toMatchObject({
        enabled: true,
        source: 'instance',
        instance: null,
        own: null,
      });
      expect((await as(app, member).get(`${ws}/ai/settings`)).statusCode).toBe(403);

      expect(
        (
          await admin.put(`${ws}/ai/provider`, {
            provider: 'anthropic',
            model: 'c',
            baseUrl: null,
            apiKey: null,
          })
        ).statusCode,
      ).toBe(400);
      const key = 'sk-own-local-1234567890';
      const saved = await admin.put(`${ws}/ai/provider`, {
        provider: 'openai',
        model: 'own-model',
        baseUrl: `${mock.url}/v1/`,
        apiKey: key,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const after = (await admin.get(`${ws}/ai/settings`)).data;
      expect(after).toMatchObject({
        source: 'workspace',
        own: { provider: 'openai', model: 'own-model', baseUrl: `${mock.url}/v1` },
      });
      expect(after.own.apiKey).not.toContain('1234567890');
      expect((await admin.get(`${ws}/bootstrap`)).data.ai).toEqual({
        provider: 'openai',
        model: 'own-model',
        enabled: true,
        source: 'workspace',
      });

      mock.on('POST', '/v1/chat/completions', {
        choices: [{ finish_reason: 'stop', message: { content: 'From our own model.' } }],
      });
      const summary = await admin.post(`${ws}/ai/issues/ENG-1/summary`);
      expect(summary.data.summary).toBe('From our own model.');
      const call = mock.calls('POST', '/v1/chat/completions').at(-1)!;
      expect(call.headers.authorization).toBe(`Bearer ${key}`);
      expect((call.body as { model: string }).model).toBe('own-model');
      expect((await admin.post(`${ws}/ai/provider/test`)).data.reply).toBe('From our own model.');

      // Even with the instance's own model set up, the workspace's wins.
      const claude = as(claudeApp, owner);
      expect((await claude.get(`${ws}/bootstrap`)).data.ai.model).toBe('own-model');
      // And where the instance keeps outbound requests off the private network, so does it.
      const off = as(offApp, owner);
      const blocked = await off.post(`${ws}/ai/issues/ENG-1/summary`);
      expect(blocked.statusCode).toBe(502);

      // A Claude model from a workspace always goes to Anthropic.
      await admin.put(`${ws}/ai/provider`, {
        provider: 'anthropic',
        model: 'claude-own',
        baseUrl: 'http://169.254.169.254',
        apiKey: 'sk-ant-own-key-123456',
      });
      expect((await admin.get(`${ws}/ai/settings`)).data.own.baseUrl).toBeNull();

      // The audit log says the key changed, never what it is.
      const log = JSON.stringify((await admin.get(`${ws}/audit-log?category=workspace`)).data);
      expect(log).toContain('workspace.ai_updated');
      expect(log).not.toContain('1234567890');

      // Removing it goes back to the instance's (none here).
      expect((await admin.del(`${ws}/ai/provider`)).statusCode).toBe(200);
      expect((await admin.get(`${ws}/bootstrap`)).data.ai).toBeNull();
      const none = await admin.post(`${ws}/ai/issues/ENG-1/summary`);
      expect(none.data.messageKey).toBe('ai_not_set_up');
      await admin.patch(ws, { settings: { aiSource: 'workspace' } });
      const unset = await admin.post(`${ws}/ai/issues/ENG-1/summary`);
      expect(unset.data.messageKey).toBe('ai_not_set_up_workspace');
      await admin.patch(ws, { settings: { aiSource: 'instance' } });
      expect((await claude.get(`${ws}/bootstrap`)).data.ai.model).toBe('claude-test');
    } finally {
      await app.close();
    }
  });
});

describe('instance settings', () => {
  it('stores the key encrypted, shows it masked and tests the connection', async () => {
    // An app whose AI setting isn't pinned by the environment.
    const app = await testApp();
    try {
      const admin = as(app, owner);
      // The first user of the test database isn't necessarily this one; make them admin.
      const me = (await admin.get('/api/auth/me')).data;
      await app.db.update(users).set({ isInstanceAdmin: true }).where(eq(users.id, me.id));
      expect((await as(app, member).patch('/api/admin/settings', { ai: null })).statusCode).toBe(
        403,
      );
      const bad = await admin.patch('/api/admin/settings', {
        ai: { provider: 'anthropic', model: 'claude-test', baseUrl: mock.url, apiKey: null },
      });
      expect(bad.statusCode).toBe(400);

      const saved = await admin.patch('/api/admin/settings', {
        ai: {
          provider: 'anthropic',
          model: 'claude-test',
          baseUrl: `${mock.url}/`,
          apiKey: 'sk-ant-api03-secretsecret-WXYZ',
        },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const entry = saved.data.find((e: { key: string }) => e.key === 'ai');
      expect(entry.value).toEqual({
        provider: 'anthropic',
        model: 'claude-test',
        baseUrl: mock.url,
        apiKey: 'sk-ant-…WXYZ',
      });
      const [row] = await app.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, 'ai'));
      expect(JSON.stringify(row!.value)).not.toContain('secretsecret');

      // An empty key keeps the stored one.
      await admin.patch('/api/admin/settings', {
        ai: { provider: 'anthropic', model: 'claude-other', baseUrl: mock.url, apiKey: '' },
      });
      answers.push('ready');
      const test = await admin.post('/api/admin/settings/test-ai');
      expect(test.statusCode, test.body).toBe(200);
      expect(test.data.reply).toBe('ready');
      const call = mock.calls('POST', '/v1/messages').at(-1)!;
      expect(call.headers.authorization).toBe('Bearer sk-ant-api03-secretsecret-WXYZ');
      expect((call.body as { model: string }).model).toBe('claude-other');

      // Off again (null settings used to violate the column's NOT NULL).
      const off = await admin.patch('/api/admin/settings', { ai: null });
      expect(off.data.find((e: { key: string }) => e.key === 'ai')).toMatchObject({
        value: null,
        source: 'default',
      });
    } finally {
      await app.settings.set('ai', null, null);
      const me = (await as(app, owner).get('/api/auth/me')).data;
      await app.db.update(users).set({ isInstanceAdmin: false }).where(eq(users.id, me.id));
      await app.close();
    }
  });
});
