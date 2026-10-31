import { randomUUID } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import type { Db, DbOrTx } from '../../db/client.ts';
import { jobs, leases, schedules } from '../../db/schema.ts';

/**
 * A Postgres-backed job queue (no extra infrastructure).
 *
 * - `enqueue` inserts inside the caller's transaction, so jobs exist only if the change committed,
 *   and `pg_notify('ordo_jobs')` (delivered on commit) wakes idle workers.
 * - Workers claim with a short `UPDATE … FOR UPDATE SKIP LOCKED` and run handlers outside any
 *   transaction. A crashed worker's jobs become claimable again when `locked_until` passes.
 * - Jobs with the same `orderingKey` run one at a time, oldest first.
 * - `dedupeKey` makes enqueueing idempotent (webhook delivery ids, scheduled ticks).
 * - Failures retry with exponential backoff, then end up `dead` for an admin to inspect. A lock that
 *   ran out (the worker crashed, maybe because of the job) used up its attempt too, so a job that
 *   keeps killing the process ends up dead instead of crashing an instance every few minutes.
 */

const CHANNEL = 'ordo_jobs';
const VISIBILITY_SECONDS = 300;
const POLL_MS = 5_000;
const SCHEDULE_TICK_MS = 15_000;
const LAPSED_ERROR = 'The worker running it stopped responding on its last attempt';

export interface JobContext {
  attempt: number;
  /** The last attempt; a handler that fails on it ends up dead. */
  maxAttempts: number;
  jobId: number;
  log: FastifyBaseLogger;
}

export type JobHandler<P = unknown> = (payload: P, ctx: JobContext) => Promise<void>;

/** Called once a job has given up, with the last error, to record the failure where people see it. */
export type DeadHandler<P = unknown> = (payload: P, error: string) => Promise<void>;

interface Definition {
  handler: JobHandler<never>;
  maxAttempts: number;
  onDead?: DeadHandler<never>;
}

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  orderingKey?: string;
  maxAttempts?: number;
  /**
   * Remember `dedupeKey` after the job is done (in `job_keys`), so the job is queued at most once
   * even when whatever queues it runs again: a retried job queueing work for each event.
   */
  once?: boolean;
}

export async function enqueue(
  db: DbOrTx,
  name: string,
  payload: unknown = {},
  opts: EnqueueOptions = {},
) {
  if (opts.once && opts.dedupeKey) {
    // One statement, so the key and the job go in together even outside a transaction.
    await db.execute(sql`
      with claimed as (
        insert into job_keys (key) values (${opts.dedupeKey})
        on conflict do nothing
        returning key
      )
      insert into jobs (name, payload, run_at, dedupe_key, ordering_key, max_attempts)
      select ${name}, ${JSON.stringify(payload ?? {})}::jsonb, ${(opts.runAt ?? new Date()).toISOString()},
        key, ${opts.orderingKey ?? null}, ${opts.maxAttempts ?? 8}
      from claimed
      on conflict do nothing`);
    await db.execute(sql`select pg_notify(${CHANNEL}, '')`);
    return;
  }
  await db
    .insert(jobs)
    .values({
      name,
      payload: payload ?? {},
      runAt: (opts.runAt ?? new Date()).toISOString(),
      dedupeKey: opts.dedupeKey ?? null,
      orderingKey: opts.orderingKey ?? null,
      maxAttempts: opts.maxAttempts ?? 8,
    })
    .onConflictDoNothing();
  await db.execute(sql`select pg_notify(${CHANNEL}, '')`);
}

const backoff = (attempt: number) => Math.min(3600, 5 * 2 ** (attempt - 1));

export class JobQueue {
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private defs = new Map<string, Definition>();
  private recurring = new Map<string, number>();
  private running = 0;
  private stopped = true;
  private wake: (() => void) | null = null;
  private loops: Promise<void>[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  /** How often a running job's lock is pushed forward; well inside the visibility window. */
  renewMs = (VISIBILITY_SECONDS / 3) * 1000;

  constructor(
    private db: Db,
    private sql: Sql,
    private log: FastifyBaseLogger,
    private concurrency = 4,
  ) {}

  define<P>(
    name: string,
    handler: JobHandler<P>,
    opts: { maxAttempts?: number; onDead?: DeadHandler<P> } = {},
  ) {
    this.defs.set(name, {
      handler: handler as JobHandler<never>,
      maxAttempts: opts.maxAttempts ?? 8,
      onDead: opts.onDead as DeadHandler<never> | undefined,
    });
  }

  /** Runs `name` every `intervalSeconds` across all instances (at most one run per interval). */
  every(name: string, intervalSeconds: number) {
    this.recurring.set(name, intervalSeconds);
  }

  async start() {
    this.stopped = false;
    await this.syncSchedules();
    try {
      await this.sql.listen(CHANNEL, () => this.wake?.());
    } catch (err) {
      this.log.warn({ err }, 'LISTEN ordo_jobs failed; falling back to polling');
    }
    for (let i = 0; i < this.concurrency; i++) this.loops.push(this.loop());
    this.timers.push(
      setInterval(
        () => this.tickSchedules().catch((err) => this.log.error({ err }, 'schedules')),
        SCHEDULE_TICK_MS,
      ),
    );
  }

  /** Stops claiming new jobs and waits for running ones to finish. */
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.wake?.();
    await Promise.all(this.loops);
  }

  /** Runs every runnable job (and due schedules) until none are left. For tests and the CLI. */
  async drain(maxRounds = 100) {
    await this.syncSchedules();
    await this.tickSchedules();
    for (let i = 0; i < maxRounds; i++) {
      const claimed = await this.claim(10);
      if (claimed.length === 0) return;
      await Promise.all(claimed.map((j) => this.execute(j)));
    }
  }

  /** Jobs this instance is running right now. */
  get active() {
    return this.running;
  }

  async stats() {
    const rows = await this.db.execute<{ status: string; n: number }>(
      sql`select status, count(*)::int as n from jobs group by status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  }

  private async loop() {
    while (!this.stopped) {
      const [job] = await this.claim(1).catch((err) => {
        this.log.error({ err }, 'claiming jobs failed');
        return [];
      });
      if (job) {
        await this.execute(job);
        continue;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, POLL_MS);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  private async claim(limit: number) {
    const names = [...this.defs.keys()];
    if (names.length === 0) return [];
    await this.buryLapsed(names);
    return this.db.execute<typeof jobs.$inferSelect & { max_attempts: number }>(sql`
      update jobs set
        status = 'running',
        attempts = attempts + 1,
        locked_until = now() + make_interval(secs => ${VISIBILITY_SECONDS}),
        locked_by = ${this.workerId}
      where id in (
        select j.id from jobs j
        where j.name in (${sql.join(
          names.map((n) => sql`${n}`),
          sql`, `,
        )})
          and (
            (j.status = 'pending' and j.run_at <= now())
            or (j.status = 'running' and j.locked_until < now() and j.attempts < j.max_attempts)
          )
          and (
            j.ordering_key is null
            or j.id = (
              select min(o.id) from jobs o
              where o.ordering_key = j.ordering_key and o.status in ('pending', 'running')
            )
          )
        order by j.run_at, j.id
        limit ${limit}
        for update skip locked
      )
      returning id, name, payload, attempts, max_attempts`);
  }

  /**
   * Jobs whose lock ran out on their last attempt: the worker stopped without recording an outcome,
   * quite possibly because of the job itself (an export running out of memory). Another try would
   * only crash the next instance, so they're dead. Scheduled ticks are the exception: they were most
   * likely cut off by a restart, and the next tick does the same work, so they're simply dropped.
   */
  private async buryLapsed(names: string[]) {
    const nameList = sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    );
    await this.db.execute(sql`
      delete from jobs
      where id in (
        select j.id from jobs j
        where j.name in (${nameList})
          and j.dedupe_key like 'schedule:%'
          and j.status = 'running' and j.locked_until < now() and j.attempts >= j.max_attempts
        for update skip locked
      )`);
    const dead = await this.db.execute<{ id: number; name: string; payload: unknown }>(sql`
      update jobs set
        status = 'dead',
        last_error = ${LAPSED_ERROR},
        locked_until = null,
        locked_by = null
      where id in (
        select j.id from jobs j
        where j.name in (${nameList})
          and j.status = 'running' and j.locked_until < now() and j.attempts >= j.max_attempts
        for update skip locked
      )
      returning id, name, payload`);
    for (const job of dead) {
      this.log.error({ job: job.name, jobId: job.id }, 'job died: its worker stopped responding');
      await this.notifyDead(job.name, job.payload, LAPSED_ERROR);
    }
  }

  private async notifyDead(name: string, payload: unknown, error: string) {
    const onDead = this.defs.get(name)?.onDead;
    if (!onDead) return;
    await onDead(payload as never, error).catch((err) =>
      this.log.error({ err, job: name }, 'onDead handler failed'),
    );
  }

  private async execute(job: {
    id: number;
    name: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  }) {
    const def = this.defs.get(job.name);
    if (!def) return;
    this.running++;
    // A job that runs longer than its visibility window (a big export) would otherwise be claimed
    // again by another worker while it's still running. Keep the lock fresh until it finishes.
    const renew = setInterval(() => {
      this.renewLock(job.id).catch((err) => this.log.warn({ err, job: job.name }, 'renew lock'));
    }, this.renewMs);
    try {
      await def.handler(job.payload as never, {
        attempt: job.attempts,
        maxAttempts: job.max_attempts,
        jobId: job.id,
        log: this.log,
      });
      await this.db.delete(jobs).where(eq(jobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const dead = job.attempts >= job.max_attempts;
      this.log[dead ? 'error' : 'warn'](
        { err, job: job.name, attempt: job.attempts },
        dead ? 'job died' : 'job failed; will retry',
      );
      await this.db
        .update(jobs)
        .set({
          status: dead ? 'dead' : 'pending',
          lastError: message.slice(0, 4000),
          lockedUntil: null,
          lockedBy: null,
          runAt: new Date(Date.now() + backoff(job.attempts) * 1000).toISOString(),
        })
        .where(eq(jobs.id, job.id));
      if (dead) await this.notifyDead(job.name, job.payload, message);
    } finally {
      clearInterval(renew);
      this.running--;
    }
  }

  private async renewLock(jobId: number) {
    await this.db.execute(sql`
      update jobs set locked_until = now() + make_interval(secs => ${VISIBILITY_SECONDS})
      where id = ${jobId} and status = 'running' and locked_by = ${this.workerId}`);
  }

  private async syncSchedules() {
    for (const [name, interval] of this.recurring) {
      await this.db
        .insert(schedules)
        .values({ name, intervalSeconds: interval, nextRunAt: new Date().toISOString() })
        .onConflictDoUpdate({ target: schedules.name, set: { intervalSeconds: interval } });
    }
  }

  /** Advances each due schedule; the instance whose UPDATE wins enqueues that run. */
  private async tickSchedules() {
    if (this.recurring.size === 0) return;
    const due = await this.db.execute<{ name: string; next_run_at: string }>(sql`
      update schedules set
        last_run_at = now(),
        next_run_at = now() + make_interval(secs => interval_seconds)
      where next_run_at <= now() and name in (${sql.join(
        [...this.recurring.keys()].map((n) => sql`${n}`),
        sql`, `,
      )})
      returning name, next_run_at`);
    for (const row of due) {
      await enqueue(
        this.db,
        row.name,
        {},
        { dedupeKey: `schedule:${row.name}:${row.next_run_at}`, maxAttempts: 1 },
      );
    }
  }
}

/**
 * Leases keep singleton work (a long-lived bot connection) on one instance. The holder renews
 * before `ttlSeconds` runs out; if it dies, another instance takes over and `fencing` increases.
 */
export class Leases {
  constructor(
    private db: Db,
    readonly holder: string,
  ) {}

  /** Returns the fencing token when acquired (or already held), null when someone else holds it. */
  async acquire(key: string, ttlSeconds: number): Promise<number | null> {
    const rows = await this.db.execute<{ fencing: number }>(sql`
      insert into leases (key, holder, fencing, expires_at)
      values (${key}, ${this.holder}, 1, now() + make_interval(secs => ${ttlSeconds}))
      on conflict (key) do update set
        holder = excluded.holder,
        fencing = case when leases.holder = excluded.holder then leases.fencing else leases.fencing + 1 end,
        expires_at = excluded.expires_at
      where leases.holder = excluded.holder or leases.expires_at < now()
      returning fencing`);
    return rows[0]?.fencing ?? null;
  }

  async release(key: string) {
    await this.db.delete(leases).where(and(eq(leases.key, key), eq(leases.holder, this.holder)));
  }

  async list() {
    return this.db.select().from(leases).where(lt(sql`now()`, leases.expiresAt));
  }
}
