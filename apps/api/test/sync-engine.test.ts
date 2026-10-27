import type { Bootstrap, Issue } from '@ordo/shared';
import {
  Engine,
  OfflineError,
  RejectedError,
  ResyncError,
  SignedOutError,
  type Transport,
} from '@ordo/sync/engine';
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

/** The web app's transport, over app.inject; `offline` makes the device unreachable. */
function device(client: Client) {
  const link = { offline: false };
  const call = async (method: string, path: string, body?: unknown) => {
    if (link.offline) throw new OfflineError('offline');
    const res = await client.req(method, `${ws}${path}`, body);
    if (res.statusCode < 400) return res.data;
    if (res.statusCode === 410) throw new ResyncError('resync');
    if (res.statusCode === 401) throw new SignedOutError('signed out');
    if (res.statusCode === 404 && method === 'DELETE') return { ok: true };
    if (res.statusCode < 500 && res.statusCode !== 429) throw new RejectedError(res.data.message);
    throw new Error(`HTTP ${res.statusCode}`);
  };
  const transport: Transport = {
    snapshot: () => call('GET', '/sync/snapshot'),
    issues: (after, limit) => call('POST', '/sync/issues', { after, limit }),
    changes: (since, epoch) => call('GET', `/sync/changes?since=${since}&epoch=${epoch}`),
    comments: (issueId) => call('GET', `/issues/${issueId}/comments`),
    send: (op) => {
      switch (op.kind) {
        case 'issue.create':
          return call('POST', '/issues', op.issue);
        case 'issue.update':
          return op.ids.length === 1
            ? call('PATCH', `/issues/${op.ids[0]}`, op.patch)
            : call('POST', '/issues/batch', { ids: op.ids, patch: op.patch });
        case 'issue.trash':
          return call('POST', '/issues/batch-delete', { ids: op.ids });
        case 'comment.create':
          return call('POST', `/issues/${op.comment.issueId}/comments`, op.comment);
        case 'comment.update':
          return call('PATCH', `/comments/${op.id}`, { body: op.body });
        case 'comment.delete':
          return call('DELETE', `/comments/${op.id}`);
        case 'reaction':
          return call(
            op.on ? 'PUT' : 'DELETE',
            `/comments/${op.commentId}/reactions/${encodeURIComponent(op.emoji)}`,
          );
        case 'relation.create':
          return call('POST', `/issues/${op.relation.issueId}/relations`, op.relation);
        case 'relation.delete':
          return call('DELETE', `/relations/${op.id}`);
      }
    },
  };
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
});
