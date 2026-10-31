import {
  type Bootstrap,
  type CustomField,
  type Import,
  parseCsv,
  type WorkspaceExport,
} from '@ordo/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, files, workspaceExports } from '../src/db/schema.ts';
import { purgeOldExports, runExport } from '../src/services/exports.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let boot: Bootstrap;
let ownerEmail: string;
let ownerId: string;
const slug = `exp-${Date.now()}`;

/** Custom fields of every type; select options by name. */
const FIELDS = [
  { name: 'Severity', type: 'select', options: [{ name: 'Low' }, { name: 'High' }] },
  { name: 'Areas', type: 'multi_select', options: [{ name: 'Web' }, { name: 'API' }] },
  { name: 'Points', type: 'number' },
  { name: 'Release', type: 'date' },
  { name: 'Notes', type: 'text' },
  { name: 'Owner', type: 'person' },
];
const fieldIds = async (c: Client, path: string) => {
  const list = (await c.get(`${path}/custom-fields`)).data as CustomField[];
  return Object.fromEntries(list.map((f) => [f.name, f]));
};
const ws = `/api/w/${slug}`;

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

async function exportAs(format: 'json' | 'csv') {
  const res = await owner.post(`${ws}/exports`, { format });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.data.status).toBe('running');
  await settle();
  const done = ((await owner.get(`${ws}/exports`)).data as WorkspaceExport[]).find(
    (e) => e.id === res.data.id,
  )!;
  expect(done.status, done.error ?? '').toBe('ready');
  const file = await app.inject({ method: 'GET', url: done.url! });
  expect(file.statusCode).toBe(200);
  expect(file.headers['content-disposition']).toContain(`ordo-${slug}-`);
  return { done, body: file.body };
}

beforeAll(async () => {
  app = await testApp();
  const o = await signup(app, 'Olive Owner');
  owner = o.client;
  ownerEmail = o.email;
  ownerId = (await owner.get('/api/auth/me')).data.id;
  await owner.post('/api/workspaces', { name: 'Export', slug, teamName: 'Alpha', teamKey: 'ALP' });
  for (const f of FIELDS) {
    const res = await owner.post(`${ws}/custom-fields`, f);
    expect(res.statusCode, res.body).toBe(200);
  }
  const fields = await fieldIds(owner, ws);
  const opt = (field: string, name: string) =>
    fields[field]!.options.find((x) => x.name === name)!.id;
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  member = (await signup(app, 'Bob Member', { inviteToken: invite.token })).client;
  await owner.post(`${ws}/teams`, { name: 'Secret', key: 'SEC', private: true });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  const alpha = boot.teams.find((t) => t.key === 'ALP')!;
  const secret = boot.teams.find((t) => t.key === 'SEC')!;
  const label = (await owner.post(`${ws}/labels`, { name: 'bug', color: '#ff1493' })).data;
  const project = (await owner.post(`${ws}/projects`, { name: 'Launch', teamIds: [alpha.id] }))
    .data;
  const parent = (
    await owner.post(`${ws}/issues`, {
      teamId: alpha.id,
      title: 'Parent, with "quotes"',
      description: 'Line one\nLine two',
      priority: 1,
      labelIds: [label.id],
      projectId: project.id,
      estimate: 3,
      customFields: {
        [fields.Severity!.id]: opt('Severity', 'High'),
        [fields.Areas!.id]: [opt('Areas', 'Web'), opt('Areas', 'API')],
        [fields.Points!.id]: 2.5,
        [fields.Release!.id]: '2026-12-01',
        [fields.Notes!.id]: 'Ship it, soon',
        [fields.Owner!.id]: ownerId,
      },
    })
  ).data;
  expect(Object.keys(parent.customFields)).toHaveLength(6);
  const child = (
    await owner.post(`${ws}/issues`, { teamId: alpha.id, title: 'Child', parentId: parent.id })
  ).data;
  await owner.post(`${ws}/issues/${parent.id}/comments`, { body: 'First comment' });
  await owner.post(`${ws}/issues/${parent.id}/relations`, {
    type: 'blocks',
    relatedIssueId: child.id,
  });
  await owner.post(`${ws}/issues`, { teamId: secret.id, title: 'Private plan' });
  const trashed = (await owner.post(`${ws}/issues`, { teamId: alpha.id, title: 'Trashed' })).data;
  await owner.del(`${ws}/issues/${trashed.id}`);
  await owner.post(`${ws}/views`, { name: 'Shared view', filters: {}, shared: true });
  await member.post(`${ws}/views`, { name: "Bob's own view", filters: {}, shared: false });
});
afterAll(async () => {
  await app.close();
});

describe('workspace export', () => {
  it('is for workspace admins only', async () => {
    expect((await member.get(`${ws}/exports`)).statusCode).toBe(403);
    expect((await member.post(`${ws}/exports`, { format: 'json' })).statusCode).toBe(403);
  });

  it('starts only one of several exports requested at once', async () => {
    const codes = await Promise.all(
      Array.from({ length: 4 }, () =>
        owner.post(`${ws}/exports`, { format: 'json' }).then((r) => r.statusCode),
      ),
    );
    expect(codes.sort()).toEqual([200, 409, 409, 409]);
    await settle();
  });

  it('exports everything as JSON, one export at a time', async () => {
    const first = await owner.post(`${ws}/exports`, { format: 'json' });
    expect((await owner.post(`${ws}/exports`, { format: 'csv' })).statusCode).toBe(409);
    await settle();
    const done = ((await owner.get(`${ws}/exports`)).data as WorkspaceExport[]).find(
      (e) => e.id === first.data.id,
    )!;
    expect(done.status).toBe('ready');
    const body = (await app.inject({ method: 'GET', url: done.url! })).body;
    const data = JSON.parse(body);
    expect(done.size).toBe(Buffer.byteLength(body));

    expect(data).toMatchObject({ format: 'ordo-workspace-export', version: 1 });
    expect(data.workspace.slug).toBe(slug);
    expect(data.members.map((m: { name: string }) => m.name).sort()).toEqual([
      'Bob Member',
      'Olive Owner',
    ]);
    expect(data.teams.map((t: { key: string }) => t.key).sort()).toEqual(['ALP', 'SEC']);
    // Private teams' and trashed issues are the workspace's too.
    const titles = data.issues.map((i: { title: string }) => i.title);
    expect(titles).toEqual(
      expect.arrayContaining(['Parent, with "quotes"', 'Child', 'Private plan', 'Trashed']),
    );
    expect(data.comments.map((c: { body: string }) => c.body)).toEqual(['First comment']);
    expect(data.relations).toHaveLength(1);
    expect(data.history.length).toBeGreaterThanOrEqual(5);
    expect(data.projects.map((p: { name: string }) => p.name)).toEqual(['Launch']);
    // Custom field definitions, and the values on the issues.
    expect(data.customFields.map((f: CustomField) => f.name)).toEqual(FIELDS.map((f) => f.name));
    const exported = data.issues.find(
      (i: { title: string }) => i.title === 'Parent, with "quotes"',
    );
    const points = data.customFields.find((f: CustomField) => f.name === 'Points').id;
    expect(exported.customFields[points]).toBe(2.5);
    // Personal things stay personal; secrets stay secret.
    expect(data.views.map((v: { name: string }) => v.name)).toEqual(['Shared view']);
    expect(body).not.toMatch(/"(passwordHash|secrets|tokenHash|totpSecret|inboundToken)"/);

    const audit = await app.db.select().from(auditLog).where(eq(auditLog.targetId, done.id));
    expect(audit.map((a) => a.action)).toEqual(['workspace.exported']);
  });

  it('exports issues as CSV that imports back', async () => {
    const { body } = await exportAs('csv');
    const [header, ...rows] = parseCsv(body);
    expect(header!.slice(0, 6)).toEqual([
      'ID',
      'Team',
      'Title',
      'Description',
      'Status',
      'Priority',
    ]);
    expect(rows.map((r) => r[2])).not.toContain('Trashed');
    const parent = rows.find((r) => r[2] === 'Parent, with "quotes"')!;
    expect(parent[3]).toBe('Line one\nLine two');
    expect(parent[5]).toBe('Urgent');
    expect(parent[8]).toBe('bug');
    expect(rows.find((r) => r[2] === 'Child')![11]).toBe(parent[0]);
    // A column per custom field, written as people read it.
    expect(header!.slice(19)).toEqual(FIELDS.map((f) => f.name));
    expect(parent.slice(19)).toEqual([
      'High',
      'Web, API',
      '2.5',
      '2026-12-01',
      'Ship it, soon',
      ownerEmail,
    ]);
    expect(rows.find((r) => r[2] === 'Child')!.slice(19)).toEqual(['', '', '', '', '', '']);

    // Into a fresh workspace, through the CSV import. It has the same fields, by name, except
    // that Severity lacks the High option and there's no Release field.
    const slug2 = `${slug}-copy`;
    await owner.post('/api/workspaces', {
      name: 'Copy',
      slug: slug2,
      teamName: 'Beta',
      teamKey: 'BET',
    });
    const ws2 = `/api/w/${slug2}`;
    for (const f of FIELDS.filter((f) => f.name !== 'Release')) {
      const res = await owner.post(`${ws2}/custom-fields`, {
        ...f,
        name: f.name.toLowerCase(),
        ...(f.name === 'Severity' && { options: [{ name: 'Low' }] }),
        ...(f.name === 'Areas' && { options: [{ name: 'api' }] }),
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const boundary = '----ordo-roundtrip';
    const up = await app.inject({
      method: 'POST',
      url: `${ws2}/imports`,
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="export.csv"\r\nContent-Type: text/csv\r\n\r\n`,
        ),
        Buffer.from(body),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: {
        cookie: owner.cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(up.statusCode, up.body).toBe(200);
    await settle();
    let imp = (await owner.get(`${ws2}/imports/${up.json().id}`)).data as Import;
    expect(imp.summary!.csv!.columns).toMatchObject({
      id: 'ID',
      team: 'Team',
      title: 'Title',
      status: 'Status',
      priority: 'Priority',
      labels: 'Labels',
      parent: 'Parent',
    });
    await owner.post(`${ws2}/imports/${imp.id}/run`);
    await settle(6);
    imp = (await owner.get(`${ws2}/imports/${imp.id}`)).data;
    expect(imp.status, imp.error ?? '').toBe('completed');

    const copy = (await owner.get(`${ws2}/issues/${parent[0]}`)).data;
    expect(copy).toMatchObject({ title: 'Parent, with "quotes"', priority: 1, estimate: 3 });
    expect(copy.description).toBe('Line one\nLine two');
    const fields2 = await fieldIds(owner, ws2);
    const optionNames = (field: string, ids: string[]) =>
      ids.map((id) => fields2[field]!.options.find((o) => o.id === id)!.name);
    // The missing High option was added; "API" matched the existing "api".
    expect(optionNames('severity', [copy.customFields[fields2.severity!.id]])).toEqual(['High']);
    expect(optionNames('areas', copy.customFields[fields2.areas!.id])).toEqual(['api', 'Web']);
    expect(copy.customFields[fields2.points!.id]).toBe(2.5);
    expect(copy.customFields[fields2.notes!.id]).toBe('Ship it, soon');
    expect(copy.customFields[fields2.owner!.id]).toBe(ownerId);
    expect(Object.keys(copy.customFields)).toHaveLength(5);
    expect(copy.subIssues.map((s: { title: string }) => s.title)).toEqual(['Child']);
    const boot2 = (await owner.get(`${ws2}/bootstrap`)).data as Bootstrap;
    expect(copy.labelIds.map((id: string) => boot2.labels.find((l) => l.id === id)!.name)).toEqual([
      'bug',
    ]);
    expect(boot2.projects.map((p) => p.name)).toEqual(['Launch']);
    const team = boot2.teams.find((t) => t.id === copy.teamId)!;
    const original = boot.teams.find((t) => t.key === 'ALP')!;
    expect(team.states.find((s) => s.id === copy.stateId)!.name).toBe(
      original.states.find((s) => s.id === original.defaultStateId)!.name,
    );
  });

  it('keeps one result when two runs of the same export overlap', async () => {
    const res = await owner.post(`${ws}/exports`, { format: 'json' });
    const exportFiles = async () =>
      (
        await app.db
          .select({ id: files.id })
          .from(files)
          .where(and(eq(files.workspaceId, boot.workspace.id), eq(files.kind, 'export')))
      ).map((f) => f.id);
    const before = await exportFiles();
    // As if the job's lock had run out mid-export and a second worker had picked it up too.
    const job = { attempt: 1, maxAttempts: 8, jobId: 0, log: app.log };
    await Promise.all([
      runExport(app, { exportId: res.data.id }, job),
      runExport(app, { exportId: res.data.id }, job),
    ]);
    const [row] = await app.db
      .select()
      .from(workspaceExports)
      .where(eq(workspaceExports.id, res.data.id));
    expect(row!.status).toBe('ready');
    const added = (await exportFiles()).filter((id) => !before.includes(id));
    expect(added).toEqual([row!.fileId]);
    await settle();
  });

  it('a run that fails late does not undo one that finished', async () => {
    const res = await owner.post(`${ws}/exports`, { format: 'json' });
    // The first export file to be saved fails, but only after a second's wait, by which time the
    // other run has finished. Sequences aren't rolled back, so exactly one run fails.
    await app.db.execute(
      sql.raw(`create sequence export_race;
        create function export_race() returns trigger language plpgsql as $$
        begin
          if new.kind = 'export' and nextval('export_race') = 1 then
            perform pg_sleep(1);
            raise exception 'injected failure';
          end if;
          return new;
        end $$;
        create trigger export_race before insert on files
          for each row execute function export_race();`),
    );
    try {
      // Both on their last attempt, so the failing one records its failure.
      const job = { attempt: 8, maxAttempts: 8, jobId: 0, log: app.log };
      await Promise.all([
        runExport(app, { exportId: res.data.id }, job),
        runExport(app, { exportId: res.data.id }, job),
      ]);
    } finally {
      await app.db.execute(
        sql.raw(`drop trigger export_race on files; drop function export_race();
          drop sequence export_race;`),
      );
    }
    const [row] = await app.db
      .select()
      .from(workspaceExports)
      .where(eq(workspaceExports.id, res.data.id));
    expect(row).toMatchObject({ status: 'ready', error: null });
    expect(row!.fileId).not.toBeNull();
    await settle();
  });

  it('fails, rather than retrying forever, when every attempt takes its worker down', async () => {
    const res = await owner.post(`${ws}/exports`, { format: 'json' });
    // The last attempt's worker died (out of memory) and its lock ran out.
    await app.db.execute(sql`
      update jobs set status = 'running', attempts = max_attempts,
        locked_until = now() - interval '1 second'
      where name = 'export.run' and payload->>'exportId' = ${res.data.id}`);
    await app.jobs.drain();
    const [row] = await app.db
      .select()
      .from(workspaceExports)
      .where(eq(workspaceExports.id, res.data.id));
    expect(row).toMatchObject({ status: 'failed', fileId: null });
    expect(row!.error).toContain('stopped responding');
    const [job] = await app.db.execute<{ status: string }>(
      sql`select status from jobs where payload->>'exportId' = ${res.data.id}`,
    );
    expect(job!.status).toBe('dead');
  });

  it('can be deleted, and is purged after a week', async () => {
    const { done } = await exportAs('json');
    const del = await owner.del(`${ws}/exports/${done.id}`);
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: done.url! })).statusCode).toBe(404);

    const { done: old } = await exportAs('csv');
    const [row] = await app.db
      .select()
      .from(workspaceExports)
      .where(eq(workspaceExports.id, old.id));
    await app.db
      .update(workspaceExports)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })
      .where(eq(workspaceExports.id, old.id));
    await purgeOldExports(app);
    expect(
      await app.db.select().from(workspaceExports).where(eq(workspaceExports.id, old.id)),
    ).toHaveLength(0);
    expect(await app.db.select().from(files).where(eq(files.id, row!.fileId!))).toHaveLength(0);
  });
});
