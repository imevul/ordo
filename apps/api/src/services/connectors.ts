import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { integrations } from '../db/schema.ts';
import { getProvider, listProviders } from '../integrations/registry.ts';
import type { IntegrationProvider, IntegrationRow } from '../integrations/types.ts';
import type { Leases } from '../lib/jobs/index.ts';
import { integrationContext, queueInbound } from './integrations.ts';

const LEASE_SECONDS = 45;
const TICK_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface Running {
  abort: AbortController;
  done: Promise<void>;
  /** The integration's `updatedAt` when started: new settings mean a fresh connection. */
  version: string;
}

/**
 * Long-lived connections (Slack Socket Mode, the Discord gateway, Telegram and Matrix long polls)
 * for instances the outside world can't reach. Each runs on exactly one server: every tick, each
 * server tries to take or renew a lease per connection, starts what it holds and stops what it
 * lost. Deliveries go through the same queue as webhooks (with the same idempotency keys), so a
 * brief overlap during a takeover can't process anything twice.
 */
export class Connectors {
  private running = new Map<string, Running>();
  private failures = new Map<string, { count: number; retryAt: number }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private app: FastifyInstance,
    private leases: Leases,
  ) {}

  start() {
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.halt(id)));
  }

  /** Connections this server is running (for health checks and tests). */
  get active() {
    return [...this.running.keys()];
  }

  /** One reconciliation round. Safe to call directly (tests do). */
  tick(): Promise<void> {
    this.ticking ??= this.reconcile()
      .catch((err) => this.app.log.error({ err }, 'connector supervision failed'))
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async reconcile() {
    if (this.stopped) return;
    const connectable = listProviders().filter((p) => p.connect);
    const rows = connectable.length
      ? await this.app.db
          .select()
          .from(integrations)
          .where(
            and(
              inArray(
                integrations.provider,
                connectable.map((p) => p.key),
              ),
              ne(integrations.status, 'disabled'),
            ),
          )
      : [];
    const wanted = new Map<string, { row: IntegrationRow; provider: IntegrationProvider }>();
    for (const row of rows) {
      const provider = getProvider(row.provider)!;
      if (provider.wantsConnection?.(row) ?? true) wanted.set(row.id, { row, provider });
    }

    for (const [id, run] of this.running) {
      const want = wanted.get(id);
      if (!want || want.row.updatedAt !== run.version) await this.halt(id);
    }

    for (const [id, { row, provider }] of wanted) {
      const fencing = await this.leases.acquire(leaseKey(id), LEASE_SECONDS);
      if (fencing === null) {
        // Someone else holds it (or took it over while we were slow to renew).
        if (this.running.has(id)) await this.halt(id, false);
        continue;
      }
      if (this.running.has(id)) continue;
      const failure = this.failures.get(id);
      if (failure && Date.now() < failure.retryAt) continue;
      this.launch(row, provider);
    }
  }

  private launch(row: IntegrationRow, provider: IntegrationProvider) {
    const abort = new AbortController();
    const ictx = integrationContext(this.app, row);
    const started = Date.now();
    const log = ictx.log;
    const done = provider.connect!(ictx, {
      signal: abort.signal,
      deliver: (req) => queueInbound(this.app, provider, row, req),
      connected: async () => {
        await this.app.db
          .update(integrations)
          .set({ status: 'active', lastError: null })
          .where(and(eq(integrations.id, row.id), eq(integrations.status, 'error')));
      },
    })
      .then(
        () => {
          if (abort.signal.aborted) return;
          log.info('connection ended; reconnecting');
          this.backoff(row.id, started, null);
        },
        async (err: unknown) => {
          if (abort.signal.aborted) return;
          log.warn({ err }, 'connection failed');
          this.backoff(row.id, started, err);
          await this.app.db
            .update(integrations)
            .set({
              status: 'error',
              lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
            })
            .where(and(eq(integrations.id, row.id), ne(integrations.status, 'disabled')));
        },
      )
      .finally(() => {
        if (this.running.get(row.id)?.abort === abort) this.running.delete(row.id);
      });
    this.running.set(row.id, { abort, done, version: row.updatedAt });
  }

  /** Quick retries for a connection that ran a while; exponential backoff for one that keeps failing. */
  private backoff(id: string, started: number, err: unknown) {
    const healthy = Date.now() - started > 60_000;
    const count = healthy ? 0 : (this.failures.get(id)?.count ?? 0) + 1;
    const delay = err || count ? Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** count) : 1_000;
    this.failures.set(id, { count, retryAt: Date.now() + delay });
  }

  private async halt(id: string, release = true) {
    const run = this.running.get(id);
    if (!run) return;
    run.abort.abort();
    this.running.delete(id);
    this.failures.delete(id);
    await run.done.catch(() => {});
    if (release) await this.leases.release(leaseKey(id));
  }
}

const leaseKey = (integrationId: string) => `connector:${integrationId}`;

/**
 * A pause that ends early when the connection is stopped. Resolves false if aborted, so loops
 * can `while (await sleep(ms, signal))`.
 */
export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
