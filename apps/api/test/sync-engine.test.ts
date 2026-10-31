import type { Bootstrap, Issue } from '@ordo/shared';
import { Engine } from '@ordo/sync/engine';
import { restTransport } from '@ordo/sync/rest';
import { MemoryStore } from '@ordo/sync/store';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

/**
 * Two devices of one person, each with a sync engine and its own copy, talking to the real API.
 * Whatever they do (one of them offline for a while), they end up agreeing with the server.
 */

let app: FastifyInstance;
let owner: Client;
let teamId: string;
const slug = `engine-${Date.now()}`;
const ws = `/api/w/${slug}`;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Engine Owner')).client;
  await owner.post('/api/workspaces', { name: 'Engine', slug, teamName: 'Core', teamKey: 'ENG' });
  teamId = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!.id;
});
afterAll(() => app.close());

/** The web app's transport (`restTransport`), over app.inject; `offline` makes the device unreachable. */
function device(client: Client) {
  const link = { offline: false };
  const transport = restTransport(async (method, path, body) => {
    // What the web client throws: the status, 0 when the request never got there.
    if (link.offline) throw Object.assign(new Error('offline'), { status: 0 });
    const res = await client.req(method, `${ws}${path}`, method === 'POST' ? (body ?? {}) : body);
    if (res.statusCode < 400) return res.data;
    throw Object.assign(new Error(res.data?.message ?? `HTTP ${res.statusCode}`), {
      status: res.statusCode,
    });
  });
  return { link, transport };
}

const view = (issues: ReadonlyMap<string, Issue>) =>
  [...issues.values()].map((i) => `${i.identifier} ${i.title} p${i.priority}`).sort();

describe('two devices', () => {
  it('converge with the server after offline edits on one of them', async () => {
    const me = (await owner.get('/api/auth/me')).data.id;
    const shared = (await owner.post(`${ws}/issues`, { teamId, title: 'Shared' })).data as Issue;
    const doomed = (await owner.post(`${ws}/issues`, { teamId, title: 'Doomed' })).data as Issue;
    const note = (await owner.post(`${ws}/issues/${shared.id}/comments`, { body: 'first draft' }))
      .data;

    const laptop = device(owner);
    const phone = device(owner);
    const a = new Engine({ userId: me, transport: laptop.transport, store: new MemoryStore() });
    const b = new Engine({ userId: me, transport: phone.transport, store: new MemoryStore() });
    await Promise.all([a.sync(), b.sync()]);
    expect(view(a.getState().issues)).toEqual(view(b.getState().issues));

    // The laptop goes offline and keeps working.
    laptop.link.offline = true;
    const draftId = crypto.randomUUID();
    await a.mutate({
      kind: 'issue.create',
      issue: { id: draftId, teamId, title: 'Written on a train' },
    });
    await a.mutate({
      kind: 'issue.update',
      ids: [shared.id],
      patch: { title: 'Shared, renamed offline' },
    });
    await a.mutate({
      kind: 'comment.create',
      comment: {
        id: crypto.randomUUID(),
        issueId: draftId,
        body: 'on the new one',
        parentId: null,
      },
    });
    await a.mutate({ kind: 'comment.update', id: note.id, issueId: shared.id, body: 'too late' });
    expect(a.getState()).toMatchObject({ online: false, waiting: 4 });

    // Meanwhile, the phone changes the same issue and trashes another.
    await b.mutate({ kind: 'issue.update', ids: [shared.id], patch: { priority: 1 } });
    await b.mutate({ kind: 'issue.trash', ids: [doomed.id] });
    await b.mutate({ kind: 'comment.delete', id: note.id, issueId: shared.id });

    // Back online: the laptop sends, then both catch up.
    laptop.link.offline = false;
    await a.sync();
    await b.sync();
    await a.sync();

    const server = (await owner.post(`${ws}/sync/issues`, { limit: 1000 })).data.issues as Issue[];
    const truth = view(new Map(server.map((i) => [i.id, i])));
    expect(view(a.getState().issues)).toEqual(truth);
    expect(view(b.getState().issues)).toEqual(truth);
    expect(truth).toContain('ENG-1 Shared, renamed offline p1');
    expect(truth.some((v) => v.endsWith('Written on a train p0'))).toBe(true);
    expect(truth.some((v) => v.includes('Doomed'))).toBe(false);

    // The edit to the comment the phone deleted was refused, and kept to show; the rest went through.
    expect(a.getState().waiting).toBe(0);
    expect(a.getState().failed.map((f) => f.op.kind)).toEqual(['comment.update']);
    expect(a.getState().failed[0]!.op).toMatchObject({ body: 'too late' });
    const comments = (await owner.get(`${ws}/issues/${draftId}/comments`)).data;
    expect(comments.map((c: { body: string }) => c.body)).toEqual(['on the new one']);
  });

  it('send trash, Undo and team moves made offline in order', async () => {
    const me = (await owner.get('/api/auth/me')).data.id;
    const other = (await owner.post(`${ws}/teams`, { name: 'Ops', key: 'OPS' })).data as {
      id: string;
    };
    const kept = (await owner.post(`${ws}/issues`, { teamId, title: 'Kept' })).data as Issue;
    const moving = (await owner.post(`${ws}/issues`, { teamId, title: 'Moving' })).data as Issue;
    const laptop = device(owner);
    const a = new Engine({ userId: me, transport: laptop.transport, store: new MemoryStore() });
    await a.sync();

    laptop.link.offline = true;
    await a.mutate({ kind: 'issue.trash', ids: [kept.id] });
    expect(a.issue(kept.id)).toBeUndefined();
    await a.mutate({ kind: 'issue.restore', ids: [kept.id] });
    expect(a.issue(kept.id)).toBeDefined();
    await a.mutate({ kind: 'issue.move', ids: [moving.id], teamId: other.id });
    expect(a.issue(moving.id)).toMatchObject({ teamId: other.id });

    laptop.link.offline = false;
    await a.sync();
    expect(a.getState()).toMatchObject({ waiting: 0, failed: [] });
    const keptNow = (await owner.get(`${ws}/issues/${kept.id}`)).data as Issue;
    expect(keptNow.deletedAt).toBeNull();
    const movedNow = (await owner.get(`${ws}/issues/${moving.id}`)).data as Issue;
    expect(movedNow).toMatchObject({ teamId: other.id, identifier: 'OPS-1' });
    expect(a.issue(moving.id)).toMatchObject({ teamId: other.id, identifier: 'OPS-1' });
  });
});

describe('offline guesses', () => {
  const guessed = (i: Issue | undefined) => ({
    stateId: i?.stateId,
    cycleId: i?.cycleId,
    labelIds: [...(i?.labelIds ?? [])].sort(),
    assigneeId: i?.assigneeId,
  });
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  /** A team whose started work joins its active cycle. */
  async function cycleTeam(key: string) {
    const team = (await owner.post(`${ws}/teams`, { name: key, key })).data as { id: string };
    const cycle = (
      await owner.post(`${ws}/teams/${team.id}/cycles`, { startsAt: day(-3), endsAt: day(4) })
    ).data as { id: string };
    const res = await owner.patch(`${ws}/teams/${team.id}`, {
      cyclesEnabled: true,
      cycleAutomation: { enabled: true, addStarted: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    const states = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams.find(
      (t) => t.id === team.id,
    )!.states;
    return { id: team.id, cycleId: cycle.id, started: states.find((s) => s.type === 'started')! };
  }

  it('match what the server decides for a new issue and a team move', async () => {
    const me = (await owner.get('/api/auth/me')).data.id;
    await owner.patch(`${ws}/`, { settings: { defaultAssigneeId: me } });
    try {
      const target = await cycleTeam('CYC');
      const engStates = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams.find(
        (t) => t.id === teamId,
      )!.states;
      const own = (await owner.post(`${ws}/labels`, { name: 'Eng only', color: '#ff1493', teamId }))
        .data.id;
      const any = (await owner.post(`${ws}/labels`, { name: 'Anywhere', color: '#00ffff' })).data
        .id;
      const moving = (
        await owner.post(`${ws}/issues`, {
          teamId,
          title: 'Started, then moved',
          stateId: engStates.find((s) => s.type === 'started')!.id,
          labelIds: [own, any],
          assigneeId: null,
        })
      ).data as Issue;

      const laptop = device(owner);
      const a = new Engine({ userId: me, transport: laptop.transport, store: new MemoryStore() });
      await a.sync();
      laptop.link.offline = true;
      const draftId = crypto.randomUUID();
      await a.mutate({ kind: 'issue.create', issue: { id: draftId, teamId, title: 'Defaults' } });
      await a.mutate({ kind: 'issue.move', ids: [moving.id], teamId: target.id });
      const before = { draft: guessed(a.issue(draftId)), moved: guessed(a.issue(moving.id)) };

      laptop.link.offline = false;
      await a.sync();
      expect(a.getState()).toMatchObject({ waiting: 0, failed: [] });
      const server = async (id: string) =>
        guessed((await owner.get(`${ws}/issues/${id}`)).data as Issue);
      expect(before.draft).toEqual(await server(draftId));
      expect(before.draft.assigneeId).toBe(me);
      expect(before.moved).toEqual(await server(moving.id));
      expect(before.moved).toMatchObject({ stateId: target.started.id, labelIds: [any] });
    } finally {
      await owner.patch(`${ws}/`, { settings: { defaultAssigneeId: null } });
    }
  });

  // The server puts work created as started into the team's active cycle (cycle automation);
  // the local draft doesn't replicate that rule (the workspace's "today", the automation
  // settings), so it shows no cycle until the server answers.
  it.fails('match the server for a new issue created as started in an automated team', async () => {
    const me = (await owner.get('/api/auth/me')).data.id;
    const target = await cycleTeam('AUT');
    const laptop = device(owner);
    const a = new Engine({ userId: me, transport: laptop.transport, store: new MemoryStore() });
    await a.sync();
    laptop.link.offline = true;
    const draftId = crypto.randomUUID();
    await a.mutate({
      kind: 'issue.create',
      issue: { id: draftId, teamId: target.id, title: 'Started', stateId: target.started.id },
    });
    const before = guessed(a.issue(draftId));
    laptop.link.offline = false;
    await a.sync();
    const after = guessed((await owner.get(`${ws}/issues/${draftId}`)).data as Issue);
    expect(after.cycleId).toBe(target.cycleId);
    expect(before).toEqual(after);
  });
});

describe('losing access', () => {
  it("drops a team's issues from a member's device when they leave it", async () => {
    const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
    const member = (await signup(app, 'Leaving Member', { inviteToken: invite })).client;
    const memberId = (await member.get('/api/auth/me')).data.id as string;
    const secret = (await owner.post(`${ws}/teams`, { name: 'Secret', key: 'SEC', private: true }))
      .data.id as string;
    expect(
      (await owner.post(`${ws}/teams/${secret}/members`, { userId: memberId })).statusCode,
    ).toBe(200);
    const hidden = (await owner.post(`${ws}/issues`, { teamId: secret, title: 'Hush' }))
      .data as Issue;
    const open = (await owner.post(`${ws}/issues`, { teamId, title: 'Out in the open' }))
      .data as Issue;

    const store = new MemoryStore();
    const phone = device(member);
    const engine = new Engine({ userId: memberId, transport: phone.transport, store });
    await engine.sync();
    expect(engine.issue(hidden.id)).toBeDefined();
    const { seq, epoch } = (await member.get(`${ws}/sync/snapshot`)).data;

    const left = await owner.del(`${ws}/teams/${secret}/members/${memberId}`);
    expect(left.statusCode, left.body).toBe(200);
    // Changed after they left: the feed must not hand it to them.
    await owner.patch(`${ws}/issues/${hidden.id}`, { title: 'Hush, renamed' });
    const feed = (await member.get(`${ws}/sync/changes?since=${seq}&epoch=${epoch}`)).data;
    expect(feed.bootstrapChanged).toBe(true);
    expect(feed.issues.map((i: Issue) => i.id)).not.toContain(hidden.id);

    await engine.sync();
    expect(engine.issue(hidden.id)).toBeUndefined();
    expect(engine.issue(open.id)).toBeDefined();
    expect(engine.getState().bootstrap!.teams.map((t) => t.id)).not.toContain(secret);
    // Gone from the saved copy too, not just from memory.
    const reopened = new Engine({ userId: memberId, transport: phone.transport, store });
    phone.link.offline = true;
    await reopened.open();
    expect(reopened.issue(hidden.id)).toBeUndefined();
    expect(reopened.issue(open.id)).toBeDefined();
  });
});
