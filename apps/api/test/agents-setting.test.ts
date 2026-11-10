import type { AgentRun, Bootstrap } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns } from '../src/db/schema.ts';
import { type Client, type Json, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let eng: string;
let token: string;
const slug = `agset-${Date.now()}`;
const ws = `/api/w/${slug}`;

/** A request with an API key instead of a session. */
async function bearer(key: string, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as object,
    headers: { authorization: `Bearer ${key}` },
  });
  let data: Json = null;
  try {
    data = res.json();
  } catch {}
  return Object.assign(res, { data });
}

const mcp = (method: string, params: Record<string, unknown> = {}) =>
  bearer(token, 'POST', `${ws}/mcp`, { jsonrpc: '2.0', id: 1, method, params });
const toolNames = async () =>
  ((await mcp('tools/list')).data.result.tools as { name: string }[]).map((t) => t.name);
const turn = (agents: boolean) => owner.patch(ws, { settings: { agents } });
const runsInDb = (issueId: string) =>
  app.db.select().from(agentRuns).where(eq(agentRuns.issueId, issueId));

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Ada Owner')).client;
  await owner.post('/api/workspaces', { name: 'Switch', slug, teamName: 'Eng', teamKey: 'ENG' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Max Member', { inviteToken: invite })).client;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  eng = boot.teams[0]!.id;
  token = (await owner.post('/api/me/api-keys', { name: 'mcp' })).data.token;
});
afterAll(() => app.close());

describe('the agents setting', () => {
  it('is off in a new workspace, and nothing about agents answers', async () => {
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    expect(boot.workspace.settings.agents).toBe(false);

    const refused = [
      await owner.post(`${ws}/agents`, { name: 'Early', teamIds: [eng] }),
      await owner.get(`${ws}/agents`),
      await owner.get(`${ws}/agent-runs`),
      await owner.get(`${ws}/agent-runs/active-count`),
      await owner.get(`${ws}/agent-pauses`),
      await owner.get(`${ws}/agent-activity?days=7`),
    ];
    for (const res of refused) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.data.messageKey).toBe('agents_off');
    }
  });

  it('leaves the agent tools out of MCP, and refuses them by name', async () => {
    const names = await toolNames();
    expect(names).toContain('list_teams');
    expect(names).not.toContain('list_agents');
    expect(names).not.toContain('assign_to_agent');
    const called = await mcp('tools/call', { name: 'list_agents', arguments: {} });
    expect(called.data.result.isError).toBe(true);
    expect(called.data.result.content[0].text).toContain('Agents are off');
  });

  it('is an admin’s to turn on', async () => {
    expect((await member.patch(ws, { settings: { agents: true } })).statusCode).toBe(403);
    const on = await turn(true);
    expect(on.statusCode).toBe(200);
    expect(on.data.settings.agents).toBe(true);
    expect(await toolNames()).toContain('list_agents');
  });

  it('cancels open runs when turned off, and queues none until it is on again', async () => {
    const agent = (await owner.post(`${ws}/agents`, { name: 'Worker', teamIds: [eng] })).data;
    const key = (await owner.post(`${ws}/agents/${agent.id}/keys`, { name: 'k' })).data.token;
    const first = (
      await owner.post(`${ws}/issues`, { teamId: eng, title: 'Queued', assigneeId: agent.id })
    ).data;
    const runs = (await owner.get(`${ws}/issues/${first.id}/agent-runs`)).data as AgentRun[];
    expect(runs.map((r) => r.status)).toEqual(['queued']);

    expect((await turn(false)).statusCode).toBe(200);
    expect((await runsInDb(first.id)).map((r) => [r.status, r.error])).toEqual([
      ['cancelled', 'Agents turned off'],
    ]);
    // The runner is refused, like every other caller.
    const claim = await bearer(key, 'POST', `${ws}/agent/claim`);
    expect(claim.statusCode).toBe(403);
    expect(claim.data.messageKey).toBe('agents_off');

    // The agent is still a member, so it can hold an issue; it just gets no run for it.
    const second = (
      await owner.post(`${ws}/issues`, { teamId: eng, title: 'Idle', assigneeId: agent.id })
    ).data;
    expect(second.assigneeId).toBe(agent.id);
    const comment = await owner.post(`${ws}/issues/${first.id}/comments`, {
      body: `@${agent.username} are you there?`,
    });
    expect(comment.statusCode).toBe(200);
    expect(await runsInDb(second.id)).toHaveLength(0);
    expect(await runsInDb(first.id)).toHaveLength(1);

    await turn(true);
    const again = await owner.post(`${ws}/issues/${second.id}/agent-runs`);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.data.status).toBe('queued');
  });
});
