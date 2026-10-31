import type { Issue, SearchResults } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/find';
const ids: Record<string, string> = {};

const search = async (c: Client, q: string) =>
  ((await c.get(`${ws}/search?q=${encodeURIComponent(q)}`)).data as SearchResults).issues.map(
    (i) => i.title,
  );

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Find',
    slug: 'find',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const token = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: token })).client;
  const boot = (await owner.get(`${ws}/bootstrap`)).data;
  ids.pub = boot.teams[0].id;
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })
  ).data.id;
  const create = async (teamId: string, title: string, description = '') =>
    ((await owner.post(`${ws}/issues`, { teamId, title, description })).data as Issue).id;
  await create(ids.pub, 'Realtime reconnect storms', 'Clients hammer the server after a deploy.');
  await create(ids.pub, 'Improve onboarding', 'The realtime indicator confuses new people.');
  await create(ids.pub, 'Översätt inställningar', 'Svenska tecken: räksmörgås.');
  const quiet = await create(ids.pub, 'Quiet issue', 'Nothing to see.');
  await owner.post(`${ws}/issues/${quiet}/comments`, { body: 'Seen with websocket proxies too' });
  await create(ids.prv, 'Realtime secret plan');
  const binned = await create(ids.pub, 'Realtime binned idea');
  await owner.del(`${ws}/issues/${binned}`);
  // Another workspace of the same person, with matching words.
  await owner.post('/api/workspaces', {
    name: 'Elsewhere',
    slug: 'find-elsewhere',
    teamName: 'Far',
    teamKey: 'FAR',
  });
  const far = (await owner.get('/api/w/find-elsewhere/bootstrap')).data.teams[0].id;
  await owner.post('/api/w/find-elsewhere/issues', { teamId: far, title: 'Realtime elsewhere' });
});

afterAll(() => app.close());

describe('full-text search', () => {
  it('finds words in titles before descriptions, as prefixes', async () => {
    const hits = await search(owner, 'realtime');
    expect(hits.slice(0, 2).sort()).toEqual(['Realtime reconnect storms', 'Realtime secret plan']);
    expect(hits[2]).toBe('Improve onboarding');
    expect(await search(owner, 'realt')).toHaveLength(3);
    expect(await search(owner, 'reconn storm')).toEqual(['Realtime reconnect storms']);
    expect(await search(owner, 'hammer deploy')).toEqual(['Realtime reconnect storms']);
  });

  it('finds issues by their comments', async () => {
    expect(await search(owner, 'websocket prox')).toEqual(['Quiet issue']);
  });

  it('handles any language, identifiers and punctuation', async () => {
    expect(await search(owner, 'räksmörg')).toEqual(['Översätt inställningar']);
    expect(await search(owner, 'PUB-1')).toEqual(['Realtime reconnect storms']);
    expect(await search(owner, "'):*&|!")).toEqual([]);
  });

  it('respects private teams', async () => {
    expect(await search(member, 'realtime')).not.toContain('Realtime secret plan');
    expect(await search(member, 'realtime')).toHaveLength(2);
  });

  it("leaves out trashed issues and other workspaces' issues", async () => {
    const hits = await search(owner, 'realtime');
    expect(hits).not.toContain('Realtime binned idea');
    expect(hits).not.toContain('Realtime elsewhere');
    expect(await search(owner, 'binned')).toEqual([]);
    expect(await search(owner, 'elsewhere')).toEqual([]);
    expect(await search(owner, 'FAR-1')).toEqual([]);
    const there = await owner.get(`/api/w/find-elsewhere/search?q=realtime`);
    expect((there.data as SearchResults).issues.map((i) => i.title)).toEqual([
      'Realtime elsewhere',
    ]);
  });

  it('applies to issue filters too', async () => {
    const res = await owner.post(`${ws}/issues/query`, { filter: { q: 'websocket' } });
    expect((res.data as Issue[]).map((i) => i.title)).toEqual(['Quiet issue']);
  });
});
