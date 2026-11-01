import { randomUUID } from 'node:crypto';
import type { Bootstrap, IssueDetail, RequestForm, Team } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issues, requestForms } from '../src/db/schema.ts';
import { runAutomation } from '../src/services/automation.ts';
import { saveFile } from '../src/services/files.ts';
import { bulkUpdateIssues } from '../src/services/issues.ts';
import { requestFormCaptchaSecretAad } from '../src/services/secretKey.ts';
import { Client, captureMail, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let inbox: { to: string; subject: string; text: string }[];
const ws = '/api/w/forms';
let team: Team;
let otherTeam: Team;
let form: RequestForm;

// Rate limits count per address, so each submission comes from its own unless a test says otherwise.
let ip = 0;
const visitor = () => new Client(app, { ip: `10.77.${(ip >> 8) & 255}.${ip++ & 255}` });

const save = (body: object, teamId = team.id) =>
  owner.put(`${ws}/teams/${teamId}/request-form`, body);
const url = () => `/api/forms/${form.token}`;
const valid = {
  name: 'Ada Lovelace',
  email: 'ada@acme.example',
  title: 'Please add CSV export',
  description: 'We need it for the auditors.',
};
const submit = (body: object = {}, c = visitor()) => c.post(url(), { ...valid, ...body });

/** A multipart submission, as the public page sends it. */
function multipart(body: object, files: { filename?: string; body: Buffer }[], c = visitor()) {
  const boundary = '----ordo-test-form';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify({ ...valid, ...body })}\r\n`,
    ),
    ...files.flatMap((f) => [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"${f.filename === undefined ? '' : `; filename="${f.filename}"`}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      f.body,
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: url(),
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    remoteAddress: (c as unknown as { opts: { ip: string } }).opts.ip,
  });
}

const titled = async (title: string) => {
  const [row] = await app.db.select().from(issues).where(eq(issues.title, title));
  return row;
};
const detail = async (title: string) =>
  (await owner.get(`${ws}/issues/${(await titled(title))!.id}`)).data as IssueDetail;
const stateOfType = (type: string) => team.states.find((s) => s.type === type)!.id;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Hidden Workspace',
    slug: 'forms',
    teamName: 'Secret Team',
    teamKey: 'SEC',
  });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: invite })).client;
  otherTeam = (await owner.post(`${ws}/teams`, { name: 'Other', key: 'OTH' })).data;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  team = boot.teams.find((t) => t.key === 'SEC')!;
  await owner.patch(`${ws}/teams/${team.id}`, { triageEnabled: true });
  team = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams.find(
    (t) => t.id === team.id,
  )!;
  form = (await save({ enabled: true, title: 'Ask us anything' })).data;
  inbox = captureMail(app);
});

afterAll(() => app.close());

beforeEach(async () => {
  // Limits and mail from one test mustn't spill into the next.
  await app.db.execute(sql`delete from request_form_submissions`);
  await app.jobs.drain();
  inbox.length = 0;
  form = (
    await save({
      enabled: true,
      title: 'Ask us anything',
      fields: [],
      templateId: null,
      allowAttachments: false,
      confirmationEmail: true,
      doneEmail: false,
      captchaProvider: null,
    })
  ).data;
});

describe('setting up a form', () => {
  it('is for team admins only', async () => {
    const path = `${ws}/teams/${team.id}/request-form`;
    expect((await member.get(path)).statusCode).toBe(403);
    expect((await member.put(path, { enabled: false })).statusCode).toBe(403);
    expect((await member.post(`${path}/rotate-link`)).statusCode).toBe(403);
    expect((await visitor().get(path)).statusCode).toBe(401);
    expect((await owner.get(`${ws}/teams/not-a-uuid/request-form`)).statusCode).toBe(404);
  });

  it("can't reach a team in another workspace", async () => {
    const other = (await signup(app, 'Otto Other')).client;
    await other.post('/api/workspaces', {
      name: 'Else',
      slug: 'forms-else',
      teamName: 'Else',
      teamKey: 'ELS',
    });
    const res = await other.put(`/api/w/forms-else/teams/${team.id}/request-form`, {
      enabled: false,
    });
    expect(res.statusCode).toBe(404);
  });

  it('starts empty and keeps what a save leaves out', async () => {
    const empty = await owner.get(`${ws}/teams/${otherTeam.id}/request-form`);
    expect(empty.data).toEqual({ form: null });
    const first = (await save({ title: 'Hello' }, otherTeam.id)).data as RequestForm;
    expect(first.enabled).toBe(false);
    const second = (await save({ intro: 'Tell us' }, otherTeam.id)).data as RequestForm;
    expect(second).toMatchObject({ title: 'Hello', intro: 'Tell us', token: first.token });
  });

  it('rejects a template from another team and a select without options', async () => {
    const template = await owner.post(`${ws}/templates`, {
      teamId: otherTeam.id,
      name: 'Theirs',
    });
    expect((await save({ templateId: template.data.id })).statusCode).toBe(404);
    const res = await save({
      fields: [{ id: 'plan', label: 'Plan', type: 'select', required: true }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('never returns the CAPTCHA secret and stores it encrypted', async () => {
    expect((await save({ captchaProvider: 'turnstile', captchaSiteKey: 'site' })).statusCode).toBe(
      400,
    );
    const saved = await save({
      captchaProvider: 'turnstile',
      captchaSiteKey: 'site',
      captchaSecret: 'top-secret-value',
    });
    expect(saved.data.captchaSecretSet).toBe(true);
    expect(saved.body).not.toContain('top-secret-value');
    const [row] = await app.db.select().from(requestForms).where(eq(requestForms.teamId, team.id));
    expect(row!.captchaSecret).toMatch(/^v1\./);
    expect(app.keyring.decrypt(row!.captchaSecret!, requestFormCaptchaSecretAad(row!.id))).toBe(
      'top-secret-value',
    );
    // Turning it off forgets the keys.
    await save({ captchaProvider: null });
    const [off] = await app.db.select().from(requestForms).where(eq(requestForms.teamId, team.id));
    expect(off).toMatchObject({ captchaProvider: null, captchaSiteKey: null, captchaSecret: null });
  });

  it('a new link makes the old one stop working', async () => {
    const oldUrl = url();
    const res = await owner.post(`${ws}/teams/${team.id}/request-form/rotate-link`);
    expect(res.data.token).not.toBe(form.token);
    form = res.data;
    expect((await visitor().get(oldUrl)).statusCode).toBe(404);
    expect((await visitor().get(url())).statusCode).toBe(200);
  });
});

describe('the public form', () => {
  it('shows only what the form says: nothing about the team or workspace', async () => {
    const res = await visitor().get(url());
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.data).sort()).toEqual([
      'attachments',
      'captcha',
      'fields',
      'intro',
      'title',
    ]);
    expect(res.body).not.toMatch(/Secret Team|SEC|Hidden Workspace|forms/);
    expect(res.body).not.toContain(team.id);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a form that is off looks exactly like a link that never existed', async () => {
    await save({ enabled: false });
    const off = await visitor().get(url());
    const missing = await visitor().get('/api/forms/no-such-token');
    expect(off.statusCode).toBe(404);
    expect(off.body).toBe(missing.body);
    expect((await submit()).statusCode).toBe(404);
    expect(await titled('Off form')).toBeUndefined();
  });

  it('files a triage issue linked to a customer and a request', async () => {
    const res = await submit({ title: 'Please add CSV' });
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ ok: true });
    const issue = await detail('Please add CSV');
    expect(issue.stateId).toBe(stateOfType('triage'));
    expect(issue.description).toBe(valid.description);
    expect(issue.assigneeId).toBeNull();
    expect(issue.customerRequests).toHaveLength(1);
    expect(issue.customerRequests[0]).toMatchObject({
      source: 'form',
      contact: 'Ada Lovelace <ada@acme.example>',
      body: valid.description,
    });
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    expect(boot.customers.find((c) => c.id === issue.customerRequests[0]!.customerId)?.name).toBe(
      'Acme',
    );
  });

  it('does not hand the text to the default assignee on a team without triage', async () => {
    await owner.patch(`${ws}/teams/${otherTeam.id}`, {
      defaultAssigneeId: (await owner.get('/api/auth/me')).data.id,
    });
    const other = (await save({ enabled: true }, otherTeam.id)).data as RequestForm;
    const res = await visitor().post(`/api/forms/${other.token}`, { ...valid, title: 'No triage' });
    expect(res.statusCode).toBe(200);
    expect((await titled('No triage'))!.assigneeId).toBeNull();
  });

  it('answers land in the description; required ones and options are enforced', async () => {
    await save({
      fields: [
        { id: 'plan', label: 'Plan', type: 'select', required: true, options: ['Free', 'Team'] },
        { id: 'version', label: 'Version', type: 'text', required: false },
        { id: 'steps', label: 'Steps', type: 'textarea', required: false },
        { id: 'urgent', label: 'Urgent?', type: 'checkbox', required: false },
      ],
    });
    expect((await submit({ title: 'No plan' })).statusCode).toBe(400);
    expect((await submit({ title: 'Bad', answers: { plan: 'Gold' } })).statusCode).toBe(400);
    expect(await titled('No plan')).toBeUndefined();
    const ok = await submit({
      title: 'With answers',
      answers: { plan: 'Team', steps: 'One\ntwo', urgent: true, invented: 'ignored' },
    });
    expect(ok.statusCode).toBe(200);
    expect((await detail('With answers')).description).toBe(
      `${valid.description}\n\n**Plan:** Team\n\n**Steps:**\n\nOne\ntwo\n\n**Urgent?** yes`,
    );
  });

  it('validates what people type', async () => {
    expect((await submit({ email: 'nope' })).statusCode).toBe(400);
    expect((await submit({ title: '   ' })).statusCode).toBe(400);
    expect((await submit({ name: '' })).statusCode).toBe(400);
  });

  it('applies the template, keeping the customer text first and landing in triage', async () => {
    const label = (await owner.post(`${ws}/labels`, { name: 'Intake', color: '#22c55e' })).data;
    const template = await owner.post(`${ws}/templates`, {
      teamId: team.id,
      name: 'Request',
      title: 'Ignored title',
      description: '## Checklist',
      priority: 2,
      labelIds: [label.id],
      stateId: stateOfType('completed'),
    });
    await save({ templateId: template.data.id });
    await submit({ title: 'From template' });
    const issue = await detail('From template');
    expect(issue.description).toBe(`${valid.description}\n\n## Checklist`);
    expect(issue.priority).toBe(2);
    expect(issue.labelIds).toContain(label.id);
    expect(issue.stateId).toBe(stateOfType('triage'));
  });

  it('still takes the request when the template has gone stale', async () => {
    const label = (await owner.post(`${ws}/labels`, { name: 'Stale', color: '#22c55e' })).data;
    const template = await owner.post(`${ws}/templates`, {
      teamId: team.id,
      name: 'Stale',
      labelIds: [label.id],
    });
    await save({ templateId: template.data.id });
    await owner.del(`${ws}/labels/${label.id}`);
    expect((await submit({ title: 'Stale template' })).statusCode).toBe(200);
    expect((await detail('Stale template')).labelIds).toEqual([]);
  });

  it('counts as its own source for triage rules', async () => {
    const label = (await owner.post(`${ws}/labels`, { name: 'Public', color: '#22c55e' })).data;
    const rule = await owner.post(`${ws}/teams/${team.id}/triage-rules`, {
      name: 'From forms',
      conditions: { sources: ['form'] },
      actions: { labelIds: [label.id] },
    });
    expect(rule.statusCode).toBe(200);
    await submit({ title: 'Rule match' });
    expect((await detail('Rule match')).labelIds).toContain(label.id);
    await owner.del(`${ws}/triage-rules/${rule.data.id}`);
  });
});

describe('spam protection', () => {
  it('a filled-in honeypot gets the same answer but files nothing', async () => {
    const res = await submit({ title: 'Honeypot', website: 'http://spam.example' });
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ ok: true });
    expect(await titled('Honeypot')).toBeUndefined();
    await app.jobs.drain();
    expect(inbox).toEqual([]);
  });

  it('limits submissions per IP', async () => {
    const same = visitor();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await submit({ title: `Limit ${i}` }, same)).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
    expect((await submit({ title: 'Other address' })).statusCode).toBe(200);
  });

  it('limits a whole form, whatever the addresses', async () => {
    await submit({ title: 'Before the flood' });
    const issue = await titled('Before the flood');
    const [row] = await app.db.select().from(requestForms).where(eq(requestForms.id, form.id));
    await app.db.execute(sql`
      insert into request_form_submissions (workspace_id, form_id, issue_id, email, title, locale)
      select ${row!.workspaceId}::uuid, ${form.id}::uuid, ${issue!.id}::uuid, 'x@example.com', 'x', 'en'
      from generate_series(1, 100)`);
    const res = await submit({ title: 'Flooded' });
    expect(res.statusCode).toBe(429);
    expect(res.data.messageKey).toBe('request_form_busy');
    expect(await titled('Flooded')).toBeUndefined();
  });

  it('asks the CAPTCHA provider, and files nothing when it says no', async () => {
    const asked: unknown[][] = [];
    let verdict = false;
    app.verifyCaptcha = async (...args) => {
      asked.push(args);
      return verdict;
    };
    await save({
      captchaProvider: 'hcaptcha',
      captchaSiteKey: 'public-site-key',
      captchaSecret: 'hcaptcha-secret',
    });
    const shown = await visitor().get(url());
    expect(shown.data.captcha).toEqual({ provider: 'hcaptcha', siteKey: 'public-site-key' });
    expect(shown.body).not.toContain('hcaptcha-secret');

    const missing = await submit({ title: 'No token' });
    expect(missing.statusCode).toBe(400);
    expect(missing.data.messageKey).toBe('captcha_failed');
    expect(asked).toEqual([]);

    expect((await submit({ title: 'Bad token', captchaToken: 'bad' })).statusCode).toBe(400);
    expect(await titled('Bad token')).toBeUndefined();

    verdict = true;
    expect((await submit({ title: 'Good token', captchaToken: 'good' })).statusCode).toBe(200);
    expect(await titled('Good token')).toBeDefined();
    expect(asked.at(-1)?.slice(0, 3)).toEqual(['hcaptcha', 'hcaptcha-secret', 'good']);
  });
});

describe('attachments', () => {
  const file = { filename: 'notes.txt', body: Buffer.from('hello') };

  it('are refused unless the form takes them', async () => {
    const res = await multipart({ title: 'No files' }, [file]);
    expect(res.statusCode).toBe(400);
    expect(await titled('No files')).toBeUndefined();
  });

  it('end up on the issue', async () => {
    await save({ allowAttachments: true });
    const shown = await visitor().get(url());
    expect(shown.data.attachments).toEqual({ maxFiles: 5, maxFileMb: 10 });
    const res = await multipart({ title: 'With files' }, [
      file,
      { filename: 'evil.html', body: Buffer.from('<script>alert(1)</script>') },
    ]);
    expect(res.statusCode).toBe(200);
    const issue = await detail('With files');
    expect(issue.attachments.map((a) => a.filename).sort()).toEqual(['evil.html', 'notes.txt']);
    // Bytes decide the type, not the name.
    expect(issue.attachments.every((a) => a.contentType === 'application/octet-stream')).toBe(true);
  });

  it('have limits on size and count', async () => {
    await save({ allowAttachments: true });
    const big = await multipart({ title: 'Too big' }, [
      { filename: 'big.bin', body: Buffer.alloc(10 * 1024 * 1024 + 1) },
    ]);
    expect(big.statusCode).toBe(413);
    expect(big.json().messageKey).toBe('attachment_too_large');
    const many = await multipart(
      { title: 'Too many' },
      Array.from({ length: 6 }, (_, i) => ({ filename: `${i}.txt`, body: Buffer.from('x') })),
    );
    expect(many.statusCode).toBe(413);
    expect(await titled('Too big')).toBeUndefined();
    expect(await titled('Too many')).toBeUndefined();
  });

  it('are not saved for a submission that gets turned down', async () => {
    await save({ allowAttachments: true });
    const count = async () =>
      (
        (await app.db.execute(sql`select count(*)::int as n from files`)) as unknown as [
          { n: number },
        ]
      )[0].n;
    const before = await count();
    await multipart({ title: 'Trap', website: 'filled' }, [file]);
    expect(await count()).toBe(before);
  });

  it('keep a usable name whatever the filename holds', async () => {
    await save({ allowAttachments: true });
    const res = await multipart({ title: 'Odd names' }, [
      { filename: 'no\0tes.txt', body: Buffer.from('a') },
      { filename: '\0', body: Buffer.from('b') },
      { body: Buffer.from('c') },
    ]);
    expect(res.statusCode).toBe(200);
    const names = (await detail('Odd names')).attachments.map((a) => a.filename).sort();
    expect(names).toEqual(['file', 'file', 'notes.txt']);
  });

  it('leave nothing in storage when the file cannot be recorded', async () => {
    const put = vi.spyOn(app.storage, 'put');
    await expect(
      saveFile(app, {
        // No such workspace, so the insert fails after the bytes are stored.
        workspaceId: randomUUID(),
        ownerId: randomUUID(),
        kind: 'attachment',
        filename: 'notes.txt',
        body: Buffer.from('x'),
      }),
    ).rejects.toThrow();
    const key = put.mock.calls[0]![0];
    put.mockRestore();
    expect(await app.storage.get(key)).toBeNull();
  });
});

describe('NUL bytes, which Postgres cannot store', () => {
  it('make a token look like any other wrong link', async () => {
    const wrong = await visitor().get('/api/forms/nope');
    for (const res of [
      await visitor().get('/api/forms/%00'),
      await visitor().post('/api/forms/%00', valid),
      await visitor().get(`${url()}%00`),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.data).toEqual(wrong.data);
    }
  });

  it('are turned down in the text of a submission', async () => {
    for (const field of ['name', 'title', 'description']) {
      const res = await submit({ title: `NUL in ${field}`, [field]: 'a\0b' });
      expect(res.statusCode, field).toBe(400);
      expect(await titled(`NUL in ${field}`)).toBeUndefined();
    }
  });

  it('are turned down in answers to real questions', async () => {
    form = (
      await save({
        fields: [
          { id: 'plan', label: 'Plan', type: 'text', required: false },
          { id: 'why', label: 'Why', type: 'textarea', required: false },
        ],
      })
    ).data;
    for (const id of ['plan', 'why']) {
      const res = await submit({ title: `NUL in ${id}`, answers: { [id]: 'a\0b' } });
      expect(res.statusCode, id).toBe(400);
      expect(await titled(`NUL in ${id}`)).toBeUndefined();
    }
  });
});

describe('emails', () => {
  it('confirms without saying anything the submitter typed, or naming the team', async () => {
    await submit({ title: 'Buy cheap pills at spam.example', name: 'Visit spam.example' });
    await app.jobs.drain();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.to).toBe(valid.email);
    expect(inbox[0]!.text).toContain('Ask us anything');
    const all = JSON.stringify(inbox[0]);
    expect(all).not.toMatch(/spam\.example|Secret Team|SEC-|Hidden Workspace/);
  });

  it('can be turned off', async () => {
    await save({ confirmationEmail: false });
    await submit({ title: 'Quiet' });
    await app.jobs.drain();
    expect(inbox).toEqual([]);
  });

  it('stops confirming to one address after a few, but keeps the requests', async () => {
    for (let i = 0; i < 5; i++)
      expect((await submit({ title: `Bomb ${i}`, email: 'victim@acme.example' })).statusCode).toBe(
        200,
      );
    await app.jobs.drain();
    expect(inbox.filter((m) => m.to === 'victim@acme.example')).toHaveLength(3);
    expect(await titled('Bomb 4')).toBeDefined();
  });

  it('tells them once when it is done, under the title they gave it', async () => {
    await save({ doneEmail: true, confirmationEmail: false });
    await submit({ title: 'Finish me', locale: 'en' });
    const issue = (await titled('Finish me'))!;
    await owner.patch(`${ws}/issues/${issue.id}`, { title: 'Internal: rename this' });
    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: stateOfType('started') });
    await app.jobs.drain();
    expect(inbox).toEqual([]);

    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: stateOfType('completed') });
    await app.jobs.drain();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.text).toContain('Finish me');
    expect(inbox[0]!.text).not.toContain('Internal');
    expect(inbox[0]!.text).not.toContain(`SEC-${issue.number}`);

    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: stateOfType('started') });
    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: stateOfType('completed') });
    await app.jobs.drain();
    expect(inbox).toHaveLength(1);
  });

  it('sends the notice when a bulk change finishes the issue too', async () => {
    await save({ doneEmail: true, confirmationEmail: false });
    await submit({ title: 'Bulk finish' });
    const issue = (await titled('Bulk finish'))!;
    await runAutomation(app, issue.workspaceId, (ctx) =>
      bulkUpdateIssues(ctx, [issue.id], { stateId: stateOfType('completed') }),
    );
    await app.jobs.drain();
    expect(inbox.map((m) => m.subject)).toEqual(['Your request is done']);
  });

  it('sends no notice when the form does not want one, or for a cancelled issue', async () => {
    await save({ confirmationEmail: false });
    await submit({ title: 'No notice' });
    const issue = (await titled('No notice'))!;
    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: stateOfType('completed') });
    await save({ doneEmail: true });
    await submit({ title: 'Cancelled' });
    const canceled = (await titled('Cancelled'))!;
    await owner.patch(`${ws}/issues/${canceled.id}`, { stateId: stateOfType('canceled') });
    await app.jobs.drain();
    expect(inbox).toEqual([]);
  });
});
