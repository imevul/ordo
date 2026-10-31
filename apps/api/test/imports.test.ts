import type { Bootstrap, CustomField, Import, IssueDetail } from '@ordo/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  issues,
  labels,
  notifications,
  projects,
  syncChanges,
  syncCursors,
  teams,
  workspaces,
} from '../src/db/schema.ts';
import { calendarDate } from '../src/services/imports/csv.ts';
import { importLimits } from '../src/services/imports/engine.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let ownerEmail: string;
let memberEmail: string;
let memberId: string;
let ownerId: string;
let workspaceId: string;
const slug = `imp-${Date.now()}`;
const ws = `/api/w/${slug}`;

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

function upload(c: Client, filename: string, csv: string) {
  const boundary = '----ordo-import';
  return app.inject({
    method: 'POST',
    url: `${ws}/imports`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\ncsv\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      Buffer.from(csv),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { cookie: c.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

/** Uploads a CSV and waits for the analysis. */
async function analyzed(filename: string, csv: string) {
  const res = await upload(owner, filename, csv);
  expect(res.statusCode).toBe(200);
  await settle();
  return (await owner.get(`${ws}/imports/${res.json().id}`)).data as Import;
}

async function run(id: string, kind: 'run' | 'dry-run') {
  const res = await owner.post(`${ws}/imports/${id}/${kind}`);
  expect(res.statusCode, res.body).toBe(200);
  await settle();
  return (await owner.get(`${ws}/imports/${id}`)).data as Import;
}

const issue = async (identifier: string) =>
  (await owner.get(`${ws}/issues/${identifier}`)).data as IssueDetail;
const issueCount = async () =>
  (
    await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(webTeam())
  )[0]!.n;
// Other test files share the database and make WEB teams of their own.
const webTeam = () => and(eq(teams.workspaceId, workspaceId), eq(teams.key, 'WEB'));

beforeAll(async () => {
  app = await testApp();
  const o = await signup(app, 'Olive Owner');
  owner = o.client;
  ownerEmail = o.email;
  await owner.post('/api/workspaces', { name: 'Imports', slug, teamName: 'Alpha', teamKey: 'ALP' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  const m = await signup(app, 'Bob Member', { inviteToken: invite.token });
  member = m.client;
  memberEmail = m.email;
  memberId = (await member.get('/api/auth/me')).data.id;
  ownerId = (await owner.get('/api/auth/me')).data.id;
  const [w] = await app.db.select().from(workspaces).where(eq(workspaces.slug, slug));
  workspaceId = w!.id;
});
afterAll(async () => {
  await app.close();
});

describe('CSV import', () => {
  let imp: Import;
  const csv = () =>
    [
      'ID,Team,Title,Description,Status,Priority,Assignee,Creator,Labels,Project,Parent,Estimate,Due Date,Created,Completed,URL',
      `WEB-1,Web,Set up the site,"Landing page, docs",Done,High,${memberEmail},${ownerEmail},"frontend, launch",Launch,,3,2024-03-01,2024-01-10T09:00:00Z,2024-02-01T12:00:00Z,https://example.com/WEB-1`,
      'WEB-2,Web,Write docs,,In Progress,Medium,ghost@example.com,,docs,Launch,WEB-1,,,2024-01-11,,',
      'WEB-3,Web,,No title here,Todo,,,,,,,,,,,',
      'WEB-5,Web,Odd one,,Waiting,whenever,,,,,,,03/15/2026,not a date,,',
    ].join('\r\n');

  it('is for workspace admins only', async () => {
    expect((await member.get(`${ws}/imports`)).statusCode).toBe(403);
    expect((await upload(member, 'x.csv', 'Title\nx')).statusCode).toBe(403);
  });

  it('analyzes the file and suggests a mapping', async () => {
    imp = await analyzed('linear.csv', csv());
    expect(imp.status).toBe('ready');
    const s = imp.summary!;
    expect(s.counts.issues).toBe(4);
    expect(s.teams).toEqual([
      expect.objectContaining({ id: 'web', name: 'Web', key: 'WEB', issueCount: 4 }),
    ]);
    expect(s.teams[0]!.statuses.find((x) => x.name === 'In Progress')!.type).toBe('started');
    expect(s.labels.map((l) => l.name).sort()).toEqual(['docs', 'frontend', 'launch']);
    expect(s.csv!.columns).toMatchObject({ id: 'ID', title: 'Title', parent: 'Parent' });

    const m = imp.mapping!;
    expect(m.teams.web).toEqual({ create: { name: 'Web', key: 'WEB' } });
    expect(m.statuses.web).toMatchObject({ Done: 'completed', Waiting: 'backlog' });
    expect(m.users[memberEmail.toLowerCase()]).toBe(memberId);
    // Nobody matches the ghost: a placeholder will stand in for them.
    expect(m.users['ghost@example.com']).toBe('placeholder');
    expect(m.labels.docs).toBe('create');
    expect(m.keepNumbers).toBe(true);
  });

  it('dry-runs without touching the workspace', async () => {
    const wsLabels = () => app.db.select().from(labels).where(eq(labels.workspaceId, workspaceId));
    const labelsBefore = await wsLabels();
    imp = await run(imp.id, 'dry-run');
    expect(imp.status).toBe('ready');
    expect(imp.report).toMatchObject({
      dryRun: true,
      created: { teams: 1, people: 1, labels: 3, projects: 1, issues: 3 },
      skippedCount: 1,
    });
    expect(imp.report!.skipped[0]).toEqual({ item: 'WEB-3', message: 'It has no title' });
    expect(imp.report!.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        'Couldn\'t read the priority "whenever"',
        'Couldn\'t read the created date "not a date"',
      ]),
    );
    const [web] = await app.db.select().from(teams).where(webTeam());
    expect(web).toBeUndefined();
    expect(await wsLabels()).toHaveLength(labelsBefore.length);
  });

  it('imports issues with their numbers, people, dates, labels, project and parents', async () => {
    imp = await run(imp.id, 'run');
    expect(imp.status).toBe('completed');
    expect(imp.report).toMatchObject({ dryRun: false, created: { issues: 3 }, skippedCount: 1 });

    const one = await issue('WEB-1');
    expect(one.title).toBe('Set up the site');
    expect(one.assigneeId).toBe(memberId);
    expect(one.creatorId).toBe(ownerId);
    expect(one.createdAt).toBe('2024-01-10T09:00:00.000Z');
    expect(one.completedAt).toBe('2024-02-01T12:00:00.000Z');
    expect(one.priority).toBe(2);
    expect(one.estimate).toBe(3);
    expect(one.dueDate).toBe('2024-03-01');
    expect(one.labelIds).toHaveLength(2);
    expect(one.links.map((l) => l.url)).toEqual(['https://example.com/WEB-1']);
    expect(one.subIssues.map((s) => s.identifier)).toEqual(['WEB-2']);

    const two = await issue('WEB-2');
    const ghost = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).placeholders.find(
      (p) => p.name === 'ghost@example.com',
    );
    expect(two.assigneeId).toBe(ghost!.id);
    // Unknown creators fall back to whoever ran the import.
    expect(two.creatorId).toBe(ownerId);
    expect(two.projectId).toBe(one.projectId);
    const [project] = await app.db.select().from(projects).where(eq(projects.id, one.projectId!));
    expect(project!.name).toBe('Launch');

    // Kept numbers leave a gap where the skipped row was, and new issues continue after them.
    expect(await issue('WEB-5')).toMatchObject({ title: 'Odd one', dueDate: '2026-03-15' });
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const web = boot.teams.find((t) => t.key === 'WEB')!;
    const next = await owner.post(`${ws}/issues`, { teamId: web.id, title: 'After the import' });
    expect(next.data.identifier).toBe('WEB-6');

    // Silent: nobody was notified about imported assignments.
    const bobs = await app.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, memberId));
    expect(bobs).toHaveLength(0);
    const audit = await app.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, imp.id)));
    expect(audit.map((a) => a.action).sort()).toEqual(['import.completed', 'import.started']);
  });

  it('starts a new sync epoch rather than logging each imported row', async () => {
    const [cursor] = await app.db
      .select()
      .from(syncCursors)
      .innerJoin(workspaces, eq(workspaces.id, syncCursors.workspaceId))
      .where(eq(workspaces.slug, slug));
    expect(cursor!.sync_cursors.epoch).toBeGreaterThan(1);
    const imported = await app.db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      // The one made by hand afterwards is logged like any other.
      .where(and(webTeam(), ne(issues.title, 'After the import')));
    const logged = await app.db
      .select()
      .from(syncChanges)
      .where(
        inArray(
          syncChanges.entityId,
          imported.map((i) => i.id),
        ),
      );
    expect(logged.map((l) => [l.kind, l.action])).toEqual([]);
  });

  it('skips what it already imported when run again', async () => {
    const before = await issueCount();
    imp = await run(imp.id, 'run');
    expect(imp.report).toMatchObject({ existing: 3, created: { teams: 0, issues: 0 } });
    expect(await issueCount()).toBe(before);
  });
});

describe('CSV due dates', () => {
  it('are the calendar day written, whatever zone the server runs in', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        expect(calendarDate('03/15/2026'), zone).toBe('2026-03-15');
        expect(calendarDate('March 15, 2026'), zone).toBe('2026-03-15');
        expect(calendarDate('2026-03-15'), zone).toBe('2026-03-15');
        expect(calendarDate('2026-03-15T23:30:00-08:00'), zone).toBe('2026-03-15');
        expect(calendarDate('someday'), zone).toBeUndefined();
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('CSV import into an existing team', () => {
  it('renumbers, keeps file order above existing issues, and checks the mapping', async () => {
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const alpha = boot.teams.find((t) => t.key === 'ALP')!;
    await owner.post(`${ws}/issues`, { teamId: alpha.id, title: 'Already here' });

    let imp = await analyzed('backlog.csv', 'Title,Status\nFirst,Todo\nSecond,Doing\nThird,');
    expect(Object.keys(imp.mapping!.teams)).toEqual(['*']);

    // A status of another team is refused.
    const web = boot.teams.find((t) => t.key === 'WEB')!;
    const bad = await owner.patch(`${ws}/imports/${imp.id}`, {
      mapping: {
        ...imp.mapping!,
        teams: { '*': { teamId: alpha.id } },
        statuses: { '*': { Todo: web.states[0]!.id } },
      },
    });
    expect(bad.statusCode).toBe(200);
    expect((await owner.post(`${ws}/imports/${imp.id}/run`)).statusCode).toBe(400);

    const todo = alpha.states.find((s) => s.name === 'Todo')!;
    await owner.patch(`${ws}/imports/${imp.id}`, {
      mapping: {
        ...imp.mapping!,
        teams: { '*': { teamId: alpha.id } },
        statuses: { '*': { Todo: todo.id, Doing: 'started' } },
      },
    });
    imp = await run(imp.id, 'run');
    expect(imp.status).toBe('completed');

    const rows = await app.db
      .select({ title: issues.title, number: issues.number, stateId: issues.stateId })
      .from(issues)
      .where(eq(issues.teamId, alpha.id))
      .orderBy(issues.sortOrder);
    expect(rows.map((r) => r.title)).toEqual(['First', 'Second', 'Third', 'Already here']);
    expect(rows.find((r) => r.title === 'First')!.number).toBeGreaterThan(1);
    expect(rows.find((r) => r.title === 'First')!.stateId).toBe(todo.id);
    const started = alpha.states.filter((s) => s.type === 'started').map((s) => s.id);
    expect(started).toContain(rows.find((r) => r.title === 'Second')!.stateId);
  });

  it('re-analyzes when the columns change', async () => {
    const imp = await analyzed('cols.csv', 'Name,Body\nOne,first body');
    expect(imp.summary!.csv!.columns.title).toBe('Name');
    expect(imp.summary!.csv!.columns.description).toBe('Body');
    const res = await owner.patch(`${ws}/imports/${imp.id}`, {
      config: { columns: { title: 'Body', description: null } },
    });
    expect(res.data.status).toBe('analyzing');
    await settle();
    const again = (await owner.get(`${ws}/imports/${imp.id}`)).data as Import;
    expect(again.summary!.csv!.columns.title).toBe('Body');
    expect(again.status).toBe('ready');
  });
});

describe('CSV custom field columns', () => {
  it('import into the fields of the same name, adding options and reporting bad values', async () => {
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const alpha = boot.teams.find((t) => t.key === 'ALP')!;
    const make = async (body: object) => {
      const res = await owner.post(`${ws}/custom-fields`, body);
      expect(res.statusCode, res.body).toBe(200);
      return res.data as CustomField;
    };
    const tier = await make({
      name: 'Tier',
      type: 'select',
      teamId: alpha.id,
      options: [{ name: 'Gold' }],
    });
    const size = await make({ name: 'Size', type: 'number' });
    const reviewer = await make({ name: 'Reviewer', type: 'person' });
    const start = await make({ name: 'Kickoff', type: 'date' });
    const areas = await make({ name: 'Areas', type: 'multi_select', options: [{ name: 'Web' }] });

    let imp = await analyzed(
      'fields.csv',
      [
        'Title,tier,SIZE,Reviewer,Kickoff,Areas,Unrelated',
        `Field one,gold,3,${memberEmail},2026-02-01,"web, cli",x`,
        'Field two,Silver,lots,Rita Reviewer,someday,,y',
      ].join('\n'),
    );
    expect(imp.summary!.fields!.map((f) => [f.name, f.count])).toEqual([
      ['tier', 2],
      ['SIZE', 2],
      ['Reviewer', 2],
      ['Kickoff', 2],
      ['Areas', 1],
    ]);
    expect(imp.mapping!.fields).toEqual({
      tier: tier.id,
      size: size.id,
      reviewer: reviewer.id,
      kickoff: start.id,
      areas: areas.id,
    });
    // Reviewers are people to map, like assignees.
    expect(imp.mapping!.users[memberEmail.toLowerCase()]).toBe(memberId);
    expect(imp.mapping!.users['rita reviewer']).toBe('placeholder');

    await owner.patch(`${ws}/imports/${imp.id}`, {
      mapping: { ...imp.mapping!, teams: { '*': { teamId: alpha.id } } },
    });
    imp = await run(imp.id, 'run');
    expect(imp.status, imp.error ?? '').toBe('completed');
    expect(imp.report!.created.issues).toBe(2);
    expect(imp.report!.warnings.map((w) => [w.item, w.message])).toEqual(
      expect.arrayContaining([
        ['row 3', 'Couldn\'t read the Size "lots"'],
        ['row 3', 'Couldn\'t read the Kickoff "someday"'],
      ]),
    );

    const fields = Object.fromEntries(
      ((await owner.get(`${ws}/custom-fields`)).data as CustomField[]).map((f) => [f.id, f]),
    );
    const names = (fieldId: string, ids: string[]) =>
      ids.map((id) => fields[fieldId]!.options.find((o) => o.id === id)!.name);
    const rows = await app.db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.teamId, alpha.id), inArray(issues.title, ['Field one', 'Field two'])));
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.id]));
    const first = await issue(byTitle['Field one']!);
    expect(names(tier.id, [first.customFields[tier.id] as string])).toEqual(['Gold']);
    expect(first.customFields[size.id]).toBe(3);
    expect(first.customFields[reviewer.id]).toBe(memberId);
    expect(first.customFields[start.id]).toBe('2026-02-01');
    expect(names(areas.id, first.customFields[areas.id] as string[])).toEqual(['Web', 'cli']);

    const second = await issue(byTitle['Field two']!);
    // A new option, made on the way.
    expect(names(tier.id, [second.customFields[tier.id] as string])).toEqual(['Silver']);
    expect(second.customFields[size.id]).toBeUndefined();
    expect(second.customFields[start.id]).toBeUndefined();
    const rita = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).placeholders.find(
      (p) => p.name === 'Rita Reviewer',
    );
    expect(second.customFields[reviewer.id]).toBe(rita!.id);
  });
});

describe('undoing an import', () => {
  it('moves what it created to the trash, where it can be restored', async () => {
    let imp = await analyzed('undo.csv', 'Title\nUndo me\nAnd me');
    imp = await run(imp.id, 'run');
    const made = await app.db
      .select({ id: issues.id, deletedAt: issues.deletedAt })
      .from(issues)
      .where(inArray(issues.title, ['Undo me', 'And me']));
    expect(made).toHaveLength(2);

    // Only an import that ran can be undone.
    const fresh = await analyzed('fresh.csv', 'Title\nNot yet');
    expect((await owner.post(`${ws}/imports/${fresh.id}/undo`)).statusCode).toBe(400);
    expect((await member.post(`${ws}/imports/${imp.id}/undo`)).statusCode).toBe(403);

    const res = await owner.post(`${ws}/imports/${imp.id}/undo`);
    expect(res.data.status).toBe('undoing');
    await settle();
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.status).toBe('undone');
    expect(imp.progress).toMatchObject({ phase: 'undo', done: 2, total: 2 });
    const trashed = await app.db
      .select({ deletedAt: issues.deletedAt })
      .from(issues)
      .where(
        inArray(
          issues.id,
          made.map((m) => m.id),
        ),
      );
    expect(trashed.every((t) => t.deletedAt)).toBe(true);

    expect((await owner.post(`${ws}/issues/${made[0]!.id}/restore`)).statusCode).toBe(200);
    expect((await owner.post(`${ws}/imports/${imp.id}/run`)).data.message).toContain('undone');
    const audit = await app.db.select().from(auditLog).where(eq(auditLog.targetId, imp.id));
    expect(audit.map((a) => a.action)).toContain('import.undone');
  });
});

describe('large and cancelled imports', () => {
  it('works through several pages, linking parents across them', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => {
      const n = i + 1;
      return `BIG-${n},Big ${n},${n === 300 ? 'BIG-1' : ''}`;
    });
    let imp = await analyzed('big.csv', ['ID,Title,Parent', ...rows].join('\n'));
    imp = await run(imp.id, 'dry-run');
    expect(imp.report!.created.issues).toBe(300);
    expect(imp.report!.warningCount).toBe(0);
    // Every step hands over to a new job, as long imports do.
    importLimits.timeBudgetMs = 0;
    try {
      await owner.post(`${ws}/imports/${imp.id}/run`);
      await settle(10);
    } finally {
      importLimits.timeBudgetMs = 30_000;
    }
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data as Import;
    expect(imp.status).toBe('completed');
    expect(imp.report!.created.issues).toBe(300);
    expect((await issue('BIG-300')).parent?.identifier).toBe('BIG-1');
  });

  it("refuses members on an existing import's every action", async () => {
    const imp = await analyzed('members.csv', 'Title\nNot for members');
    expect((await member.get(`${ws}/imports/${imp.id}`)).statusCode).toBe(403);
    expect(
      (await member.patch(`${ws}/imports/${imp.id}`, { mapping: imp.mapping })).statusCode,
    ).toBe(403);
    for (const action of ['dry-run', 'run', 'cancel']) {
      expect((await member.post(`${ws}/imports/${imp.id}/${action}`)).statusCode, action).toBe(403);
    }
    expect((await member.del(`${ws}/imports/${imp.id}`)).statusCode).toBe(403);
    await settle();
    expect((await owner.get(`${ws}/imports/${imp.id}`)).data.status).toBe('ready');
    const [row] = await app.db.select().from(issues).where(eq(issues.title, 'Not for members'));
    expect(row).toBeUndefined();
    expect((await owner.del(`${ws}/imports/${imp.id}`)).statusCode).toBe(200);
  });

  it('stops when cancelled', async () => {
    const imp = await analyzed('cancel.csv', 'Title\nNever imported');
    await owner.post(`${ws}/imports/${imp.id}/run`);
    const res = await owner.post(`${ws}/imports/${imp.id}/cancel`);
    expect(res.data.status).toBe('canceled');
    await settle();
    const [row] = await app.db.select().from(issues).where(eq(issues.title, 'Never imported'));
    expect(row).toBeUndefined();
    expect((await owner.del(`${ws}/imports/${imp.id}`)).statusCode).toBe(200);
    expect((await owner.get(`${ws}/imports/${imp.id}`)).statusCode).toBe(404);
  });
});
