import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs } from '../src/db/schema.ts';
import { enqueue, JobQueue, Leases } from '../src/lib/jobs/index.ts';
import { testApp } from './helpers.ts';

let app: FastifyInstance;

beforeAll(async () => {
  app = await testApp();
  await app.db.delete(jobs);
});
afterAll(() => app.close());

const queue = () => new JobQueue(app.db, app.sql, app.log);

describe('job queue', () => {
  it('only keeps jobs whose transaction committed', async () => {
    await app.db
      .transaction(async (tx) => {
        await enqueue(tx, 'test.never', {});
        throw new Error('rollback');
      })
      .catch(() => {});
    const rows = await app.db.select().from(jobs).where(eq(jobs.name, 'test.never'));
    expect(rows).toHaveLength(0);
  });

  it('runs jobs and deletes them; dedupe keys make enqueueing idempotent', async () => {
    const q = queue();
    const seen: number[] = [];
    q.define<{ n: number }>('test.run', async ({ n }) => {
      seen.push(n);
    });
    await enqueue(app.db, 'test.run', { n: 1 }, { dedupeKey: 'once' });
    await enqueue(app.db, 'test.run', { n: 2 }, { dedupeKey: 'once' });
    await q.drain();
    expect(seen).toEqual([1]);
    expect(await app.db.select().from(jobs).where(eq(jobs.name, 'test.run'))).toHaveLength(0);
  });

  it('retries with backoff and ends up dead', async () => {
    const q = queue();
    let calls = 0;
    q.define('test.fail', async () => {
      calls++;
      throw new Error('boom');
    });
    await enqueue(app.db, 'test.fail', {}, { maxAttempts: 2 });
    await q.drain();
    const [after1] = await app.db.select().from(jobs).where(eq(jobs.name, 'test.fail'));
    expect(after1).toMatchObject({ status: 'pending', attempts: 1 });
    expect(new Date(after1!.runAt).getTime()).toBeGreaterThan(Date.now());
    // Skip the backoff wait.
    await app.db.update(jobs).set({ runAt: sql`now()` }).where(eq(jobs.name, 'test.fail'));
    await q.drain();
    const [after2] = await app.db.select().from(jobs).where(eq(jobs.name, 'test.fail'));
    expect(after2).toMatchObject({ status: 'dead', attempts: 2 });
    expect(after2!.lastError).toContain('boom');
    expect(calls).toBe(2);
  });

  it('runs jobs with the same ordering key one at a time, in order', async () => {
    const q = queue();
    const order: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    q.define<{ n: number }>('test.ordered', async ({ n }) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      concurrent--;
    });
    for (let n = 1; n <= 5; n++)
      await enqueue(app.db, 'test.ordered', { n }, { orderingKey: 'ws-1' });
    await Promise.all([q.drain(), q.drain(), q.drain()]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(maxConcurrent).toBe(1);
  });

  it('never runs a job twice when workers race', async () => {
    const a = queue();
    const b = queue();
    const runs = new Map<number, number>();
    for (const q of [a, b]) {
      q.define<{ n: number }>('test.race', async ({ n }) => {
        runs.set(n, (runs.get(n) ?? 0) + 1);
      });
    }
    for (let n = 0; n < 30; n++) await enqueue(app.db, 'test.race', { n });
    await Promise.all([a.drain(), b.drain(), a.drain(), b.drain()]);
    expect(runs.size).toBe(30);
    expect([...runs.values()].every((c) => c === 1)).toBe(true);
  });

  it('keeps a long job locked so no other worker picks it up', async () => {
    const a = queue();
    const b = queue();
    a.renewMs = 20;
    let runs = 0;
    let release!: () => void;
    const started = new Promise<number>((resolve) => {
      a.define('test.long', async (_p, job) => {
        runs++;
        resolve(job.jobId);
        await new Promise<void>((r) => {
          release = r;
        });
      });
    });
    b.define('test.long', async () => {
      runs++;
    });
    await enqueue(app.db, 'test.long', {});
    const running = a.drain();
    const id = await started;
    // The visibility window runs out mid-job (as it would for an export that takes minutes)…
    await app.db
      .update(jobs)
      .set({ lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, id));
    await new Promise((r) => setTimeout(r, 100));
    // …but the running worker has pushed it forward again, so the other one finds nothing.
    await b.drain();
    release();
    await running;
    expect(runs).toBe(1);
    expect(await app.db.select().from(jobs).where(eq(jobs.id, id))).toHaveLength(0);
  });

  it('runs a schedule once per interval across instances', async () => {
    const a = queue();
    const b = queue();
    let runs = 0;
    for (const q of [a, b]) {
      q.define('test.tick', async () => {
        runs++;
      });
      q.every('test.tick', 3600);
    }
    await a.drain();
    await b.drain();
    await a.drain();
    expect(runs).toBe(1);
  });
});

describe('leases', () => {
  it('gives singleton work to one holder and fences takeovers', async () => {
    const a = new Leases(app.db, 'instance-a');
    const b = new Leases(app.db, 'instance-b');
    const first = await a.acquire('connector:test', 60);
    expect(first).not.toBeNull();
    expect(await b.acquire('connector:test', 60)).toBeNull();
    expect(await a.acquire('connector:test', 60)).toBe(first); // renewal keeps the token
    await app.db.execute(
      sql`update leases set expires_at = now() - interval '1 second' where key = 'connector:test'`,
    );
    const taken = await b.acquire('connector:test', 60);
    expect(taken).toBe(first! + 1);
    expect(await a.acquire('connector:test', 60)).toBeNull();
  });
});
