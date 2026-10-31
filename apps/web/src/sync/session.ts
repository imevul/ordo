import type { Comment, SyncChanges, SyncIssuePage, SyncSnapshot } from '@ordo/shared';
import {
  type Delta,
  dbName,
  Engine,
  FallbackStore,
  IdbStore,
  lead,
  MemoryStore,
  OfflineError,
  type Op,
  RejectedError,
  ResyncError,
  SignedOutError,
  type SyncStore,
  type Transport,
} from '@ordo/sync';
import { toast } from 'sonner';
import { ApiError, api, wsPath } from '../api/client.ts';
import { t } from '../i18n/index.ts';

/**
 * One tab's sync for one workspace. Tabs share the copy in IndexedDB: the one holding the Web
 * Lock talks to the server and tells the others (over a BroadcastChannel) what it saved, so a
 * dozen open tabs make one set of requests. When it closes, another tab takes the lock over.
 */

/** Down or unreachable (a proxy answering for a stopped API counts). */
const unreachable = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504);

/** Each queued change as the REST call it stands for. */
function sendOp(slug: string, op: Op): Promise<unknown> {
  const path = (p: string) => wsPath(slug, p);
  switch (op.kind) {
    case 'issue.create':
      return api.post(path('/issues'), op.issue);
    case 'issue.update':
      return op.ids.length === 1
        ? api.patch(path(`/issues/${op.ids[0]}`), op.patch)
        : api.post(path('/issues/batch'), { ids: op.ids, patch: op.patch });
    case 'issue.trash':
      return api.post(path('/issues/batch-delete'), { ids: op.ids });
    // No batch endpoints for these; one at a time, so a refusal stops before the rest. Each is
    // safe to send again (restoring a restored issue, moving it to the team it's in).
    case 'issue.restore':
      return (async () => {
        for (const id of op.ids) await api.post(path(`/issues/${id}/restore`));
        return { ok: true };
      })();
    case 'issue.move':
      return (async () => {
        const moved: unknown[] = [];
        for (const id of op.ids)
          moved.push(await api.patch(path(`/issues/${id}`), { teamId: op.teamId }));
        return moved;
      })();
    case 'comment.create':
      return api.post(path(`/issues/${op.comment.issueId}/comments`), {
        id: op.comment.id,
        body: op.comment.body,
        parentId: op.comment.parentId,
      });
    case 'comment.update':
      return api.patch(path(`/comments/${op.id}`), { body: op.body });
    case 'comment.delete':
      return api.del(path(`/comments/${op.id}`));
    case 'reaction': {
      const p = path(`/comments/${op.commentId}/reactions/${encodeURIComponent(op.emoji)}`);
      return op.on ? api.put(p) : api.del(p);
    }
    case 'relation.create':
      return api.post(path(`/issues/${op.relation.issueId}/relations`), {
        id: op.relation.id,
        type: op.relation.type,
        relatedIssueId: op.relation.relatedIssueId,
      });
    case 'relation.delete':
      return api.del(path(`/relations/${op.id}`));
  }
}

function transport(slug: string): Transport {
  const call = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (unreachable(err)) throw new OfflineError((err as Error).message);
      if (err instanceof ApiError && err.status === 410) throw new ResyncError(err.message);
      throw err;
    }
  };
  return {
    snapshot: () => call(() => api.get<SyncSnapshot>(wsPath(slug, '/sync/snapshot'))),
    issues: (after, limit) =>
      call(() => api.post<SyncIssuePage>(wsPath(slug, '/sync/issues'), { after, limit })),
    changes: (since, epoch) =>
      call(() => api.get<SyncChanges>(wsPath(slug, `/sync/changes?since=${since}&epoch=${epoch}`))),
    comments: (issueId) =>
      call(() => api.get<Comment[]>(wsPath(slug, `/issues/${issueId}/comments`))),
    send: async (op) => {
      try {
        return await sendOp(slug, op);
      } catch (err) {
        if (unreachable(err)) throw new OfflineError((err as Error).message);
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 401) throw new SignedOutError(err.message);
        // Deleting what's already gone is done.
        if (err.status === 404 && /delete$/.test(op.kind)) return { ok: true };
        // Refused for good (validation, permissions, gone); 5xx and 429 are worth another try.
        if (err.status >= 400 && err.status < 500 && err.status !== 429)
          throw new RejectedError(err.message);
        throw err;
      }
    },
  };
}

async function openStore(name: string, onVersionChange: () => void): Promise<SyncStore> {
  try {
    const store = await IdbStore.open(name, onVersionChange);
    // Ask the browser not to evict the copy under storage pressure (Safari otherwise clears it).
    void navigator.storage?.persist?.().catch(() => {});
    return new FallbackStore(store, () => toast.warning(t('shell.offline.storageFull')));
  } catch {
    // Private windows and full disks: keep the copy in memory for this tab only.
    return new MemoryStore();
  }
}

export interface SyncSession {
  engine: Engine;
  stop: () => void;
}

/**
 * `onEnded`: the session stopped by itself (a newer version of the app upgraded the database in
 * another tab); this tab carries on without a copy.
 */
export async function startSync(
  slug: string,
  userId: string,
  onEnded: () => void,
): Promise<SyncSession> {
  const name = dbName(userId, slug);
  let session: SyncSession | null = null;
  let ended = false;
  // The database is closed now, so this tab can't save anything: let go of the lock, or the
  // upgraded tabs wait behind a leader that can't write.
  const store = await openStore(name, () => {
    if (ended) return;
    ended = true;
    if (session) {
      session.stop();
      onEnded();
    }
  });
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null;
  const engine = new Engine({
    userId,
    transport: transport(slug),
    store,
    onDelta: (delta) => channel?.postMessage(delta),
    onError: (err) => console.warn('Sync failed:', err),
  });
  channel?.addEventListener('message', (e: MessageEvent<Delta>) => engine.receive(e.data));
  await engine.open();

  const online = () => void engine.sync();
  window.addEventListener('online', online);
  const visible = () => {
    if (document.visibilityState === 'visible') void engine.sync();
  };
  document.addEventListener('visibilitychange', visible);

  // Held until this tab stops; the next tab in line takes over then.
  const release = lead(engine, navigator.locks, `${name}:leader`);

  let stopped = false;
  session = {
    engine,
    stop: () => {
      if (stopped) return;
      stopped = true;
      release();
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
      channel?.close();
      engine.close();
    },
  };
  // Upgraded while it opened: never started, as far as the caller knows.
  if (ended) {
    session.stop();
    throw new Error('The local copy was upgraded in another tab.');
  }
  return session;
}
