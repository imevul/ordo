import type { Comment, SyncChanges, SyncIssuePage, SyncSnapshot } from '@ordo/shared';
import {
  type Delta,
  dbName,
  Engine,
  IdbStore,
  MemoryStore,
  OfflineError,
  ResyncError,
  type SyncStore,
  type Transport,
} from '@ordo/sync';
import { ApiError, api, wsPath } from '../api/client.ts';

/**
 * One tab's sync for one workspace. Tabs share the copy in IndexedDB: the one holding the Web
 * Lock talks to the server and tells the others (over a BroadcastChannel) what it saved, so a
 * dozen open tabs make one set of requests. When it closes, another tab takes the lock over.
 */

/** Down or unreachable (a proxy answering for a stopped API counts). */
const unreachable = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504);

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
  };
}

async function openStore(name: string): Promise<SyncStore> {
  try {
    return await IdbStore.open(name);
  } catch {
    // Private windows and full disks: keep the copy in memory for this tab only.
    return new MemoryStore();
  }
}

export interface SyncSession {
  engine: Engine;
  stop: () => void;
}

export async function startSync(slug: string, userId: string): Promise<SyncSession> {
  const name = dbName(userId, slug);
  const store = await openStore(name);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null;
  const engine = new Engine({
    transport: transport(slug),
    store,
    onDelta: (delta) => channel?.postMessage(delta),
    onError: (err) => console.warn('Sync failed:', err),
  });
  channel?.addEventListener('message', (e: MessageEvent<Delta>) => engine.receive(e.data));
  await engine.open();

  let stopped = false;
  const release = new AbortController();
  const online = () => void engine.sync();
  window.addEventListener('online', online);
  const visible = () => {
    if (document.visibilityState === 'visible') void engine.sync();
  };
  document.addEventListener('visibilitychange', visible);

  if (navigator.locks) {
    engine.leader = false;
    // Held until this tab stops; the next tab in line takes over then.
    navigator.locks
      .request(`${name}:leader`, { signal: release.signal }, () => {
        if (stopped) return;
        engine.leader = true;
        void engine.sync();
        return new Promise<void>((resolve) =>
          release.signal.addEventListener('abort', () => resolve()),
        );
      })
      .catch(() => {
        // aborted while waiting in line
      });
  } else void engine.sync();

  return {
    engine,
    stop: () => {
      stopped = true;
      release.abort();
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
      channel?.close();
      engine.close();
    },
  };
}
