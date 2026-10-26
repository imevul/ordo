/**
 * Seeds a "demo" workspace with teams, people, labels, projects, cycles and issues.
 * Idempotent: does nothing if the workspace already exists.
 *
 *   pnpm db:seed            (dev)    → sign in as demo@ordo.test / ordo-demo-password
 *   make seed               (docker)
 */
import type { RealtimeEvent } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../env.ts';
import { hashPassword } from '../lib/crypto.ts';
import { systemAccess } from '../services/access.ts';
import type { Ctx } from '../services/context.ts';
import { createIssue, updateIssue } from '../services/issues.ts';
import { createTeam } from '../services/teams.ts';
import { createDb } from './client.ts';
import { runMigrations } from './migrate.ts';
import {
  comments,
  cycles,
  labels,
  projects,
  projectTeams,
  projectUpdates,
  teamMembers,
  teams,
  users,
  workflowStates,
  workspaceMembers,
  workspaces,
} from './schema.ts';

const PASSWORD = process.env.SEED_PASSWORD ?? 'ordo-demo-password';
const PEOPLE = [
  { name: 'Demo Admin', email: 'demo@ordo.test', color: '#ff1493' },
  { name: 'Grace Hopper', email: 'grace@ordo.test', color: '#2de2e6' },
  { name: 'Alan Turing', email: 'alan@ordo.test', color: '#22c55e' },
  { name: 'Ada Lovelace', email: 'ada@ordo.test', color: '#a78bfa' },
];

const ISSUES: [string, string, number, string, string[]][] = [
  // title, state name, priority, team key, labels
  ['Set up CI pipeline with caching', 'Done', 2, 'ENG', ['Infra']],
  ['Migrate auth sessions to sliding expiry', 'Done', 3, 'ENG', ['Backend']],
  ['Board view drops cards when grouping by label', 'In Progress', 1, 'ENG', ['Bug', 'Frontend']],
  [
    'Command palette: fuzzy search across projects',
    'In Progress',
    3,
    'ENG',
    ['Frontend', 'Feature'],
  ],
  ['Add webhooks for issue events', 'Todo', 2, 'ENG', ['Backend', 'Feature']],
  ['Rate-limit the public API per key', 'Todo', 2, 'ENG', ['Backend']],
  ['Postgres full-text search for issues', 'Backlog', 3, 'ENG', ['Backend', 'Feature']],
  ['GitHub integration: link PRs to issues', 'Backlog', 3, 'ENG', ['Feature']],
  ['Import from Linear CSV export', 'Backlog', 4, 'ENG', ['Feature']],
  ['Flaky test: realtime reconnect', 'In Review', 2, 'ENG', ['Bug', 'Infra']],
  ['Optimistic updates flicker on slow networks', 'Todo', 3, 'ENG', ['Bug', 'Frontend']],
  ['Document the REST API', 'In Review', 3, 'ENG', ['Docs']],
  ['Inbox: snooze notifications', 'Backlog', 0, 'ENG', ['Feature']],
  ['Dark-room contrast audit for index numerals', 'Done', 2, 'DES', ['Design']],
  ['Chamfered panel component spec', 'In Progress', 3, 'DES', ['Design']],
  ['Empty states with HUD brackets', 'Todo', 4, 'DES', ['Design']],
  ['Status icon set (square glyphs)', 'Done', 3, 'DES', ['Design']],
  ['Onboarding illustration', 'Backlog', 0, 'DES', ['Design']],
  ['Mobile navigation drawer', 'Todo', 2, 'DES', ['Design', 'Frontend']],
  ['Project health colours', 'In Review', 3, 'DES', ['Design']],
];

async function main() {
  const env = loadEnv();
  const { db, sql } = createDb(env.databaseUrl);
  await runMigrations(db);

  const [existing] = await db.select().from(workspaces).where(eq(workspaces.slug, 'demo'));
  if (existing) {
    console.log('Workspace "demo" already exists — nothing to do.');
    await sql.end();
    return;
  }

  await db.transaction(async (tx) => {
    const ids: string[] = [];
    // On an empty instance the demo admin also administers the instance.
    const emptyInstance = (await tx.select({ id: users.id }).from(users).limit(1)).length === 0;
    for (const [i, p] of PEOPLE.entries()) {
      const [found] = await tx.select({ id: users.id }).from(users).where(eq(users.email, p.email));
      if (found) {
        ids.push(found.id);
        continue;
      }
      const [u] = await tx
        .insert(users)
        .values({
          email: p.email,
          name: p.name,
          username: p.email.split('@')[0]!,
          passwordHash: await hashPassword(PASSWORD),
          avatarColor: p.color,
          isInstanceAdmin: emptyInstance && i === 0,
        })
        .returning({ id: users.id });
      ids.push(u!.id);
    }
    const [admin, grace, alan, ada] = ids as [string, string, string, string];

    const [ws] = await tx.insert(workspaces).values({ name: 'Demo', slug: 'demo' }).returning();
    await tx.insert(workspaceMembers).values(
      ids.map((userId, i) => ({
        workspaceId: ws!.id,
        userId,
        role: i === 0 ? ('owner' as const) : ('member' as const),
      })),
    );

    const events: RealtimeEvent[] = [];
    const ctx = (userId: string): Ctx => ({
      tx,
      userId,
      workspaceId: ws!.id,
      access: systemAccess(ws!.id, userId),
      events,
      domainEvents: [],
      source: 'system',
      silent: false,
      meta: null,
    });

    const eng = await createTeam(ctx(admin), { name: 'Engineering', key: 'ENG', color: '#ff1493' });
    const des = await createTeam(ctx(ada), { name: 'Design', key: 'DES', color: '#2de2e6' });
    await tx.insert(teamMembers).values([
      { teamId: eng, userId: grace },
      { teamId: eng, userId: alan },
      { teamId: des, userId: admin },
    ]);
    const teamId: Record<string, string> = { ENG: eng, DES: des };

    const labelRows = await tx
      .insert(labels)
      .values(
        [
          ['Bug', '#ef4444'],
          ['Feature', '#a78bfa'],
          ['Frontend', '#60a5fa'],
          ['Backend', '#22c55e'],
          ['Infra', '#f59e0b'],
          ['Docs', '#b8aab2'],
          ['Design', '#ff5cb8'],
        ].map(([name, color]) => ({ workspaceId: ws!.id, name: name!, color: color! })),
      )
      .returning();
    const labelId = (n: string) => labelRows.find((l) => l.name === n)!.id;

    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const shift = (days: number) => iso(new Date(today.getTime() + days * 86_400_000));
    const cycleRows = await tx
      .insert(cycles)
      .values([
        { teamId: eng, number: 1, startsAt: shift(-21), endsAt: shift(-7) },
        { teamId: eng, number: 2, startsAt: shift(-7), endsAt: shift(7) },
        { teamId: eng, number: 3, startsAt: shift(7), endsAt: shift(21) },
      ])
      .returning();
    await tx.update(teams).set({ cycleCounter: 3 }).where(eq(teams.id, eng));
    const current = cycleRows[1]!;

    const [launch, design] = await tx
      .insert(projects)
      .values([
        {
          workspaceId: ws!.id,
          name: 'Public API v1',
          status: 'started',
          leadId: grace,
          color: '#22c55e',
          targetDate: shift(30),
          startDate: shift(-14),
          description: 'Ship a documented, rate-limited REST API with personal keys and webhooks.',
        },
        {
          workspaceId: ws!.id,
          name: 'Hotline Pink rollout',
          status: 'started',
          leadId: ada,
          color: '#ff1493',
          targetDate: shift(14),
          description: 'Bring every surface onto the Hotline Pink design system.',
        },
      ])
      .returning();
    await tx.insert(projectTeams).values([
      { projectId: launch!.id, teamId: eng },
      { projectId: design!.id, teamId: des },
      { projectId: design!.id, teamId: eng },
    ]);
    await tx.insert(projectUpdates).values([
      {
        projectId: launch!.id,
        authorId: grace,
        health: 'on_track',
        body: 'Keys and docs landed. Webhooks are next; rate limiting needs a decision on per-key quotas.',
      },
      {
        projectId: design!.id,
        authorId: ada,
        health: 'at_risk',
        body: 'Panels and status glyphs are done. Mobile nav slipped a week.',
      },
    ]);

    const states = await tx.select().from(workflowStates);
    const people = [admin, grace, alan, ada, null];
    let n = 0;
    for (const [title, stateName, priority, key, labelNames] of ISSUES) {
      const tId = teamId[key]!;
      const state = states.find((s) => s.teamId === tId && s.name === stateName)!;
      const assignee = people[n % people.length] ?? null;
      const creator = ids[n % ids.length]!;
      const issue = await createIssue(ctx(creator), {
        teamId: tId,
        title,
        description:
          n % 3 === 0
            ? `Context for **${title.toLowerCase()}**.\n\n- [ ] Write a failing test\n- [ ] Fix it\n- [ ] Mention it in the changelog`
            : '',
        stateId: state.id,
        priority,
        assigneeId: assignee,
        labelIds: labelNames.map(labelId),
        projectId:
          key === 'DES' ||
          title.includes('Rate') ||
          title.includes('webhooks') ||
          title.includes('REST')
            ? key === 'DES'
              ? design!.id
              : launch!.id
            : null,
        cycleId:
          key === 'ENG' && ['In Progress', 'In Review', 'Todo'].includes(stateName)
            ? current.id
            : key === 'ENG' && stateName === 'Done'
              ? cycleRows[0]!.id
              : null,
        estimate: [1, 2, 3, 5, 8][n % 5]!,
        dueDate: n % 4 === 0 ? shift((n % 9) - 3) : null,
      });
      if (n === 2) {
        await tx.insert(comments).values([
          {
            issueId: issue.id,
            authorId: grace,
            body: 'Repro: group the board by **Label**, then drag a card with two labels. It disappears from one column.',
          },
          {
            issueId: issue.id,
            authorId: admin,
            body: '@alan can you take a look? Probably the duplicate sortable ids.',
          },
        ]);
      }
      n++;
    }
    // A sub-issue and a relation for good measure.
    const parentIssue = await createIssue(ctx(admin), {
      teamId: eng,
      title: 'Realtime sync engine v2',
      priority: 2,
      labelIds: [labelId('Backend')],
    });
    await createIssue(ctx(admin), {
      teamId: eng,
      title: 'Spike: CRDT vs. server-authoritative patches',
      parentId: parentIssue.id,
      assigneeId: alan,
    });
    await createIssue(ctx(admin), {
      teamId: eng,
      title: 'Benchmark NOTIFY fan-out with 1k clients',
      parentId: parentIssue.id,
    });
    await updateIssue(ctx(admin), parentIssue.id, {
      stateId: states.find((s) => s.teamId === eng && s.name === 'Todo')!.id,
    });
  });

  console.log(`Seeded workspace "demo". Sign in as ${PEOPLE[0]!.email} / ${PASSWORD}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
