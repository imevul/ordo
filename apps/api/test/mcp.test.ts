import type { Bootstrap, IssueDetail } from '@ordo/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns, domainEvents, workspaces } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let ada: Client;
let key: string;
let boot: Bootstrap;
const ws = '/api/w/mcp';
const url = `${ws}/mcp`;
const MODERN = '2026-07-28';

/** One JSON-RPC request; `modern` adds the per-request _meta and its mirrored headers. */
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    token?: string | null;
    modern?: boolean;
    headers?: Record<string, string>;
    to?: string;
  } = {},
) {
  const token = opts.token === undefined ? key : opts.token;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let body: Record<string, unknown> = { ...params };
  if (opts.modern) {
    body = {
      ...body,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
      },
    };
    headers['mcp-protocol-version'] = MODERN;
    headers['mcp-method'] = method;
    if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  }
  const res = await app.inject({
    method: 'POST',
    url: opts.to ?? url,
    headers: { ...headers, ...opts.headers },
    payload: { jsonrpc: '2.0', id: 1, method, params: body },
  });
  return Object.assign(res, { data: res.body ? res.json() : null });
}

/** Calls a tool and returns its parsed JSON output (or the error text). */
async function tool(name: string, args: Record<string, unknown> = {}, token?: string) {
  const res = await rpc('tools/call', { name, arguments: args }, { token });
  expect(res.statusCode, res.body).toBe(200);
  const { content, isError } = res.data.result;
  return isError ? { error: content[0].text as string } : JSON.parse(content[0].text);
}

beforeAll(async () => {
  app = await testApp();
  const s = await signup(app, 'Ada Lovelace');
  ada = s.client;
  await ada.post('/api/workspaces', {
    name: 'MCP',
    slug: 'mcp',
    teamName: 'Engineering',
    teamKey: 'ENG',
  });
  await ada.patch('/api/me', { username: 'ada' });
  key = (await ada.post('/api/me/api-keys', { name: 'agent' })).data.token;
  await ada.post(`${ws}/labels`, { name: 'Bug', color: '#ef4444' });
  boot = (await ada.get(`${ws}/bootstrap`)).data;
});

afterAll(() => app.close());

describe('protocol', () => {
  it('answers the initialize handshake of older clients', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.result.protocolVersion).toBe('2025-06-18');
    expect(res.data.result.capabilities).toEqual({ tools: {} });
    expect(res.data.result.serverInfo.name).toBe('ordo');
    expect(res.data.result.instructions).toContain('@ada');
    // A version it doesn't know gets the newest one it does.
    expect(
      (await rpc('initialize', { protocolVersion: '2024-01-01' })).data.result.protocolVersion,
    ).toBe('2025-11-25');
  });

  it('accepts notifications with 202 and no body', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('lists the tools with JSON Schemas', async () => {
    const { tools } = (await rpc('tools/list')).data.result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining([
        'search_issues',
        'get_issue',
        'create_issue',
        'update_issue',
        'add_comment',
        'my_issues',
        'list_teams',
      ]),
    );
    const create = tools.find((t: { name: string }) => t.name === 'create_issue');
    expect(create.inputSchema.type).toBe('object');
    expect(create.inputSchema.required).toEqual(['team', 'title']);
    expect(create.annotations.readOnlyHint).toBe(false);
  });

  it('serves 2026-07-28 requests with per-request metadata', async () => {
    const res = await rpc('server/discover', {}, { modern: true });
    expect(res.statusCode).toBe(200);
    expect(res.data.result.resultType).toBe('complete');
    expect(res.data.result.supportedVersions).toContain(MODERN);
    expect(res.data.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('ordo');
    const list = await rpc('tools/list', {}, { modern: true });
    expect(list.data.result.tools.length).toBeGreaterThan(5);
    const call = await rpc('tools/call', { name: 'list_teams', arguments: {} }, { modern: true });
    expect(JSON.parse(call.data.result.content[0].text)[0].key).toBe('ENG');
  });

  it('validates the mirrored headers', async () => {
    const mismatch = await rpc(
      'tools/list',
      {},
      { modern: true, headers: { 'mcp-method': 'ping' } },
    );
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.data.error.code).toBe(-32020);
    const name = await rpc(
      'tools/call',
      { name: 'list_teams', arguments: {} },
      { modern: true, headers: { 'mcp-name': 'my_issues' } },
    );
    expect(name.data.error.code).toBe(-32020);
    const encoded = await rpc(
      'tools/call',
      { name: 'list_teams', arguments: {} },
      {
        modern: true,
        headers: { 'mcp-name': `=?base64?${Buffer.from('list_teams').toString('base64')}?=` },
      },
    );
    expect(encoded.statusCode).toBe(200);
  });

  it('names its versions when asked for one it does not speak', async () => {
    const res = await rpc('tools/list', {}, { headers: { 'mcp-protocol-version': '1999-01-01' } });
    expect(res.statusCode).toBe(400);
    expect(res.data.error.code).toBe(-32022);
    expect(res.data.error.data.supported).toEqual(expect.arrayContaining([MODERN, '2025-06-18']));
    // A modern header without the _meta it mirrors is malformed.
    const bare = await rpc('tools/list', {}, { headers: { 'mcp-protocol-version': MODERN } });
    expect(bare.data.error.code).toBe(-32602);
  });

  it('reports unknown methods and tools', async () => {
    const legacy = await rpc('resources/list');
    expect(legacy.statusCode).toBe(200);
    expect(legacy.data.error.code).toBe(-32601);
    const modern = await rpc('resources/list', {}, { modern: true });
    expect(modern.statusCode).toBe(404);
    expect(modern.data.error.code).toBe(-32601);
    expect((await rpc('tools/call', { name: 'drop_tables' })).data.error.code).toBe(-32602);
  });

  it('rejects malformed bodies and other methods', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(-32700);
    const get = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe('POST');
  });

  it('blocks browser requests from other origins', async () => {
    const res = await rpc('tools/list', {}, { headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('auth', () => {
  it('needs a valid API key', async () => {
    const none = await rpc('tools/list', {}, { token: null });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');
    expect(none.data.error.code).toBe(401);
    expect((await rpc('tools/list', {}, { token: 'ordo_not-a-real-key' })).statusCode).toBe(401);
    // Browser sessions don't count: the endpoint is for agents with keys.
    const cookie = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(cookie.statusCode).toBe(401);
  });

  it("hides workspaces the key's owner isn't in", async () => {
    const other = (await signup(app, 'Otto Outsider')).client;
    const otherKey = (await other.post('/api/me/api-keys', { name: 'x' })).data.token;
    const res = await rpc('tools/list', {}, { token: otherKey });
    expect(res.statusCode).toBe(404);
  });

  it('stops working once the key is revoked', async () => {
    const temp = (await ada.post('/api/me/api-keys', { name: 'temp' })).data;
    expect((await rpc('ping', {}, { token: temp.token })).statusCode).toBe(200);
    await ada.del(`/api/me/api-keys/${temp.id}`);
    expect((await rpc('ping', {}, { token: temp.token })).statusCode).toBe(401);
  });

  it("follows the workspace's API-key policy under required SSO", async () => {
    const member = (
      await signup(app, 'Mia Member', {
        inviteToken: (await ada.post(`${ws}/invites`, { role: 'member' })).data[0].token,
      })
    ).client;
    const memberKey = (await member.post('/api/me/api-keys', { name: 'agent' })).data.token;
    const setPolicy = (settings: Record<string, unknown>) =>
      app.db.update(workspaces).set({ settings }).where(eq(workspaces.id, boot.workspace.id));
    await setPolicy({ requireSso: true });
    try {
      const blocked = await rpc('tools/list', {}, { token: memberKey });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.data.error.data.error).toBe('sso_required');
      await setPolicy({ requireSso: true, allowApiKeysUnderSso: true });
      expect((await rpc('tools/list', {}, { token: memberKey })).statusCode).toBe(200);
    } finally {
      await setPolicy({});
    }
  });
});

describe('tools', () => {
  it('creates an issue from names, as the user, with source mcp', async () => {
    const out = await tool('create_issue', {
      team: 'eng',
      title: 'Agents can file bugs',
      description: 'Filed through **MCP**',
      status: 'todo',
      priority: 'high',
      assignee: 'me',
      labels: ['bug'],
      estimate: 3,
    });
    expect(out.identifier).toBe('ENG-1');
    expect(out).toMatchObject({
      status: 'Todo',
      priority: 'High',
      labels: ['Bug'],
      assignee: { username: 'ada' },
      creator: { username: 'ada' },
      estimate: 3,
    });
    expect(out.url).toMatch(/\/mcp\/issue\/ENG-1$/);
    const rest: IssueDetail = (await ada.get(`${ws}/issues/ENG-1`)).data;
    expect(rest.description).toBe('Filed through **MCP**');
    const [event] = await app.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.workspaceId, boot.workspace.id),
          eq(domainEvents.type, 'issue.created'),
        ),
      )
      .orderBy(desc(domainEvents.id));
    expect(event!.source).toBe('mcp');
  });

  it('updates status, labels and assignee', async () => {
    const out = await tool('update_issue', {
      issue: 'ENG-1',
      status: 'Done',
      removeLabels: ['Bug'],
      assignee: null,
      priority: 0,
    });
    expect(out).toMatchObject({
      statusType: 'completed',
      labels: [],
      assignee: null,
      priority: 'No priority',
    });
    expect(out.completedAt).toBeTruthy();
    const history = (await ada.get(`${ws}/issues/${out.id}/history`)).data;
    expect(history.length).toBeGreaterThan(0);
    expect((await tool('update_issue', { issue: 'ENG-1' })).error).toBe('Nothing to change');
  });

  it('comments and reads the thread back', async () => {
    const c = await tool('add_comment', { issue: 'ENG-1', body: 'Looks good to me' });
    expect(c.issue).toBe('ENG-1');
    await tool('add_comment', { issue: 'ENG-1', body: 'Agreed', replyTo: c.id });
    const issue = await tool('get_issue', { issue: 'eng-1' });
    expect(issue.comments.map((x: { body: string }) => x.body)).toEqual([
      'Looks good to me',
      'Agreed',
    ]);
    expect(issue.comments[1].replyTo).toBe(c.id);
    expect(issue.comments[0].author.username).toBe('ada');
    expect(issue.description).toBe('Filed through **MCP**');
  });

  it('searches open issues by default and closed ones on request', async () => {
    await tool('create_issue', { team: 'ENG', title: 'Searchable open thing', assignee: 'ada' });
    const open = await tool('search_issues', { query: 'thing' });
    expect(open.issues.map((i: { title: string }) => i.title)).toEqual(['Searchable open thing']);
    expect((await tool('search_issues', { query: 'bugs' })).count).toBe(0);
    expect((await tool('search_issues', { query: 'bugs', includeClosed: true })).count).toBe(1);
    expect((await tool('search_issues', { statusType: ['completed'] })).issues[0].identifier).toBe(
      'ENG-1',
    );
    const mine = await tool('my_issues');
    expect(mine.issues.map((i: { title: string }) => i.title)).toEqual(['Searchable open thing']);
    const limited = await tool('search_issues', { team: 'ENG', includeClosed: true, limit: 1 });
    expect(limited).toMatchObject({ count: 1, truncated: true });
  });

  it('relates issues by identifier', async () => {
    const a = await tool('create_issue', { team: 'ENG', title: 'Lay the foundation' });
    const b = await tool('create_issue', { team: 'ENG', title: 'Build the walls' });
    expect(
      await tool('add_relation', { issue: b.identifier, type: 'blocked_by', other: a.identifier }),
    ).toEqual({
      issue: b.identifier,
      relations: [{ type: 'blocked_by', identifier: a.identifier, title: 'Lay the foundation' }],
    });
    expect((await tool('get_issue', { issue: a.identifier, comments: false })).relations).toEqual([
      { type: 'blocks', identifier: b.identifier, title: 'Build the walls' },
    ]);
    // A new relation between the two replaces the old one.
    await tool('add_relation', { issue: a.identifier, type: 'related', other: b.identifier });
    expect((await tool('get_issue', { issue: b.identifier })).relations).toMatchObject([
      { type: 'related', identifier: a.identifier },
    ]);
    expect(await tool('remove_relation', { issue: b.identifier, other: a.identifier })).toEqual({
      issue: b.identifier,
      relations: [],
    });
    expect(
      (await tool('remove_relation', { issue: b.identifier, other: a.identifier })).error,
    ).toContain('has no relation');
  });

  it('lists what the agent can refer to', async () => {
    const [team] = await tool('list_teams');
    expect(team.statuses.map((s: { name: string }) => s.name)).toContain('In Progress');
    expect((await tool('list_statuses', { team: 'ENG' })).length).toBe(team.statuses.length);
    expect((await tool('list_labels')).map((l: { name: string }) => l.name)).toContain('Bug');
    expect((await tool('list_members', { query: 'ada' }))[0]).toMatchObject({
      username: 'ada',
      me: true,
    });
    expect(await tool('list_projects')).toEqual([]);
    expect(await tool('list_cycles')).toEqual([]);
  });

  it('explains bad input so the agent can retry', async () => {
    const status = await tool('create_issue', { team: 'ENG', title: 'x', status: 'Doing' });
    expect(status.error).toContain('Unknown status "Doing" in ENG');
    expect(status.error).toContain('In Progress');
    expect((await tool('create_issue', { team: 'NOPE', title: 'x' })).error).toContain(
      'ENG (Engineering)',
    );
    expect((await tool('create_issue', { team: 'ENG' })).error).toContain('title');
    expect((await tool('get_issue', { issue: 'ENG-999' })).error).toBe('Issue not found');
    expect((await tool('update_issue', { issue: 'ENG-1', assignee: 'nobody' })).error).toContain(
      'Unknown person',
    );
  });
});

describe('agents', () => {
  let agentKey: string;
  const eng = () => boot.teams.find((t) => t.key === 'ENG')!.id;

  beforeAll(async () => {
    const agent = (await ada.post(`${ws}/agents`, { name: 'Robo', teamIds: [eng()] })).data;
    agentKey = (await ada.post(`${ws}/agents/${agent.id}/keys`, { name: 'mcp' })).data.token;
  });

  const names = async (token?: string) =>
    (await rpc('tools/list', {}, { token })).data.result.tools.map((t: { name: string }) => t.name);

  it("lists an agent's own tools only for agents", async () => {
    expect(await names()).toEqual(expect.arrayContaining(['assign_to_agent', 'agent_runs']));
    expect(await names()).not.toContain('current_run');
    expect(await names(agentKey)).toEqual(
      expect.arrayContaining(['current_run', 'report_run', 'ask_question']),
    );
    expect(await names()).not.toContain('ask_question');
    expect((await tool('current_run')).error).toContain('belongs to a person');
  });

  it('lets an assistant hand issues to agents and follow them', async () => {
    expect(await tool('list_agents')).toEqual([{ username: 'robo', name: 'Robo', teams: ['ENG'] }]);
    const issue = await tool('create_issue', { team: 'ENG', title: 'For the robot' });
    expect(
      (await tool('assign_to_agent', { issue: issue.identifier, agent: 'ada' })).error,
    ).toContain('is a person');
    const assigned = await tool('assign_to_agent', {
      issue: issue.identifier,
      agent: 'robo',
      note: 'Start with the tests.',
    });
    expect(assigned).toMatchObject({
      issue: issue.identifier,
      assignee: { username: 'robo' },
      runs: [{ agent: { username: 'robo' }, status: 'queued' }],
    });
    // The note is on the issue before the run starts.
    const detail = await tool('get_issue', { issue: issue.identifier });
    expect(detail.comments.at(-1).body).toBe('Start with the tests.');

    // The agent works on it through MCP alone.
    const claim = await app.inject({
      method: 'POST',
      url: `${ws}/agent/claim`,
      headers: { authorization: `Bearer ${agentKey}` },
    });
    expect(claim.json().issue.identifier).toBe(issue.identifier);
    const [held] = await tool('current_run', {}, agentKey);
    expect(held).toMatchObject({ issue: issue.identifier, status: 'claimed', attempt: 1 });
    expect(
      await tool(
        'report_run',
        { sessionUrl: 'https://agents.example.com/s/1', status: 'running' },
        agentKey,
      ),
    ).toMatchObject({ status: 'running', sessionUrl: 'https://agents.example.com/s/1' });
    expect((await tool('report_run', {}, agentKey)).error).toBe('Nothing to report');
    await tool(
      'report_run',
      { status: 'succeeded', summary: 'Tests first, then the fix.' },
      agentKey,
    );
    expect(await tool('current_run', {}, agentKey)).toEqual([]);
    expect((await tool('report_run', { status: 'failed' }, agentKey)).error).toContain('no run');

    const runs = await tool('agent_runs', { issue: issue.identifier });
    expect(runs.runs[0]).toMatchObject({
      status: 'succeeded',
      summary: 'Tests first, then the fix.',
    });
    // What it cost, when its runner said.
    await app.db
      .update(agentRuns)
      .set({ costUsd: 0.42, outputTokens: 900, usageAt: new Date().toISOString() })
      .where(eq(agentRuns.id, runs.runs[0].run));
    const usage = { costUsd: 0.42, outputTokens: 900, inputTokens: null };
    expect((await tool('agent_runs', { issue: issue.identifier })).runs[0].usage).toMatchObject(
      usage,
    );
    const listed = await tool('list_agent_runs', { status: 'finished', agent: 'robo' });
    expect(listed.find((r: { run: string }) => r.run === runs.runs[0].run).usage).toMatchObject(
      usage,
    );

    // Feedback, a second run, and a change of mind.
    const again = await tool('rerun_agent', {
      issue: issue.identifier,
      note: 'Also update the docs.',
    });
    expect(again.runs.map((r: { status: string }) => r.status)).toEqual(['queued', 'succeeded']);
    const cancelled = await tool('cancel_agent_run', { issue: issue.identifier });
    expect(cancelled.runs[0].status).toBe('cancelled');
    expect((await tool('cancel_agent_run', { issue: issue.identifier })).error).toContain(
      'No agent is working',
    );
  });

  it('lets an agent ask over MCP and wait for a reply', async () => {
    const issue = await tool('create_issue', { team: 'ENG', title: 'Needs a decision' });
    await tool('assign_to_agent', { issue: issue.identifier, agent: 'robo' });
    await app.inject({
      method: 'POST',
      url: `${ws}/agent/claim`,
      headers: { authorization: `Bearer ${agentKey}` },
    });
    const asked = await tool('ask_question', { question: 'Tabs or spaces?' }, agentKey);
    expect(asked).toMatchObject({ status: 'waiting' });
    expect(asked.next).toContain('Stop working');
    const runs = await tool('agent_runs', { issue: issue.identifier });
    expect(runs.runs[0]).toMatchObject({ status: 'waiting', question: 'Tabs or spaces?' });
    // An assistant answering with a person's key resumes it.
    await tool('add_comment', { issue: issue.identifier, body: 'Spaces.' });
    expect((await tool('agent_runs', { issue: issue.identifier })).runs[0].status).toBe('queued');
  });

  it('lists what agents are doing across the workspace', async () => {
    const active = await tool('list_agent_runs');
    expect(active.length).toBeGreaterThan(0);
    expect(active[0]).toMatchObject({ agent: { username: 'robo' } });
    expect(active.every((r: { status: string }) => r.status !== 'succeeded')).toBe(true);
    const finished = await tool('list_agent_runs', { status: 'finished', agent: 'robo' });
    expect(finished.map((r: { status: string }) => r.status)).toContain('succeeded');
    expect(finished[0].run).toEqual(expect.any(String));
  });

  it('restarts and dismisses failed runs, mention runs included', async () => {
    // A name no other test file uses: usernames are unique across the instance.
    const helper = (await ada.post(`${ws}/agents`, { name: 'Log Reader', teamIds: [eng()] })).data;
    const helperKey = (await ada.post(`${ws}/agents/${helper.id}/keys`, { name: 'h' })).data.token;
    const name = (await tool('list_agents')).find(
      (a: { name: string }) => a.name === 'Log Reader',
    ).username;
    const claim = (token: string) =>
      app.inject({
        method: 'POST',
        url: `${ws}/agent/claim`,
        headers: { authorization: `Bearer ${token}` },
      });
    // Robo's queued work from the tests above would be claimed first.
    for (const r of await tool('list_agent_runs', { agent: 'robo' }))
      await tool('cancel_agent_run', { issue: r.issue });
    const issue = await tool('create_issue', { team: 'ENG', title: 'Flaky build' });
    const ref = { issue: issue.identifier };
    expect((await tool('restart_agent_run', ref)).error).toContain('No failed or cancelled run');
    expect((await tool('dismiss_agent_run', {})).error).toContain('give issue');

    // Robo is assigned; Helper is only asked in a comment, and fails.
    await tool('assign_to_agent', { ...ref, agent: 'robo' });
    await tool('add_comment', { ...ref, body: `@${name} can you look at the logs?` });
    expect((await claim(helperKey)).json().trigger.kind).toBe('mention');
    await tool('report_run', { status: 'failed', error: 'Out of disk' }, helperKey);
    await claim(agentKey);
    await tool('report_run', { status: 'failed', error: 'Timed out' }, agentKey);
    const open = await tool('list_agent_runs', { status: 'open' });
    const failed = open.filter((r: { issue: string }) => r.issue === issue.identifier);
    expect(failed).toHaveLength(2);

    // Two agents' runs failed, so the issue alone doesn't say which.
    expect((await tool('restart_agent_run', ref)).error).toContain('several agents');
    const restarted = await tool('restart_agent_run', { ...ref, agent: name });
    const helperRun = failed.find(
      (r: { agent: { username: string } }) => r.agent.username === name,
    );
    expect(restarted.restarted).toBe(helperRun.run);
    expect(restarted.runs[0]).toMatchObject({
      agent: { username: name },
      status: 'queued',
      trigger: 'mention',
      retryOf: helperRun.run,
    });
    // A run that has already been restarted is no longer the one to act on.
    expect((await tool('restart_agent_run', { ...ref, agent: name })).error).toContain(
      `No failed or cancelled run of ${name}`,
    );

    // Now Robo's is the only failed run left, and dismissing takes it off the open list.
    const roboRun = failed.find(
      (r: { agent: { username: string } }) => r.agent.username === 'robo',
    );
    const dismissed = await tool('dismiss_agent_run', ref);
    expect(dismissed.dismissed).toBe(roboRun.run);
    expect(dismissed.runs.find((r: { run: string }) => r.run === roboRun.run).dismissed).toBe(true);
    const stillOpen = await tool('list_agent_runs', { status: 'open' });
    expect(stillOpen.map((r: { run: string }) => r.run)).not.toContain(roboRun.run);
    expect((await tool('dismiss_agent_run', { ...ref, agent: 'robo' })).error).toContain(
      'No failed or cancelled run',
    );

    // By id: a dismissed run can still be restarted, but an open one can't be dismissed.
    expect((await tool('restart_agent_run', { run: roboRun.run })).runs[0]).toMatchObject({
      agent: { username: 'robo' },
      status: 'queued',
      retryOf: roboRun.run,
    });
    expect((await tool('dismiss_agent_run', { run: restarted.runs[0].run })).error).toContain(
      'This run is queued',
    );
  });

  it("can't act on runs of issues the caller can't see", async () => {
    const prv = (await ada.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })).data
      .id;
    await ada.post(`${ws}/agents`, { name: 'Secret Agent', teamIds: [prv] });
    const issue = await tool('create_issue', { team: 'PRV', title: 'Hush' });
    await tool('assign_to_agent', { issue: issue.identifier, agent: 'Secret Agent' });
    const cancelled = await tool('cancel_agent_run', { issue: issue.identifier });
    const runId = cancelled.runs[0].run;

    const moe = (
      await signup(app, 'Moe Member', {
        inviteToken: (await ada.post(`${ws}/invites`, { role: 'member' })).data[0].token,
      })
    ).client;
    const moeKey = (await moe.post('/api/me/api-keys', { name: 'mcp' })).data.token;
    for (const name of ['restart_agent_run', 'dismiss_agent_run']) {
      expect((await tool(name, { issue: issue.identifier }, moeKey)).error).toBe('Issue not found');
      expect((await tool(name, { run: runId }, moeKey)).error).toBe('Run not found');
    }
    // The owner, with a person's key, can.
    expect((await tool('dismiss_agent_run', { issue: issue.identifier })).dismissed).toBe(runId);
  });
  it('shows what a working agent last said it is doing', async () => {
    const bot = (await ada.post(`${ws}/agents`, { name: 'Progress Bot', teamIds: [eng()] })).data;
    const botKey = (await ada.post(`${ws}/agents/${bot.id}/keys`, { name: 'p' })).data.token;
    const issue = await tool('create_issue', { team: 'ENG', title: 'Long job' });
    expect((await tool('report_progress', { step: 'Starting' }, botKey)).error).toContain('no run');
    await ada.patch(`${ws}/issues/${issue.id}`, { assigneeId: bot.id });
    const claim = () =>
      app.inject({
        method: 'POST',
        url: `${ws}/agent/claim`,
        headers: { authorization: `Bearer ${botKey}` },
      });
    await claim();
    const first = await tool('report_progress', { step: 'Reading the code' }, botKey);
    // Saying what it does means it's working.
    expect(first).toMatchObject({
      status: 'running',
      progress: { step: 'Reading the code', percent: null },
    });
    await tool('report_progress', { step: 'Running the tests', percent: 70 }, botKey);
    const [run] = (await ada.get(`${ws}/issues/${issue.id}/agent-runs`)).data;
    expect(run.progress).toMatchObject({ step: 'Running the tests', percent: 70 });
    expect((await tool('report_progress', { step: 'x', percent: 120 }, botKey)).error).toBeTruthy();
    // Not a comment per update.
    expect((await tool('get_issue', { issue: issue.identifier })).comments).toEqual([]);
    // A person's key has no runs to report on.
    expect((await tool('report_progress', { step: 'Hi' })).error).toContain('belongs to a person');
    await tool('report_run', { status: 'succeeded', summary: 'Done.' }, botKey);
    expect((await tool('report_progress', { step: 'Late' }, botKey)).error).toContain('no run');
  });
});

describe('custom fields', () => {
  beforeAll(async () => {
    const eng = boot.teams.find((t) => t.key === 'ENG')!.id;
    const add = (body: Record<string, unknown>) => ada.post(`${ws}/custom-fields`, body);
    await add({
      name: 'Customer tier',
      type: 'select',
      options: [{ name: 'Gold' }, { name: 'Silver' }],
    });
    await add({
      name: 'Areas',
      type: 'multi_select',
      options: [{ name: 'API' }, { name: 'Web' }, { name: 'CLI' }],
      teamId: eng,
    });
    await add({ name: 'Story points', type: 'number' });
    await add({ name: 'Release date', type: 'date' });
    await add({ name: 'Notes', type: 'text' });
    await add({ name: 'Reviewer', type: 'person' });
  });

  it('lists the fields with their options', async () => {
    const fields = await tool('list_custom_fields', { team: 'ENG' });
    expect(fields.map((f: { name: string }) => f.name)).toEqual([
      'Customer tier',
      'Areas',
      'Story points',
      'Release date',
      'Notes',
      'Reviewer',
    ]);
    expect(fields[0]).toEqual({
      name: 'Customer tier',
      type: 'select',
      team: null,
      options: ['Gold', 'Silver'],
    });
    expect(fields[1]).toMatchObject({ team: 'ENG', options: ['API', 'Web', 'CLI'] });
    expect(fields[2].options).toBeUndefined();
  });

  it('sets and shows fields by name, with readable values', async () => {
    const created = await tool('create_issue', {
      team: 'ENG',
      title: 'Has fields',
      customFields: {
        'customer tier': 'gold',
        Areas: ['web', 'API'],
        'Story points': 5,
        'Release date': '2030-04-01',
        Notes: 'Ask support',
        Reviewer: 'me',
      },
    });
    expect(created.customFields).toEqual({
      'Customer tier': 'Gold',
      Areas: ['API', 'Web'],
      'Story points': 5,
      'Release date': '2030-04-01',
      Notes: 'Ask support',
      Reviewer: 'ada',
    });
    const rest: IssueDetail = (await ada.get(`${ws}/issues/${created.identifier}`)).data;
    expect(Object.keys(rest.customFields)).toHaveLength(6);

    // Null clears; fields left out keep their value. Ids work too.
    const tier = (await ada.get(`${ws}/custom-fields`)).data.find(
      (f: { name: string }) => f.name === 'Customer tier',
    );
    const updated = await tool('update_issue', {
      issue: created.identifier,
      customFields: { Notes: null, [tier.id]: tier.options[1].id, 'Story points': '8' },
    });
    expect(updated.customFields).toMatchObject({ 'Customer tier': 'Silver', 'Story points': 8 });
    expect(updated.customFields.Notes).toBeUndefined();
    expect(updated.customFields.Reviewer).toBe('ada');

    // Issues without values leave customFields out.
    const plain = await tool('create_issue', { team: 'ENG', title: 'No fields' });
    expect(plain.customFields).toBeUndefined();

    const found = await tool('search_issues', {
      customFields: { 'Customer tier': ['silver'], Areas: ['web'] },
    });
    expect(found.issues.map((i: { title: string }) => i.title)).toEqual(['Has fields']);
    const none = await tool('search_issues', {
      team: 'ENG',
      customFields: { 'Customer tier': ['none'] },
    });
    expect(none.issues.map((i: { title: string }) => i.title)).toContain('No fields');
    expect(none.issues.map((i: { title: string }) => i.title)).not.toContain('Has fields');
  });

  it('names the valid fields and options when one is unknown', async () => {
    const field = await tool('create_issue', {
      team: 'ENG',
      title: 'x',
      customFields: { Severity: 'High' },
    });
    expect(field.error).toContain('Unknown custom field "Severity" in ENG');
    expect(field.error).toContain('Customer tier, Areas');
    const option = await tool('create_issue', {
      team: 'ENG',
      title: 'x',
      customFields: { 'Customer tier': 'Bronze' },
    });
    expect(option.error).toBe('Unknown option "Bronze" for Customer tier. Options: Gold, Silver');
    const typed = await tool('create_issue', {
      team: 'ENG',
      title: 'x',
      customFields: { 'Story points': 'many' },
    });
    expect(typed.error).toBe('Story points: expected a number');
    const person = await tool('create_issue', {
      team: 'ENG',
      title: 'x',
      customFields: { Reviewer: 'nobody' },
    });
    expect(person.error).toContain('Unknown person');
  });
});

describe('planning', () => {
  it('creates and changes cycles by team and number', async () => {
    const created = await tool('create_cycle', {
      team: 'ENG',
      startsAt: '2030-01-07',
      endsAt: '2030-01-21',
      name: 'Launch',
    });
    expect(created).toMatchObject({ team: 'ENG', name: 'Launch', startsAt: '2030-01-07' });
    const updated = await tool('update_cycle', {
      team: 'ENG',
      cycle: String(created.number),
      endsAt: '2030-01-28',
      name: null,
    });
    expect(updated).toMatchObject({ number: created.number, endsAt: '2030-01-28', name: null });
    expect(
      (
        await tool('update_cycle', {
          team: 'ENG',
          cycle: String(created.number),
          endsAt: '2030-01-01',
        })
      ).error,
    ).toContain('End date must be after start date');
    expect((await tool('update_cycle', { team: 'ENG', cycle: 'Nope', name: 'x' })).error).toContain(
      'Unknown cycle',
    );
    const cycles = await tool('list_cycles', { team: 'ENG' });
    expect(cycles.map((c: { number: number }) => c.number)).toContain(created.number);
    // Issues go in by number.
    const issue = await tool('create_issue', {
      team: 'ENG',
      title: 'Planned',
      cycle: String(created.number),
    });
    expect(issue.cycle).toEqual({ number: created.number, name: null });
  });

  it('adds milestones to projects and puts issues in them', async () => {
    const eng = boot.teams.find((t) => t.key === 'ENG')!.id;
    await ada.post(`${ws}/projects`, { name: 'Rocket', teamIds: [eng] });
    const m = await tool('create_milestone', {
      project: 'rocket',
      name: 'Alpha',
      targetDate: '2030-02-01',
    });
    expect(m).toMatchObject({ project: 'Rocket', name: 'Alpha', targetDate: '2030-02-01' });
    await tool('create_milestone', { project: 'Rocket', name: 'Beta' });
    const renamed = await tool('update_milestone', {
      project: 'Rocket',
      milestone: 'beta',
      name: 'Beta 1',
      targetDate: '2030-03-01',
    });
    expect(renamed).toMatchObject({ name: 'Beta 1', targetDate: '2030-03-01' });
    expect(
      (await tool('update_milestone', { project: 'Rocket', milestone: 'Gamma', name: 'x' })).error,
    ).toContain('Milestones: Alpha, Beta 1');
    const [rocket] = (await tool('list_projects')).filter(
      (p: { name: string }) => p.name === 'Rocket',
    );
    expect(rocket.milestones.map((x: { name: string }) => x.name)).toEqual(['Alpha', 'Beta 1']);

    const issue = await tool('create_issue', {
      team: 'ENG',
      title: 'First stage',
      project: 'Rocket',
      milestone: 'Alpha',
    });
    expect(issue).toMatchObject({ project: 'Rocket', milestone: 'Alpha' });
    // Within the issue's own project when no project is given.
    const moved = await tool('update_issue', { issue: issue.identifier, milestone: 'Beta 1' });
    expect(moved.milestone).toBe('Beta 1');
    const cleared = await tool('update_issue', { issue: issue.identifier, milestone: null });
    expect(cleared).toMatchObject({ project: 'Rocket', milestone: null });
    const loose = await tool('create_issue', { team: 'ENG', title: 'No project' });
    expect(
      (await tool('update_issue', { issue: loose.identifier, milestone: 'Alpha' })).error,
    ).toContain('Say which project');
  });
  it('lets agents plan in their teams, though they join as guests', async () => {
    const eng = boot.teams.find((t) => t.key === 'ENG')!.id;
    const bot = (await ada.post(`${ws}/agents`, { name: 'Planner Bot', teamIds: [eng] })).data;
    const botKey = (await ada.post(`${ws}/agents/${bot.id}/keys`, { name: 'p' })).data.token;
    const cycle = await tool(
      'create_cycle',
      { team: 'ENG', startsAt: '2030-05-06', endsAt: '2030-05-13' },
      botKey,
    );
    expect(cycle).toMatchObject({ team: 'ENG', startsAt: '2030-05-06' });
    expect(
      await tool(
        'update_cycle',
        { team: 'ENG', cycle: String(cycle.number), name: 'Week 19' },
        botKey,
      ),
    ).toMatchObject({ name: 'Week 19' });
    const m = await tool('create_milestone', { project: 'Rocket', name: 'Gamma' }, botKey);
    expect(m).toMatchObject({ project: 'Rocket', name: 'Gamma' });
    // Planning only: the project itself stays out of an agent's reach.
    const [rocket] = (await ada.get(`${ws}/projects`)).data.filter(
      (p: { name: string }) => p.name === 'Rocket',
    );
    const res = await app.inject({
      method: 'PATCH',
      url: `${ws}/projects/${rocket.id}`,
      headers: { authorization: `Bearer ${botKey}`, 'content-type': 'application/json' },
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("a member's key", () => {
  let memberKey: string;
  let secret: string;
  let open: string;

  beforeAll(async () => {
    await ada.post(`${ws}/teams`, { name: 'Hush', key: 'HSH', private: true });
    secret = (await tool('create_issue', { team: 'HSH', title: 'Quiet merger plans' })).identifier;
    open = (await tool('create_issue', { team: 'ENG', title: 'Public roadmap' })).identifier;
    const mo = (
      await signup(app, 'Mo Member', {
        inviteToken: (await ada.post(`${ws}/invites`, { role: 'member' })).data[0].token,
      })
    ).client;
    memberKey = (await mo.post('/api/me/api-keys', { name: 'mcp' })).data.token;
  });

  it("can't read or change issues of a private team it isn't in", async () => {
    expect((await tool('get_issue', { issue: secret }, memberKey)).error).toBe('Issue not found');
    expect((await tool('update_issue', { issue: secret, title: 'Leaked' }, memberKey)).error).toBe(
      'Issue not found',
    );
    expect((await tool('add_comment', { issue: secret, body: 'hi' }, memberKey)).error).toBe(
      'Issue not found',
    );
    const found = await tool('search_issues', { query: 'merger', includeClosed: true }, memberKey);
    expect(found.count).toBe(0);
    // The team itself is unknown to them, and the error doesn't name it.
    const team = (await tool('search_issues', { team: 'HSH' }, memberKey)).error;
    expect(team).toContain('ENG (Engineering)');
    expect(team).not.toContain('Hush');

    const still = await tool('get_issue', { issue: secret });
    expect(still.title).toBe('Quiet merger plans');
    expect(still.comments).toEqual([]);
  });

  it("can't relate to, unrelate from or see relations to such issues", async () => {
    for (const [issue, other] of [
      [open, secret],
      [secret, open],
    ]) {
      expect((await tool('add_relation', { issue, type: 'related', other }, memberKey)).error).toBe(
        'Issue not found',
      );
    }
    expect((await tool('get_issue', { issue: open })).relations).toEqual([]);

    // The owner relates them; the member sees neither the relation nor can remove it.
    await tool('add_relation', { issue: open, type: 'blocked_by', other: secret });
    expect((await tool('get_issue', { issue: open }, memberKey)).relations).toEqual([]);
    for (const [issue, other] of [
      [open, secret],
      [secret, open],
    ]) {
      expect((await tool('remove_relation', { issue, other }, memberKey)).error).toBe(
        'Issue not found',
      );
    }
    expect((await tool('get_issue', { issue: open })).relations).toMatchObject([
      { type: 'blocked_by', identifier: secret },
    ]);
  });
});
