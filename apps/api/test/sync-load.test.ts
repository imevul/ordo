import type { Bootstrap, Issue } from '@ordo/shared';
import { Engine, type Transport } from '@ordo/sync/engine';
import { matchIssue } from '@ordo/sync/match';
import { MemoryStore } from '@ordo/sync/store';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

/**
 * How the sync engine copes with a big workspace: 50,000 issues loaded, filtered and kept up to
 * date. Slow, so it runs only with ORDO_BENCH=1; it prints its timings.
 */

const N = 50_000;
let app: FastifyInstance;
let owner: Client;
let me: string;
let boot: Bootstrap;
const slug = `load-${Date.now()}`;
const ws = `/api/w/${slug}`;

const time = async <T>(label: string, fn: () => Promise<T> | T) => {
  const start = performance.now();
  const result = await fn();
  console.log(`${label}: ${Math.round(performance.now() - start)} ms`);
  return result;
};

describe.skipIf(!process.env.ORDO_BENCH)('a 50,000-issue workspace', { timeout: 600_000 }, () => {
  beforeAll(async () => {
    app = await testApp();
    owner = (await signup(app, 'Load Owner')).client;
    me = (await owner.get('/api/auth/me')).data.id;
    await owner.post('/api/workspaces', { name: 'Load', slug, teamName: 'Core', teamKey: 'LOD' });
    boot = (await owner.get(`${ws}/bootstrap`)).data;
    const team = boot.teams[0]!;
    const states = team.states.map((s) => s.id);
    await time(`seeding ${N} issues`, () =>
      app.db.execute(sql`
        insert into issues (workspace_id, team_id, number, title, description, state_id, priority,
                            assignee_id, creator_id, sort_order)
        select ${boot.workspace.id}, ${team.id}, g, 'Load issue ' || g, repeat('words ', 40),
               (${sql.raw(`array[${states.map((s) => `'${s}'::uuid`).join(',')}]`)})[1 + g % ${states.length}],
               g % 5, case when g % 3 = 0 then ${me}::uuid end, ${me}, g
        from generate_series(1, ${N}) g`),
    );
    await app.db.execute(sql`update teams set issue_counter = ${N} where id = ${team.id}`);
    // As autovacuum would soon after a bulk load.
    await app.db.execute(sql`analyze issues`);
  });
  afterAll(() => app.close());

  const transport: Transport = {
    snapshot: async () => (await owner.get(`${ws}/sync/snapshot`)).data,
    issues: async (after, limit) => (await owner.post(`${ws}/sync/issues`, { after, limit })).data,
    changes: async (since, epoch) =>
      (await owner.get(`${ws}/sync/changes?since=${since}&epoch=${epoch}`)).data,
    comments: async () => [],
    send: async (op) => {
      if (op.kind !== 'issue.update') throw new Error('not in this benchmark');
      return (await owner.patch(`${ws}/issues/${op.ids[0]}`, op.patch)).data;
    },
  };

  it('pages issues on the server', async () => {
    const { computeAccess } = await import('../src/services/access.ts');
    const { queryIssuePage } = await import('../src/services/issues.ts');
    const access = await computeAccess(app.db, me, boot.workspace.id, 'owner');
    await time('one page of 1,000, query only', () =>
      queryIssuePage(app.db, access, {}, null, 1000),
    );
    const last = (await queryIssuePage(app.db, access, {}, null, 1000)).at(-1)!.id;
    await time('a later page of 1,000, query only', () =>
      queryIssuePage(app.db, access, {}, last, 1000),
    );
    await time('one page of 1,000 over HTTP', () =>
      owner.post(`${ws}/sync/issues`, { after: last, limit: 1000 }),
    );
  });

  it('loads, filters and follows changes in reasonable time', async () => {
    const engine = new Engine({ userId: me, transport, store: new MemoryStore(), pageSize: 1000 });
    await time('full load (snapshot + 50 pages of 1,000)', () => engine.sync());
    const issues = engine.getState().issues;
    expect(issues.size).toBe(N);

    const types = new Map(boot.teams.flatMap((t) => t.states).map((s) => [s.id, s.type]));
    const ctx = { userId: me, stateType: (id: string) => types.get(id) };
    const mine = await time('filter: my open issues', () => {
      const out: Issue[] = [];
      for (const i of issues.values())
        if (matchIssue(i, { assigneeIds: ['me'], stateTypes: ['unstarted', 'started'] }, ctx))
          out.push(i);
      return out;
    });
    expect(mine.length).toBeGreaterThan(0);

    const some = [...issues.keys()].slice(0, 100);
    for (const id of some) await owner.patch(`${ws}/issues/${id}`, { priority: 1 });
    await time('catch up on 100 changes', () => engine.sync());
    expect(engine.issue(some[0]!)!.priority).toBe(1);

    await time('one local change, shown', () =>
      engine.mutate({ kind: 'issue.update', ids: [some[1]!], patch: { title: 'Edited' } }),
    );
    expect(engine.issue(some[1]!)!.title).toBe('Edited');
  });
});
