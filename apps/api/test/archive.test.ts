import type { Bootstrap, HistoryEntry, Issue, SearchResults, Team } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, issues } from '../src/db/schema.ts';
import { autoArchive, automationBot } from '../src/services/automation.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/arc';
let boot: Bootstrap;
let team: Team;
const ids: Record<string, string> = {};

const titles = async (filter: object) =>
  (
    (await owner.post(`${ws}/issues/query`, { filter: { teamId: team.id, ...filter } }))
      .data as Issue[]
  )
    .map((i) => i.title)
    .sort();
const get = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as Issue;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Arc',
    slug: 'arc',
    teamName: 'Eng',
    teamKey: 'ENG',
  });
  member = (
    await signup(app, 'Mona Member', {
      inviteToken: (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token,
    })
  ).client;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  team = boot.teams[0]!;
  const state = (type: string) => team.states.find((s) => s.type === type)!.id;
  const make = async (title: string, type: string) =>
    (
      (await owner.post(`${ws}/issues`, { teamId: team.id, title, stateId: state(type) }))
        .data as Issue
    ).id;
  ids.old = await make('Shipped long ago', 'completed');
  ids.oldCanceled = await make('Dropped long ago', 'canceled');
  ids.recent = await make('Shipped yesterday', 'completed');
  ids.open = await make('Still open', 'unstarted');
  await app.db
    .update(issues)
    .set({ completedAt: sql`now() - interval '4 months'` })
    .where(eq(issues.id, ids.old));
  await app.db
    .update(issues)
    .set({ canceledAt: sql`now() - interval '4 months'` })
    .where(eq(issues.id, ids.oldCanceled));
});

afterAll(() => app.close());

describe('auto-archive', () => {
  it('is off until a team picks an interval', async () => {
    expect(team.autoArchiveMonths).toBeNull();
    await autoArchive(app);
    expect((await get(ids.old)).archivedAt).toBeNull();
  });

  it('archives issues closed longer ago than the interval, as the Ordo bot', async () => {
    const res = await owner.patch(`${ws}/teams/${team.id}`, { autoArchiveMonths: 3 });
    expect(res.statusCode).toBe(200);
    expect((await owner.patch(`${ws}/teams/${team.id}`, { autoArchiveMonths: 2 })).statusCode).toBe(
      400,
    );
    await autoArchive(app);
    expect((await get(ids.old)).archivedAt).not.toBeNull();
    expect((await get(ids.oldCanceled)).archivedAt).not.toBeNull();
    expect((await get(ids.recent)).archivedAt).toBeNull();
    expect((await get(ids.open)).archivedAt).toBeNull();
    const history = (await owner.get(`${ws}/issues/${ids.old}/history`)).data as HistoryEntry[];
    expect(history.at(-1)).toMatchObject({
      actorId: await automationBot(app.db, boot.workspace.id),
      changes: [{ field: 'archived', from: false, to: true }],
    });
    const events = await app.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.type, 'issue.archived'));
    expect(events.map((e) => e.data.identifier).sort()).toEqual(['ENG-1', 'ENG-2']);
    // Running again changes nothing.
    await autoArchive(app);
    expect(
      await app.db.select().from(domainEvents).where(eq(domainEvents.type, 'issue.archived')),
    ).toHaveLength(2);
  });

  it('keeps archived issues out of lists but findable', async () => {
    expect(await titles({})).toEqual(['Shipped yesterday', 'Still open']);
    expect(await titles({ archived: 'only' })).toEqual(['Dropped long ago', 'Shipped long ago']);
    expect(await titles({ archived: 'include' })).toHaveLength(4);
    const found = (await owner.get(`${ws}/search?q=shipped`)).data as SearchResults;
    expect(found.issues.map((i) => i.title).sort()).toEqual([
      'Shipped long ago',
      'Shipped yesterday',
    ]);
    expect((await owner.get(`${ws}/issues/ENG-1`)).statusCode).toBe(200);
  });

  it('brings an issue back when it reopens or is unarchived', async () => {
    const todo = team.states.find((s) => s.type === 'unstarted')!.id;
    await owner.patch(`${ws}/issues/${ids.old}`, { stateId: todo });
    expect((await get(ids.old)).archivedAt).toBeNull();
    const res = await member.post(`${ws}/issues/${ids.oldCanceled}/unarchive`);
    expect(res.statusCode).toBe(200);
    expect((res.data as Issue).archivedAt).toBeNull();
  });

  it('archives by hand too, within the same access rules', async () => {
    const res = await member.post(`${ws}/issues/${ids.open}/archive`);
    expect((res.data as Issue).archivedAt).not.toBeNull();
    const prv = (await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true }))
      .data as Team;
    const secret = (await owner.post(`${ws}/issues`, { teamId: prv.id, title: 'Secret' }))
      .data as Issue;
    expect((await member.post(`${ws}/issues/${secret.id}/archive`)).statusCode).toBe(404);
  });
});
