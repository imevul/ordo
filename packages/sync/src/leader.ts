import type { Engine } from './engine.ts';

/** The part of the Web Locks API (`navigator.locks`) leading needs. */
export interface Locks {
  request(
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<void> | void,
  ): Promise<unknown>;
}

/**
 * Makes `engine` the one tab that talks to the server while it holds the lock `name`; the others
 * wait in line and take over when it lets go. Without `locks` it leads on its own. Returns the
 * function that lets go (or leaves the line), after which this engine never leads again.
 */
export function lead(engine: Engine, locks: Locks | undefined, name: string): () => void {
  if (!locks) {
    void engine.sync();
    return () => {
      engine.leader = false;
    };
  }
  const release = new AbortController();
  engine.leader = false;
  locks
    .request(name, { signal: release.signal }, () => {
      if (release.signal.aborted) return;
      engine.leader = true;
      void engine.sync();
      return new Promise<void>((resolve) =>
        release.signal.addEventListener('abort', () => resolve()),
      );
    })
    .catch(() => {
      // aborted while waiting in line
    });
  return () => {
    engine.leader = false;
    release.abort();
  };
}
