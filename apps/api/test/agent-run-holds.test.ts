import type { AgentRunContext, AgentRunHolds, Bootstrap, Issue } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type Json, signup, testApp } from './helpers.ts';

/**
 * What's holding queued runs back. Each case has a team of its own, so one case's cycles and runs
 * don't show up in another's answer.
 */

let app: FastifyInstance;
let owner: Client;
let member: Client;
let boot: Bootstrap;
const slug = `arh-${Date.now()}`;
const ws = `/api/w/${slug}`;
let key = 0;

async function bearer(token: string, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as object,
    headers: { authorization: `Bearer ${token}` },
  });
  let data: Json = null;
  try {
    data = res.json();
  } catch {}
  return Object.assign(res, { data });
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A team with an agent that waits for blockers and cycles, and helpers scoped to it. */
async function scene(agentOptions: Record<string, unknown> = {}) {
  const n = ++key;
  const team = (await owner.post(`${ws}/teams`, { name: `Team ${n}`, key: `T${n}X` })).data as {
    id: string;
    key: string;
  };
  const agentId = (
    await owner.post(`${ws}/agents`, { name: `Agent ${n}`, teamIds: [team.id], ...agentOptions })
  ).data.id as string;
  const token = (await owner.post(`${ws}/agents/${agentId}/keys`, { name: 'k' })).data
    .token as string;
  const fresh = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  const states = fresh.teams.find((t) => t.id === team.id)!.states;
  const stateOfType = (type: string) => states.find((s) => s.type === type)!.id;
  const cycle = async (
    name: string,
    from: number,
    to: number,
    startsAfterId?: string,
  ): Promise<{ id: string; number: number }> =>
    (
      await owner.post(`${ws}/teams/${team.id}/cycles`, {
        name,
        startsAt: day(from),
        endsAt: day(to),
        startsAfterId,
      })
    ).data;
  const issue = async (title: string, extra: Record<string, unknown> = {}) =>
    (await owner.post(`${ws}/issues`, { teamId: team.id, title, ...extra })).data as Issue;
  return {
    team,
    agentId,
    cycle,
    issue,
    /** An issue the agent gets a run for. */
    assigned: (title: string, cycleId?: string) => issue(title, { assigneeId: agentId, cycleId }),
    block: (blocker: Issue, blocked: Issue) =>
      owner.post(`${ws}/issues/${blocker.id}/relations`, {
        type: 'blocks',
        relatedIssueId: blocked.id,
      }),
    close: (i: Issue) => owner.patch(`${ws}/issues/${i.id}`, { stateId: stateOfType('completed') }),
    claim: async () => {
      const res = await bearer(token, 'POST', `${ws}/agent/claim?wait=0&runner=host`);
      return res.statusCode === 200 ? (res.data as AgentRunContext) : null;
    },
    report: (runId: string, body: unknown) =>
      bearer(token, 'PATCH', `${ws}/agent/runs/${runId}`, body),
    lastComment: async (i: Issue) =>
      (
        (await owner.get(`${ws}/issues/${i.id}/comments`)).data as { id: string; body: string }[]
      ).at(-1)!,
    holds: async (client: Client = owner) => {
      const res = await client.get(`${ws}/agent-runs/holds?teamId=${team.id}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.data as AgentRunHolds;
    },
  };
}

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Ola Owner')).client;
  await owner.post('/api/workspaces', { name: 'Holds', slug, teamName: 'One', teamKey: 'ONE' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mia Member', { inviteToken: invite })).client;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
});
afterAll(() => app.close());

describe('GET /agent-runs/holds', () => {
  it('names the issues a chain waits for, what is behind them, and what stalls it next', async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    const after = await s.cycle('After', 20, 30, next.id);
    const last = await s.cycle('Last', 30, 40, after.id);

    const spike = await s.issue('Spike', { cycleId: current.id, labelIds: [] });
    const stats = await s.issue('Stats', { cycleId: current.id });
    const column = await s.issue('Column', { cycleId: current.id });
    await s.block(spike, stats);
    await s.block(stats, column);
    const lone = await s.issue('Lone decision', { cycleId: current.id });

    await s.assigned('Next one', next.id);
    await s.assigned('Next two', next.id);
    const decide = await s.issue('Decide later', { cycleId: next.id });
    await s.assigned('After one', after.id);
    const triage = await s.issue('Triage later', { cycleId: after.id });
    await s.assigned('Last one', last.id);
    // Nothing waits for the last cycle, so what's in it can't stall anything.
    await s.issue('Late idea', { cycleId: last.id });

    const holds = await s.holds();
    expect(holds).toMatchObject({ working: 0, queued: 4, needPerson: 0, ready: 0, blocked: [] });
    expect(holds.chains).toHaveLength(1);
    const chain = holds.chains[0]!;
    expect(chain).toMatchObject({
      cycle: { id: current.id, name: 'Current', teamKey: s.team.key },
      waitsFor: 'finish',
      date: null,
      open: 4,
      total: 4,
      runs: 4,
      working: 0,
    });
    expect(chain.later.map((c) => [c.name, c.runs])).toEqual([
      ['Next', 2],
      ['After', 1],
      ['Last', 1],
    ]);
    expect(chain.issues.map((i) => [i.identifier, i.reason, i.behind])).toEqual([
      [spike.identifier, 'no_run', 2],
      [lone.identifier, 'no_run', 0],
    ]);
    expect(chain.nextToStall.map((i) => i.identifier)).toEqual([
      decide.identifier,
      triage.identifier,
    ]);

    // Once they're done, the chain moves on and waits for what stalled next.
    for (const i of [spike, stats, column, lone]) await s.close(i);
    const moved = (await s.holds()).chains[0]!;
    expect(moved.cycle.id).toBe(next.id);
    expect(moved.runs).toBe(2);
    expect(moved.issues.map((i) => i.identifier)).toEqual([decide.identifier]);
    expect(moved.nextToStall.map((i) => i.identifier)).toEqual([triage.identifier]);
  });

  it('shows labels, status and assignee so the issue explains itself', async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    const label = (
      await owner.post(`${ws}/labels`, { name: `Decide ${s.team.key}`, color: '#ff0080' })
    ).data.id;
    const ownerId = boot.members.find((m) => m.name === 'Ola Owner')!.id;
    await s.issue('Mine', { cycleId: current.id, assigneeId: ownerId, labelIds: [label] });
    await s.assigned('Waiting', next.id);
    expect((await s.holds()).chains[0]!.issues[0]).toMatchObject({
      title: 'Mine',
      assigneeId: ownerId,
      labels: [`Decide ${s.team.key}`],
      status: expect.any(String),
    });
  });

  it('a chain on a date lists nothing to do, and only warns about what would stall it', async () => {
    const s = await scene();
    const first = await s.cycle('First', 3, 10);
    const second = await s.cycle('Second', 10, 20, first.id);
    await s.assigned('First work', first.id);
    await s.assigned('Second work', second.id);
    const idle = await s.issue('Idle in first', { cycleId: first.id });

    const [chain] = (await s.holds()).chains;
    expect(chain).toMatchObject({
      cycle: { id: first.id },
      waitsFor: 'start',
      date: day(3),
      runs: 2,
      issues: [],
    });
    expect(chain!.later.map((c) => c.name)).toEqual(['Second']);
    expect(chain!.nextToStall.map((i) => i.identifier)).toEqual([idle.identifier]);
  });

  it('an empty cycle holds the next one until its end date', async () => {
    const s = await scene();
    const empty = await s.cycle('Empty', -2, 5);
    const next = await s.cycle('Next', 5, 10, empty.id);
    await s.assigned('Waiting', next.id);
    expect((await s.holds()).chains[0]).toMatchObject({
      cycle: { id: empty.id },
      waitsFor: 'end',
      date: day(5),
      runs: 1,
      issues: [],
    });
  });

  it('counts issues agents are on, and lists only what is stuck', async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    const working = await s.assigned('Being worked on', current.id);
    const behind = await s.issue('Behind it', { cycleId: current.id });
    await s.block(working, behind);
    const stuck = await s.issue('Stuck', { cycleId: current.id });
    await s.assigned('Waiting', next.id);
    expect((await s.claim())?.issue.identifier).toBe(working.identifier);

    const holds = await s.holds();
    expect(holds).toMatchObject({ working: 1, queued: 1 });
    expect(holds.chains[0]).toMatchObject({ working: 2, open: 3 });
    expect(holds.chains[0]!.issues.map((i) => i.identifier)).toEqual([stuck.identifier]);
  });

  it('lists a run waiting for a person, and counts it', async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    const asked = await s.assigned('Asked', current.id);
    await s.assigned('Waiting', next.id);
    const claimed = await s.claim();
    await s.report(claimed!.run.id, { status: 'waiting', question: 'v1 or v2?' });

    const holds = await s.holds();
    expect(holds.needPerson).toBe(1);
    const question = await s.lastComment(asked);
    expect(question.body).toContain('v1 or v2?');
    expect(holds.chains[0]!.issues).toMatchObject([
      { identifier: asked.identifier, reason: 'needs_person', commentId: question.id },
    ]);
  });

  it('links a proposed plan, and nothing once the run is moving again', async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    const planned = await s.assigned('Planned', current.id);
    await s.assigned('Waiting', next.id);
    const claimed = await s.claim();
    await s.report(claimed!.run.id, { status: 'waiting', plan: 'Do the thing' });
    const plan = await s.lastComment(planned);
    expect(plan.body).toContain('Do the thing');
    expect((await s.holds()).chains[0]!.issues[0]!.commentId).toBe(plan.id);

    await owner.post(`${ws}/agent-runs/${claimed!.run.id}/approve`);
    expect((await s.holds()).chains[0]!.issues).toEqual([]);
  });

  it('lists a failed run as needing a person until it is dismissed', async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    const broke = await s.assigned('Broke', current.id);
    await s.assigned('Waiting', next.id);
    const claimed = await s.claim();
    await s.report(claimed!.run.id, { status: 'failed', error: 'boom' });
    const failure = await s.lastComment(broke);
    expect((await s.holds()).chains[0]!.issues[0]).toMatchObject({
      reason: 'needs_person',
      commentId: failure.id,
    });

    await owner.post(`${ws}/agent-runs/${claimed!.run.id}/dismiss`);
    const after = await s.holds();
    expect(after.needPerson).toBe(0);
    expect(after.chains[0]!.issues[0]).toMatchObject({ reason: 'no_run', commentId: null });
  });

  it('groups blocked runs by the issue that has to move, in any cycle', async () => {
    const s = await scene();
    const elsewhere = await s.cycle('Elsewhere', 30, 40);
    const root = await s.issue('Root', { cycleId: elsewhere.id });
    const middle = await s.issue('Middle');
    await s.block(root, middle);
    for (const title of ['Blocked one', 'Blocked two']) {
      await s.block(middle, await s.assigned(title));
    }

    const holds = await s.holds();
    expect(holds.chains).toEqual([]);
    expect(holds.blocked).toMatchObject([
      { runs: 2, issue: { identifier: root.identifier, reason: 'no_run', behind: 3 } },
    ]);

    // An agent on the root: it resolves by itself, so there's nothing to list.
    await owner.patch(`${ws}/issues/${root.id}`, { assigneeId: s.agentId, cycleId: null });
    expect((await s.holds()).blocked).toEqual([]);
  });

  it('a run with nothing in the way counts as ready for a runner', async () => {
    const s = await scene();
    await s.assigned('Ready');
    expect(await s.holds()).toMatchObject({ queued: 1, ready: 1, chains: [], blocked: [] });
  });

  it("doesn't count runs that don't wait for the cycle", async () => {
    const s = await scene({ waitForCycle: false });
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    await s.issue('Open', { cycleId: current.id });
    await s.assigned('Early', next.id);
    expect(await s.holds()).toMatchObject({ queued: 1, ready: 1, chains: [] });
  });

  it("doesn't count a run someone told to run anyway", async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    await s.issue('Open', { cycleId: current.id });
    const held = await s.assigned('Waiting', next.id);
    const [run] = (await owner.get(`${ws}/issues/${held.id}/agent-runs`)).data;
    expect((await owner.post(`${ws}/agent-runs/${run.id}/run-anyway`)).statusCode).toBe(200);
    expect(await s.holds()).toMatchObject({ queued: 1, ready: 1, chains: [] });
  });

  it('a loop of blocking issues still answers', async () => {
    const s = await scene();
    const one = await s.issue('One');
    const two = await s.issue('Two');
    const blocked = await s.assigned('Blocked');
    await s.block(one, two);
    await s.block(two, blocked);
    expect((await s.block(blocked, one)).statusCode).toBe(200);
    const holds = await s.holds();
    expect(holds.queued).toBe(1);
    expect(holds.chains).toEqual([]);
  });

  it("keeps other teams' runs and blockers out, for people outside them", async () => {
    const s = await scene();
    const current = await s.cycle('Current', -2, 10);
    const next = await s.cycle('Next', 10, 20, current.id);
    await s.issue('Secret stuck', { cycleId: current.id });
    await s.assigned('Secret waiting', next.id);
    await owner.patch(`${ws}/teams/${s.team.id}`, { private: true });

    expect((await member.get(`${ws}/agent-runs/holds?teamId=${s.team.id}`)).statusCode).toBe(404);
    const everything = (await member.get(`${ws}/agent-runs/holds`)).data as AgentRunHolds;
    expect(JSON.stringify(everything)).not.toContain('Secret');
    expect(everything.chains.some((c) => c.cycle.teamKey === s.team.key)).toBe(false);
  });
});
