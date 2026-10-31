import { describe, expect, it } from 'vitest';
import { OfflineError, RejectedError, ResyncError, SignedOutError } from './engine.ts';
import type { Op } from './outbox.ts';
import { type Method, restTransport } from './rest.ts';

class HttpError extends Error {
  constructor(
    public status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
  }
}

/** A transport whose every request fails with `status` (or succeeds when it's null). */
function failing(status: number | null) {
  const calls: { method: Method; path: string; body?: unknown }[] = [];
  const transport = restTransport(async (method, path, body) => {
    calls.push({ method, path, body });
    if (status !== null) throw new HttpError(status);
    return { method, path };
  });
  return { transport, calls };
}

const del: Op = { kind: 'comment.delete', id: 'c1', issueId: 'i1' };
const unreact: Op = { kind: 'reaction', commentId: 'c1', issueId: 'i1', emoji: '👍', on: false };
const update: Op = { kind: 'issue.update', ids: ['i1'], patch: { title: 'x' } };

describe('sending', () => {
  it('maps each change onto its REST call, picking the fields the API takes', async () => {
    const { transport, calls } = failing(null);
    await transport.send({
      kind: 'comment.create',
      comment: { id: 'c1', issueId: 'i1', body: 'hi', parentId: null, extra: 1 } as never,
    });
    await transport.send({
      kind: 'relation.create',
      relation: {
        id: 'r1',
        issueId: 'i1',
        type: 'blocks',
        relatedIssueId: 'i2',
        extra: 1,
      } as never,
    });
    await transport.send(unreact);
    await transport.send({ kind: 'issue.update', ids: ['a', 'b'], patch: { priority: 1 } });
    await transport.send({ kind: 'issue.move', ids: ['a', 'b'], teamId: 't2' });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/issues/i1/comments',
        body: { id: 'c1', body: 'hi', parentId: null },
      },
      {
        method: 'POST',
        path: '/issues/i1/relations',
        body: { id: 'r1', type: 'blocks', relatedIssueId: 'i2' },
      },
      { method: 'DELETE', path: `/comments/c1/reactions/${encodeURIComponent('👍')}` },
      { method: 'POST', path: '/issues/batch', body: { ids: ['a', 'b'], patch: { priority: 1 } } },
      { method: 'PATCH', path: '/issues/a', body: { teamId: 't2' } },
      { method: 'PATCH', path: '/issues/b', body: { teamId: 't2' } },
    ]);
  });

  it('stops a one-at-a-time change at the first refusal', async () => {
    const { transport, calls } = failing(403);
    await expect(transport.send({ kind: 'issue.restore', ids: ['a', 'b'] })).rejects.toThrow(
      RejectedError,
    );
    expect(calls).toHaveLength(1);
  });

  it('counts a 404 as done only for deletions', async () => {
    await expect(failing(404).transport.send(del)).resolves.toEqual({ ok: true });
    await expect(
      failing(404).transport.send({ kind: 'relation.delete', id: 'r1' }),
    ).resolves.toEqual({ ok: true });
    // Taking back a reaction is a DELETE, but the comment being gone is a refusal.
    await expect(failing(404).transport.send(unreact)).rejects.toThrow(RejectedError);
    await expect(failing(404).transport.send(update)).rejects.toThrow(RejectedError);
  });

  it('stops on 401, goes offline on 0/502/503/504, and refuses other 4xx but 429', async () => {
    await expect(failing(401).transport.send(update)).rejects.toThrow(SignedOutError);
    for (const status of [0, 502, 503, 504])
      await expect(failing(status).transport.send(update)).rejects.toThrow(OfflineError);
    for (const status of [400, 403, 409, 410, 422])
      await expect(failing(status).transport.send(update)).rejects.toThrow(RejectedError);
    // Worth another try: thrown as is.
    for (const status of [429, 500]) {
      const err = await failing(status)
        .transport.send(update)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
    }
  });

  it('passes errors without a status through', async () => {
    const boom = new TypeError('bug');
    const transport = restTransport(async () => {
      throw boom;
    });
    await expect(transport.send(update)).rejects.toBe(boom);
  });
});

describe('reading', () => {
  it('asks for a fresh load on 410 and goes offline when unreachable', async () => {
    await expect(failing(410).transport.changes(5, 1)).rejects.toThrow(ResyncError);
    await expect(failing(503).transport.snapshot()).rejects.toThrow(OfflineError);
    await expect(failing(0).transport.issues(null, 10)).rejects.toThrow(OfflineError);
  });

  it('leaves 401 and other refusals to the caller', async () => {
    for (const status of [401, 403, 404]) {
      const err = await failing(status)
        .transport.comments('i1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
    }
  });

  it('reads from the workspace-relative sync paths', async () => {
    const { transport, calls } = failing(null);
    await transport.changes(5, 2);
    await transport.issues('cursor', 50);
    expect(calls).toEqual([
      { method: 'GET', path: '/sync/changes?since=5&epoch=2' },
      { method: 'POST', path: '/sync/issues', body: { after: 'cursor', limit: 50 } },
    ]);
  });
});
