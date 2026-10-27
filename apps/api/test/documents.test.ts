import type { Bootstrap, ProjectDocument } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let guest: Client;
const ws = '/api/w/docs';
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Docs',
    slug: 'docs',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite('member') })).client;
  guest = (await signup(app, 'Gus Guest', { inviteToken: await invite('guest') })).client;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  ids.pub = boot.teams[0]!.id;
  await owner.post(`${ws}/teams/${ids.pub}/members`, {
    userId: (await guest.get('/api/auth/me')).data.id,
  });
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })
  ).data.id;
  ids.project = (
    await owner.post(`${ws}/projects`, { name: 'Launch', teamIds: [ids.pub] })
  ).data.id;
  ids.secret = (await owner.post(`${ws}/projects`, { name: 'Secret', teamIds: [ids.prv] })).data.id;
});

afterAll(() => app.close());

describe('project documents', () => {
  it('are written by members and read by anyone who sees the project', async () => {
    const res = await member.post(`${ws}/projects/${ids.project}/documents`, {
      title: 'Launch plan',
      content: '## Goals\n\n- Ship',
    });
    expect(res.statusCode).toBe(200);
    const doc = res.data as ProjectDocument;
    ids.doc = doc.id;
    const list = (await guest.get(`${ws}/projects/${ids.project}/documents`))
      .data as ProjectDocument[];
    expect(list.map((d) => [d.title, d.content])).toEqual([['Launch plan', undefined]]);
    expect(((await guest.get(`${ws}/documents/${doc.id}`)).data as ProjectDocument).content).toBe(
      '## Goals\n\n- Ship',
    );
    expect((await guest.patch(`${ws}/documents/${doc.id}`, { title: 'Mine' })).statusCode).toBe(
      403,
    );
    expect(
      (await guest.post(`${ws}/projects/${ids.project}/documents`, { title: 'x' })).statusCode,
    ).toBe(403);
  });

  it('refuse a save based on an older version', async () => {
    const current = (await owner.get(`${ws}/documents/${ids.doc}`)).data as ProjectDocument;
    const first = await owner.patch(`${ws}/documents/${ids.doc}`, {
      content: 'Owner was here',
      baseUpdatedAt: current.updatedAt,
    });
    expect(first.statusCode).toBe(200);
    const stale = await member.patch(`${ws}/documents/${ids.doc}`, {
      content: 'Member overwrites',
      baseUpdatedAt: current.updatedAt,
    });
    expect(stale.statusCode).toBe(409);
    const forced = await member.patch(`${ws}/documents/${ids.doc}`, { content: 'Member decided' });
    expect(forced.statusCode).toBe(200);
    expect((forced.data as ProjectDocument).updatedById).toBe(
      (await member.get('/api/auth/me')).data.id,
    );
  });

  it("stay inside projects people can't see", async () => {
    const secret = (
      await owner.post(`${ws}/projects/${ids.secret}/documents`, { title: 'Pricing' })
    ).data as ProjectDocument;
    expect((await member.get(`${ws}/projects/${ids.secret}/documents`)).statusCode).toBe(404);
    expect((await member.get(`${ws}/documents/${secret.id}`)).statusCode).toBe(404);
    expect((await member.del(`${ws}/documents/${secret.id}`)).statusCode).toBe(404);
  });

  it('can be deleted, and go with their project', async () => {
    expect((await member.del(`${ws}/documents/${ids.doc}`)).statusCode).toBe(200);
    await owner.post(`${ws}/projects/${ids.project}/documents`, { title: 'Notes' });
    await owner.del(`${ws}/projects/${ids.project}`);
    expect((await owner.get(`${ws}/projects/${ids.project}/documents`)).statusCode).toBe(404);
  });
});
