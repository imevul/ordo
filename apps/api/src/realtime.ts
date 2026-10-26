import type { RealtimeEvent } from '@ordo/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';

const CHANNEL = 'ordo_events';
/** Postgres NOTIFY payloads are capped at 8000 bytes; stay well below. */
const MAX_PAYLOAD = 7000;

interface Client {
  userId: string;
  workspaceId: string;
  send: (data: string) => void;
}

/**
 * Fans change events out to WebSocket clients. Events travel through Postgres
 * LISTEN/NOTIFY so that every API instance behind a load balancer sees every change.
 */
export class Realtime {
  private clients = new Map<string, Set<Client>>();
  private listening = false;

  constructor(
    private sql: Sql,
    private log: FastifyBaseLogger,
  ) {}

  async start() {
    try {
      await this.sql.listen(CHANNEL, (payload) => {
        try {
          for (const e of JSON.parse(payload) as RealtimeEvent[]) this.dispatch(e);
        } catch (err) {
          this.log.warn({ err }, 'bad realtime payload');
        }
      });
      this.listening = true;
    } catch (err) {
      this.log.error({ err }, 'LISTEN failed; realtime limited to this instance');
    }
  }

  publish(events: RealtimeEvent[]) {
    if (events.length === 0) return;
    if (!this.listening) {
      for (const e of events) this.dispatch(e);
      return;
    }
    let batch: RealtimeEvent[] = [];
    let size = 2;
    const flush = () => {
      if (batch.length === 0) return;
      this.sql
        .notify(CHANNEL, JSON.stringify(batch))
        .catch((err) => this.log.error({ err }, 'NOTIFY failed'));
      batch = [];
      size = 2;
    };
    for (const e of events) {
      const len = JSON.stringify(e).length + 1;
      if (size + len > MAX_PAYLOAD) flush();
      batch.push(e);
      size += len;
    }
    flush();
  }

  add(client: Client) {
    let set = this.clients.get(client.workspaceId);
    if (!set) {
      set = new Set();
      this.clients.set(client.workspaceId, set);
    }
    set.add(client);
    return () => {
      set.delete(client);
      if (set.size === 0) this.clients.delete(client.workspaceId);
    };
  }

  get connectionCount() {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }

  private dispatch(e: RealtimeEvent) {
    const set = this.clients.get(e.workspaceId);
    if (!set) return;
    const data = JSON.stringify(e);
    for (const c of set) {
      if (e.userId && c.userId !== e.userId) continue;
      try {
        c.send(data);
      } catch {
        // socket closing; its close handler removes it
      }
    }
  }
}
