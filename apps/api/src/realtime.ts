import type { RealtimeEvent } from '@ordo/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import { type Access, canReadTeam } from './services/access.ts';

const CHANNEL = 'ordo_events';
/** Postgres NOTIFY payloads are capped at 8000 bytes; stay well below. */
const MAX_PAYLOAD = 7000;

interface Client {
  userId: string;
  workspaceId: string;
  /** Updated by `refresh` when memberships change, so events for hidden teams are dropped. */
  access: Access;
  send: (data: string) => void;
  /** Re-checks membership and access; called after team or member changes in the workspace. */
  refresh?: () => void;
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
    // Membership or team changes can change what each client may see.
    const recheck = e.kind === 'team' || e.kind === 'member';
    for (const c of set) {
      if (recheck) c.refresh?.();
      if (e.userId && c.userId !== e.userId) continue;
      // Events about a team the client can't read are dropped. When someone gains access, the
      // accompanying `member` event (which has no team) tells their client to refetch.
      let out = data;
      if (e.teamId && !canReadTeam(c.access, e.teamId)) {
        // An issue that moved somewhere they can't follow is gone, as far as they're concerned.
        if (!e.prevTeamId || !canReadTeam(c.access, e.prevTeamId)) continue;
        out = JSON.stringify({
          ...e,
          action: 'deleted',
          teamId: e.prevTeamId,
          prevTeamId: undefined,
        });
      }
      try {
        c.send(out);
      } catch {
        // socket closing; its close handler removes it
      }
    }
  }
}
