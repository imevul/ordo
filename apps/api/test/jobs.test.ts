import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachments, files, jobs, sessions, users, workspaces } from '../src/db/schema.ts';
import { runMaintenance } from '../src/jobs.ts';
import { enqueue, JobQueue, Leases } from '../src/lib/jobs/index.ts';
import { signup, testApp } from './helpers.ts';

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

  it('counts a lapsed lock as an attempt and buries a job that keeps killing its worker', async () => {
    const q = queue();
    let calls = 0;
    const dead: [unknown, string][] = [];
    q.define<{ n: number }>(
      'test.crash',
      async () => {
        calls++;
      },
      { onDead: async (p, error) => void dead.push([p, error]) },
    );
    await enqueue(app.db, 'test.crash', { n: 7 }, { maxAttempts: 2 });
    // As if a worker had claimed it and then died (out of memory) mid-job.
    const crash = (attempts: number) =>
      app.db
        .update(jobs)
        .set({ status: 'running', attempts, lockedUntil: sql`now() - interval '1 second'` })
        .where(eq(jobs.name, 'test.crash'));
    await crash(1);
    // One attempt left: it's taken again, and that counts.
    await q.drain();
    expect(calls).toBe(1);
    expect(await app.db.select().from(jobs).where(eq(jobs.name, 'test.crash'))).toHaveLength(0);

    await enqueue(app.db, 'test.crash', { n: 8 }, { maxAttempts: 2 });
    await crash(2);
    await q.drain();
    expect(calls).toBe(1);
    const [row] = await app.db.select().from(jobs).where(eq(jobs.name, 'test.crash'));
    expect(row).toMatchObject({ status: 'dead', attempts: 2, lockedUntil: null });
    expect(row!.lastError).toContain('stopped responding');
    expect(dead).toEqual([[{ n: 8 }, row!.lastError]]);
    await app.db.delete(jobs).where(eq(jobs.name, 'test.crash'));
  });

  it('tells the handler when a job dies after failing', async () => {
    const q = queue();
    const dead: string[] = [];
    q.define(
      'test.doomed',
      async () => {
        throw new Error('boom');
      },
      { onDead: async (_p, error) => void dead.push(error) },
    );
    await enqueue(app.db, 'test.doomed', {}, { maxAttempts: 1 });
    await q.drain();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain('boom');
    await app.db.delete(jobs).where(eq(jobs.name, 'test.doomed'));
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

describe('maintenance', () => {
  it('runs every cleanup step even when one of them fails', async () => {
    const { client, email } = await signup(app, 'Maya Maintenance');
    const slug = `maint-${Date.now()}`;
    await client.post('/api/workspaces', { name: 'Maint', slug, teamName: 'Ops', teamKey: 'OPS' });
    const [user] = await app.db.select().from(users).where(eq(users.email, email));
    const [ws] = await app.db.select().from(workspaces).where(eq(workspaces.slug, slug));
    await app.db.insert(sessions).values({
      id: `expired-${Date.now()}`,
      userId: user!.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    // An abandoned upload whose removal breaks the attachment sweep, which runs before session
    // expiry. The trigger only fires for that row, so tests running alongside aren't affected.
    const [file] = await app.db
      .insert(files)
      .values({
        workspaceId: ws!.id,
        kind: 'attachment',
        storageKey: `maint-${Date.now()}`,
        filename: 'x.txt',
        contentType: 'text/plain',
        size: 1,
      })
      .returning();
    const [orphan] = await app.db
      .insert(attachments)
      .values({
        workspaceId: ws!.id,
        fileId: file!.id,
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      })
      .returning();
    await app.db.execute(
      sql.raw(`create function broken_sweep() returns trigger language plpgsql as $$
        begin raise exception 'injected failure'; end $$;
        create trigger broken_sweep before delete on attachments
          for each row when (old.id = '${orphan!.id}') execute function broken_sweep();`),
    );
    try {
      expect(await runMaintenance(app)).toBe(1);
    } finally {
      await app.db.execute(
        sql.raw('drop trigger broken_sweep on attachments; drop function broken_sweep();'),
      );
    }
    const left = await app.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, user!.id), lt(sessions.expiresAt, sql`now()`)));
    expect(left).toHaveLength(0);
    await app.db.delete(files).where(eq(files.id, file!.id));
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
