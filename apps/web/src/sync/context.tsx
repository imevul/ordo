import type { Issue, IssueFilter, OfflineSyncMode } from '@ordo/shared';
import {
  deleteLocalCopies,
  type Engine,
  matchesLocally,
  matchIssue,
  type SyncState,
} from '@ordo/sync';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useKeepsCopy } from './device.ts';
import { type SyncSession, startSync } from './session.ts';

/**
 * The workspace's local copy, for the hooks in api/queries.ts. `starting` while the copy opens
 * (a few milliseconds), so screens wait for it rather than fetch what it already has.
 */
type SyncContext = { status: 'off' } | { status: 'starting' } | { status: 'on'; engine: Engine };

const Ctx = createContext<SyncContext>({ status: 'off' });

export function SyncProvider({
  slug,
  userId,
  mode,
  children,
}: {
  slug: string;
  userId: string;
  /** The instance's setting; undefined until the config has loaded. */
  mode: OfflineSyncMode | undefined;
  children: ReactNode;
}) {
  const enabled = useKeepsCopy(mode);
  const [value, setValue] = useState<SyncContext>({ status: 'off' });

  useEffect(() => {
    if (!enabled) {
      setValue({ status: 'off' });
      return;
    }
    let session: SyncSession | null = null;
    let cancelled = false;
    setValue({ status: 'starting' });
    startSync(slug, userId, () => {
      session = null;
      if (!cancelled) setValue({ status: 'off' });
    })
      .then((s) => {
        if (cancelled) s.stop();
        else {
          session = s;
          setValue({ status: 'on', engine: s.engine });
        }
      })
      .catch((err) => {
        console.warn('Sync unavailable:', err);
        if (!cancelled) setValue({ status: 'off' });
      });
    return () => {
      cancelled = true;
      session?.stop();
    };
  }, [enabled, slug, userId]);

  // Turned off on this device, or by the instance: no copy should stay behind.
  const known = !!mode;
  useEffect(() => {
    if (known && !enabled) void deleteLocalCopies(userId);
  }, [known, enabled, userId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSync = () => useContext(Ctx);

/** The engine when this workspace has a local copy: changes then go through its outbox. */
export function useSyncEngine(): Engine | null {
  const sync = useSync();
  return sync.status === 'on' ? sync.engine : null;
}

const noSubscribe = () => () => {};

const subscribeNetwork = (fn: () => void) => {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
};

/** Whether the server can be reached: the browser is online and (with a copy) the last request got through. */
export function useOnline() {
  const browser = useSyncExternalStore(subscribeNetwork, () => navigator.onLine);
  const state = useSyncState();
  return browser && (state ? state.online : true);
}

/** The engine's state, re-rendering on every change (null without a copy). */
export function useSyncState(): SyncState | null {
  const sync = useSync();
  const engine = sync.status === 'on' ? sync.engine : null;
  return useSyncExternalStore(engine ? engine.subscribe : noSubscribe, () =>
    engine ? engine.getState() : null,
  );
}

/**
 * Issues matching `filter` from the copy: undefined when the copy can't answer (no copy yet, or
 * a filter it can't run), so the caller asks the server.
 */
/** `day` is only there to match again when it changes, for filters on relative dates. */
export function useLocalIssues(filter: IssueFilter, userId: string, day?: string) {
  const sync = useSync();
  const state = useSyncState();
  const key = JSON.stringify(filter);
  const local = matchesLocally(filter);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new day matches relative dates anew
  const issues = useMemo(() => {
    if (!state?.ready || !local) return undefined;
    const types = new Map(
      (state.bootstrap?.teams ?? []).flatMap((t) => t.states).map((s) => [s.id, s.type]),
    );
    const ctx = { userId, stateType: (id: string) => types.get(id) };
    const wanted = JSON.parse(key) as IssueFilter;
    const out: Issue[] = [];
    for (const issue of state.issues.values()) if (matchIssue(issue, wanted, ctx)) out.push(issue);
    return out;
  }, [state, local, key, userId, day]);
  return {
    issues,
    /** Wait a moment: the copy is opening and may have the answer. */
    waiting: local && sync.status === 'starting',
  };
}
