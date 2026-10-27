import type { RealtimeEvent } from '@ordo/shared';
import type { Engine } from '@ordo/sync';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSync } from '../sync/context.tsx';
import { keys } from './queries.ts';

export type RealtimeStatus = 'connecting' | 'live' | 'offline';

/**
 * Keeps a WebSocket open for the active workspace and turns change events into
 * React Query invalidations. Reconnects with backoff and refetches on reconnect.
 */
export function useRealtime(slug: string): RealtimeStatus {
  const qc = useQueryClient();
  const sync = useSync();
  // A ref, not a dependency: the copy opening shouldn't reconnect the socket.
  const engine = useRef<Engine | null>(null);
  engine.current = sync.status === 'on' ? sync.engine : null;
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    // Coalesce bursts (bulk edits) into one round of invalidations.
    const flush = () => {
      flushTimer = undefined;
      const kinds = pending;
      pending = new Set();
      const inv = (key: readonly unknown[]) => qc.invalidateQueries({ queryKey: key });
      if (kinds.has('issue') || kinds.has('comment')) {
        // Lists the local copy answers are disabled queries, which this leaves alone; the
        // online-only ones (trash, text search) still need it.
        inv(['ws', slug, 'issues']);
        inv(keys.issue(slug));
        inv(['ws', slug, 'history']);
        inv(['ws', slug, 'comments']);
        inv(['ws', slug, 'search']);
      }
      if (kinds.has('notification')) inv(keys.notifications(slug));
      if (kinds.has('customer') || kinds.has('issue')) inv(['ws', slug, 'customerRequests']);
      if (kinds.has('document')) {
        inv(['ws', slug, 'documents']);
        inv(['ws', slug, 'document']);
      }
      if (kinds.has('projectUpdate')) inv(['ws', slug, 'projectUpdates']);
      if (kinds.has('import')) inv(['ws', slug, 'imports']);
      if (kinds.has('export')) inv(['ws', slug, 'exports']);
      // Most entity kinds live in the bootstrap payload (and progress counts change with issues).
      const outsideBootstrap = ['comment', 'projectUpdate', 'import', 'export', 'document'];
      if ([...kinds].some((k) => !outsideBootstrap.includes(k))) inv(keys.bootstrap(slug));
      if (kinds.has('member') || kinds.has('workspace')) inv(keys.me);
    };

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${proto}://${location.host}/api/ws?workspace=${encodeURIComponent(slug)}`,
      );
      setStatus('connecting');
      socket.onopen = () => {
        if (attempt > 0) {
          qc.invalidateQueries({ queryKey: keys.ws(slug) });
          void engine.current?.sync();
        }
        attempt = 0;
        setStatus('live');
      };
      socket.onmessage = (msg) => {
        const e = JSON.parse(msg.data) as RealtimeEvent | { kind: 'hello' };
        if (e.kind === 'hello') return;
        if (e.kind === 'workspace' && e.action === 'deleted') {
          location.assign('/');
          return;
        }
        // The local copy catches up from the change log when the event is ahead of it.
        engine.current?.notify(e);
        pending.add(e.kind);
        flushTimer ??= setTimeout(flush, 60);
      };
      socket.onclose = (ev) => {
        if (closed) return;
        setStatus('offline');
        // Removed, suspended or disabled: this workspace is no longer ours to show.
        if (ev.code === 4403) {
          location.assign('/');
          return;
        }
        if (ev.code === 4401 || ev.code === 4404) return;
        attempt++;
        timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** attempt));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(flushTimer);
      socket?.close();
    };
  }, [slug, qc]);

  return status;
}
