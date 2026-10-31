import type { Bootstrap } from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type Json, signup, testApp } from './helpers.ts';

/**
 * Cross-workspace isolation: an admin of workspace A, calling A's routes with ids that belong to
 * workspace B, finds nothing and changes nothing. A route that loaded rows by id alone, without
 * the workspace, would pass every same-workspace access check and fail here.
 */
let app: FastifyInstance;
let attacker: Client;
let b: Client;
const stamp = Date.now();
const wsA = `/api/w/iso-a-${stamp}`;
const wsB = `/api/w/iso-b-${stamp}`;
const ids: Record<string, string> = {};

const find = (list: Json[], id: string) => list.find((x: { id: string }) => x.id === id);
const bootB = async () => (await b.get(`${wsB}/bootstrap`)).data as Bootstrap;
const commentOf = async (id: string) =>
  find((await b.get(`${wsB}/issues/${ids.issue}/comments`)).data, id);

type Attack = [method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: object];

/** One line per resource: what A tries with B's id (`:id`), and how B reads the row back. */
const RESOURCES: {
  name: string;
  id: () => string;
  attacks: Attack[];
  read: (id: string) => Promise<unknown>;
}[] = [
  {
    name: 'issue',
    id: () => ids.issue!,
    attacks: [
      ['GET', '/issues/:id'],
      ['GET', '/issues/:id/history'],
      ['GET', '/issues/:id/comments'],
      ['PATCH', '/issues/:id', { title: 'Hijacked' }],
      ['POST', '/issues/:id/comments', { body: 'From A' }],
      ['POST', '/issues/:id/subscription'],
      ['POST', '/issues/:id/archive'],
      ['POST', '/issues/batch', { ids: [':id'], patch: { priority: 1 } }],
      ['DELETE', '/issues/:id'],
      ['DELETE', '/issues/:id/purge'],
    ],
    read: async (id) => (await b.get(`${wsB}/issues/${id}`)).data,
  },
  {
    name: 'comment',
    id: () => ids.comment!,
    attacks: [
      ['PATCH', '/comments/:id', { body: 'Hijacked' }],
      ['DELETE', '/comments/:id'],
    ],
    read: commentOf,
  },
  {
    name: 'comment reaction',
    id: () => ids.comment!,
    attacks: [
      ['PUT', `/comments/:id/reactions/${encodeURIComponent('🎉')}`],
      ['DELETE', `/comments/:id/reactions/${encodeURIComponent('👍')}`],
    ],
    read: commentOf,
  },
  {
    name: 'project',
    id: () => ids.project!,
    attacks: [
      ['GET', '/projects/:id'],
      ['GET', '/projects/:id/updates'],
      ['GET', '/projects/:id/documents'],
      ['PATCH', '/projects/:id', { name: 'Hijacked' }],
      ['POST', '/projects/:id/milestones', { name: 'From A' }],
      ['POST', '/projects/:id/documents', { title: 'From A' }],
      ['POST', '/projects/:id/updates', { body: 'From A', health: 'off_track' }],
      ['DELETE', '/projects/:id'],
    ],
    read: async (id) => (await b.get(`${wsB}/projects/${id}`)).data,
  },
  {
    name: 'project update',
    id: () => ids.projectUpdate!,
    attacks: [['DELETE', '/project-updates/:id']],
    read: async (id) => find((await b.get(`${wsB}/projects/${ids.project}/updates`)).data, id),
  },
  {
    name: 'milestone',
    id: () => ids.milestone!,
    attacks: [
      ['PATCH', '/milestones/:id', { name: 'Hijacked' }],
      ['DELETE', '/milestones/:id'],
    ],
    read: async (id) => find((await b.get(`${wsB}/projects/${ids.project}`)).data.milestones, id),
  },
  {
    name: 'document',
    id: () => ids.document!,
    attacks: [
      ['GET', '/documents/:id'],
      ['PATCH', '/documents/:id', { title: 'Hijacked' }],
      ['DELETE', '/documents/:id'],
    ],
    read: async (id) => (await b.get(`${wsB}/documents/${id}`)).data,
  },
  {
    name: 'template',
    id: () => ids.template!,
    attacks: [
      ['PATCH', '/templates/:id', { name: 'Hijacked' }],
      ['DELETE', '/templates/:id'],
    ],
    read: async (id) => find((await b.get(`${wsB}/templates`)).data, id),
  },
  {
    name: 'customer',
    id: () => ids.customer!,
    attacks: [
      ['GET', '/customers/:id/requests'],
      ['PATCH', '/customers/:id', { name: 'Hijacked' }],
      ['DELETE', '/customers/:id'],
    ],
    read: async (id) => find((await b.get(`${wsB}/customers`)).data, id),
  },
  {
    name: 'customer request',
    id: () => ids.customerRequest!,
    attacks: [['DELETE', '/customer-requests/:id']],
    read: async (id) => find((await b.get(`${wsB}/customers/${ids.customer}/requests`)).data, id),
  },
  {
    name: 'export',
    id: () => ids.export!,
    attacks: [['DELETE', '/exports/:id']],
    read: async (id) => find((await b.get(`${wsB}/exports`)).data, id),
  },
  {
    name: 'cycle',
    id: () => ids.cycle!,
    attacks: [
      ['PATCH', '/cycles/:id', { name: 'Hijacked' }],
      ['DELETE', '/cycles/:id'],
    ],
    read: async (id) => find((await b.get(`${wsB}/cycles`)).data, id),
  },
  {
    name: 'label',
    id: () => ids.label!,
    attacks: [
      ['PATCH', '/labels/:id', { name: 'Hijacked' }],
      ['DELETE', '/labels/:id'],
    ],
    read: async (id) => find((await bootB()).labels, id),
  },
  {
    name: 'initiative',
    id: () => ids.initiative!,
    attacks: [
      ['PATCH', '/initiatives/:id', { name: 'Hijacked' }],
      ['DELETE', '/initiatives/:id'],
    ],
    read: async (id) => find((await b.get(`${wsB}/initiatives`)).data, id),
  },
  {
    name: 'agent run',
    id: () => ids.run!,
    attacks: [
      ['POST', '/agent-runs/:id/cancel'],
      ['POST', '/agent-runs/:id/restart'],
      ['POST', '/agent-runs/:id/dismiss'],
      ['POST', '/agent-runs/:id/run-anyway'],
    ],
    read: async (id) => find((await b.get(`${wsB}/issues/${ids.issue}/agent-runs`)).data, id),
  },
  {
    name: 'webhook',
    id: () => ids.webhook!,
    attacks: [
      ['GET', '/webhooks/:id/secret'],
      ['GET', '/webhooks/:id/deliveries'],
      ['PATCH', '/webhooks/:id', { description: 'Hijacked' }],
      ['POST', '/webhooks/:id/rotate-secret'],
      ['POST', '/webhooks/:id/ping'],
      ['DELETE', '/webhooks/:id'],
    ],
    read: async (id) => ({
      hook: find((await b.get(`${wsB}/webhooks`)).data, id),
      secret: (await b.get(`${wsB}/webhooks/${id}/secret`)).data,
      deliveries: (await b.get(`${wsB}/webhooks/${id}/deliveries`)).data,
    }),
  },
  {
    name: 'view',
    id: () => ids.view!,
    attacks: [
      ['PATCH', '/views/:id', { name: 'Hijacked' }],
      ['DELETE', '/views/:id'],
    ],
    read: async (id) => find((await bootB()).views, id),
  },
];

beforeAll(async () => {
  app = await testApp();
  const ownerA = (await signup(app, 'Alma Owner')).client;
  await ownerA.post('/api/workspaces', {
    name: 'Iso A',
    slug: wsA.split('/').at(-1),
    teamName: 'Alpha',
    teamKey: 'ALP',
  });
  const token = (await ownerA.post(`${wsA}/invites`, { role: 'admin' })).data[0].token;
  attacker = (await signup(app, 'Arne Admin', { inviteToken: token })).client;

  b = (await signup(app, 'Bea Owner')).client;
  await b.post('/api/workspaces', {
    name: 'Iso B',
    slug: wsB.split('/').at(-1),
    teamName: 'Beta',
    teamKey: 'BET',
  });
  const team = (await bootB()).teams[0]!.id;
  const made = async (path: string, body: object) => {
    const res = await b.post(`${wsB}${path}`, body);
    expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
    return res.data;
  };
  ids.label = (await made('/labels', { name: 'B label', color: '#ef4444' })).id;
  ids.project = (await made('/projects', { name: 'B project', teamIds: [team] })).id;
  ids.cycle = (
    await made(`/teams/${team}/cycles`, { startsAt: '2026-01-01', endsAt: '2026-01-14' })
  ).id;
  ids.issue = (
    await made('/issues', {
      teamId: team,
      title: 'B issue',
      labelIds: [ids.label],
      projectId: ids.project,
      cycleId: ids.cycle,
    })
  ).id;
  ids.comment = (await made(`/issues/${ids.issue}/comments`, { body: 'B comment' })).id;
  await b.put(`${wsB}/comments/${ids.comment}/reactions/${encodeURIComponent('👍')}`);
  ids.milestone = (
    await made(`/projects/${ids.project}/milestones`, { name: 'B ms' })
  ).milestones[0].id;
  ids.document = (await made(`/projects/${ids.project}/documents`, { title: 'B doc' })).id;
  ids.projectUpdate = (
    await made(`/projects/${ids.project}/updates`, { body: 'B update', health: 'on_track' })
  ).id;
  ids.template = (await made('/templates', { name: 'B template' })).id;
  ids.customer = (await made('/customers', { name: 'B customer' })).id;
  ids.customerRequest = (
    await made(`/issues/${ids.issue}/customer-requests`, { customerId: ids.customer, body: 'B' })
  ).id;
  ids.initiative = (await made('/initiatives', { name: 'B initiative' })).id;
  ids.view = (await made('/views', { name: 'B view', filters: {} })).id;
  ids.webhook = (await made('/webhooks', { url: 'https://example.com/b-hook' })).webhook.id;
  const agent = (await made('/agents', { name: 'B agent', teamIds: [team] })).id;
  await b.patch(`${wsB}/issues/${ids.issue}`, { assigneeId: agent });
  ids.run = (await b.get(`${wsB}/issues/${ids.issue}/agent-runs`)).data[0].id;
  ids.export = (await made('/exports', { format: 'json' })).id;
  await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
  await app.jobs.drain();
});

afterAll(() => app.close());

describe("another workspace's ids", () => {
  it.each(RESOURCES.map((r) => [r.name, r] as const))(
    'find nothing and change nothing: %s',
    async (_, r) => {
      const id = r.id();
      const before = await r.read(id);
      expect(before, 'B reads its own row').toBeTruthy();
      for (const [method, path, body] of r.attacks) {
        // An unknown route is a 404 too, so make sure each one exists.
        const pattern = `/api/w/:ws${path.replace(/reactions\/[^/]+$/, 'reactions/:emoji')}`;
        expect(app.hasRoute({ method, url: pattern }), `${method} ${pattern}`).toBe(true);
        const url = `${wsA}${path.replace(':id', id)}`;
        const payload = body && JSON.parse(JSON.stringify(body).replace('":id"', `"${id}"`));
        const res = await attacker.req(method, url, payload ?? (method === 'GET' ? undefined : {}));
        // A list under an unknown parent may come back empty rather than 404; it shows nothing.
        const found = method === 'GET' && res.statusCode === 200 && res.body === '[]' ? 404 : null;
        expect(found ?? res.statusCode, `${method} ${path}: ${res.body}`).toBe(404);
      }
      expect(await r.read(id)).toEqual(before);
    },
  );
});
