import {
  type Delta,
  dbName,
  Engine,
  FallbackStore,
  IdbStore,
  lead,
  MemoryStore,
  restTransport,
  type SyncStore,
  type Transport,
} from '@ordo/sync';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { t } from '../i18n/index.ts';

/**
 * One tab's sync for one workspace. Tabs share the copy in IndexedDB: the one holding the Web
 * Lock talks to the server and tells the others (over a BroadcastChannel) what it saved, so a
 * dozen open tabs make one set of requests. When it closes, another tab takes the lock over.
 */

const methods = { POST: api.post, PATCH: api.patch, PUT: api.put, DELETE: api.del };

/** The REST transport over the app's client, whose `ApiError` carries the status it maps. */
const transport = (slug: string): Transport =>
  restTransport((method, path, body) =>
    method === 'GET' ? api.get(wsPath(slug, path)) : methods[method](wsPath(slug, path), body),
  );

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
