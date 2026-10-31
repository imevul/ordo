import type { Comment, SyncChanges, SyncIssuePage, SyncSnapshot } from '@ordo/shared';
import {
  OfflineError,
  RejectedError,
  ResyncError,
  SignedOutError,
  type Transport,
} from './engine.ts';
import type { Op } from './outbox.ts';

/**
 * The engine's `Transport` over Ordo's REST API, for any client that can make an HTTP request.
 * The client brings `request`; this decides which call each change is and what a failed status
 * means for the engine, so every app (and the API's own tests) agree on it.
 */

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * One request to a workspace-relative path (`/issues`). Resolves with the parsed body; rejects
 * with an error carrying the HTTP `status`, 0 when the server couldn't be reached.
 */
export type RestRequest = (method: Method, path: string, body?: unknown) => Promise<unknown>;

const statusOf = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** Down or unreachable (a proxy answering for a stopped API counts). */
const unreachable = (status: number | undefined) =>
  status === 0 || status === 502 || status === 503 || status === 504;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Each queued change as the REST call(s) it stands for. */
export function sendOp(request: RestRequest, op: Op): Promise<unknown> {
  switch (op.kind) {
    case 'issue.create':
      return request('POST', '/issues', op.issue);
    case 'issue.update':
      return op.ids.length === 1
        ? request('PATCH', `/issues/${op.ids[0]}`, op.patch)
        : request('POST', '/issues/batch', { ids: op.ids, patch: op.patch });
    case 'issue.trash':
      return request('POST', '/issues/batch-delete', { ids: op.ids });
    // No batch endpoints for these; one at a time, so a refusal stops before the rest. Each is
    // safe to send again (restoring a restored issue, moving it to the team it's in).
    case 'issue.restore':
      return (async () => {
        const restored: unknown[] = [];
        for (const id of op.ids) restored.push(await request('POST', `/issues/${id}/restore`));
        return restored;
      })();
    case 'issue.move':
      return (async () => {
        const moved: unknown[] = [];
        for (const id of op.ids)
          moved.push(await request('PATCH', `/issues/${id}`, { teamId: op.teamId }));
        return moved;
      })();
    case 'comment.create':
      return request('POST', `/issues/${op.comment.issueId}/comments`, {
        id: op.comment.id,
        body: op.comment.body,
        parentId: op.comment.parentId,
      });
    case 'comment.update':
      return request('PATCH', `/comments/${op.id}`, { body: op.body });
    case 'comment.delete':
      return request('DELETE', `/comments/${op.id}`);
    case 'reaction':
      return request(
        op.on ? 'PUT' : 'DELETE',
        `/comments/${op.commentId}/reactions/${encodeURIComponent(op.emoji)}`,
      );
    case 'relation.create':
      return request('POST', `/issues/${op.relation.issueId}/relations`, {
        id: op.relation.id,
        type: op.relation.type,
        relatedIssueId: op.relation.relatedIssueId,
      });
    case 'relation.delete':
      return request('DELETE', `/relations/${op.id}`);
  }
}

/** A failed read (snapshot, pages, the change log, comments) as the engine expects it. */
export function readError(err: unknown): unknown {
  const status = statusOf(err);
  if (unreachable(status)) return new OfflineError(message(err));
  if (status === 410) return new ResyncError(message(err));
  return err;
}

/**
 * A failed send as the engine expects it, or `done` when the failure means the change already
 * holds. Anything else is thrown as is and tried again later.
 */
export function sendError(op: Op, err: unknown): { done: true } | { error: unknown } {
  const status = statusOf(err);
  if (unreachable(status)) return { error: new OfflineError(message(err)) };
  if (status === undefined) return { error: err };
  if (status === 401) return { error: new SignedOutError(message(err)) };
  // Deleting what's already gone is done.
  if (status === 404 && /delete$/.test(op.kind)) return { done: true };
  // Refused for good (validation, permissions, gone); 5xx and 429 are worth another try.
  if (status >= 400 && status < 500 && status !== 429)
    return { error: new RejectedError(message(err)) };
  return { error: err };
}

export function restTransport(request: RestRequest): Transport {
  const read = async <T>(method: Method, path: string, body?: unknown) => {
    try {
      return (await request(method, path, body)) as T;
    } catch (err) {
      throw readError(err);
    }
  };
  return {
    snapshot: () => read<SyncSnapshot>('GET', '/sync/snapshot'),
    issues: (after, limit) => read<SyncIssuePage>('POST', '/sync/issues', { after, limit }),
    changes: (since, epoch) =>
      read<SyncChanges>('GET', `/sync/changes?since=${since}&epoch=${epoch}`),
    comments: (issueId) => read<Comment[]>('GET', `/issues/${issueId}/comments`),
    send: async (op) => {
      try {
        return await sendOp(request, op);
      } catch (err) {
        const out = sendError(op, err);
        if ('done' in out) return { ok: true };
        throw out.error;
      }
    },
  };
}
