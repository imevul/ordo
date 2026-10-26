import type { Attachment, IssueDetail } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachments, files } from '../src/db/schema.ts';
import { sweepAttachments } from '../src/services/attachments.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let insider: Client;
const ws = '/api/w/att';
const ids: Record<string, string> = {};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const detail = async (c: Client, id: string) =>
  (await c.get(`${ws}/issues/${id}`)).data as IssueDetail;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Att',
    slug: 'att',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async () => (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite() })).client;
  insider = (await signup(app, 'Ines Insider', { inviteToken: await invite() })).client;
  const prv = (await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true }))
    .data;
  const insiderId = (await insider.get('/api/auth/me')).data.id;
  await owner.post(`${ws}/teams/${prv.id}/members`, { userId: insiderId });
  const boot = (await owner.get(`${ws}/bootstrap`)).data;
  ids.pub = boot.teams.find((t: { key: string }) => t.key === 'PUB').id;
  ids.prv = prv.id;
  ids.secret = (await owner.post(`${ws}/issues`, { teamId: ids.prv, title: 'Secret' })).data.id;
  ids.open = (await owner.post(`${ws}/issues`, { teamId: ids.pub, title: 'Open' })).data.id;
});

afterAll(() => app.close());

describe('attachments', () => {
  it('uploads to an issue and serves it to people who can read the issue', async () => {
    const res = await insider.upload(`${ws}/attachments?issueId=${ids.secret}`, 'dot.png', PNG);
    expect(res.statusCode).toBe(200);
    const att = res.data as Attachment;
    expect(att).toMatchObject({
      issueId: ids.secret,
      filename: 'dot.png',
      contentType: 'image/png',
    });
    expect(att.url).toBe(`/api/attachments/${att.id}`);
    expect((await detail(owner, ids.secret)).attachments.map((a) => a.id)).toEqual([att.id]);

    const got = await owner.get(att.url);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['content-disposition']).toMatch(/^inline/);
    expect(got.rawPayload.equals(PNG)).toBe(true);

    // Not in the private team, not in the workspace, not signed in.
    expect((await member.get(att.url)).statusCode).toBe(404);
    const outsider = (await signup(app, 'Otto Outsider')).client;
    expect((await outsider.get(att.url)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: att.url })).statusCode).toBe(401);
    // Nor can they upload to the issue.
    expect(
      (await member.upload(`${ws}/attachments?issueId=${ids.secret}`, 'x.png', PNG)).statusCode,
    ).toBe(404);
  });

  it('downloads files that are not images, whatever they claim to be', async () => {
    const html = Buffer.from('<script>alert(1)</script>');
    const att = (
      await member.upload(`${ws}/attachments?issueId=${ids.open}`, 'x.html', html, 'text/html')
    ).data as Attachment;
    expect(att.contentType).toBe('application/octet-stream');
    const got = await member.get(att.url);
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''x\.html/);
    expect(got.headers['content-security-policy']).toContain('sandbox');
  });

  it('keeps uploads for a new issue private until a description claims them', async () => {
    const att = (await member.upload(`${ws}/attachments`, 'draft.png', PNG)).data as Attachment;
    expect(att.issueId).toBeNull();
    expect((await member.get(att.url)).statusCode).toBe(200);
    expect((await owner.get(att.url)).statusCode).toBe(404);

    // Someone else referencing the URL doesn't claim it.
    const other = (
      await owner.post(`${ws}/issues`, {
        teamId: ids.pub,
        title: 'Copycat',
        description: `![x](${att.url})`,
      })
    ).data;
    expect((await detail(owner, other.id)).attachments).toEqual([]);

    const issue = (
      await member.post(`${ws}/issues`, {
        teamId: ids.pub,
        title: 'With a picture',
        description: `Look: ![draft.png](${att.url})`,
      })
    ).data;
    expect((await detail(member, issue.id)).attachments.map((a) => a.id)).toEqual([att.id]);
    expect((await owner.get(att.url)).statusCode).toBe(200);
  });

  it('claims uploads referenced in comments and description edits', async () => {
    const a = (await member.upload(`${ws}/attachments`, 'a.png', PNG)).data as Attachment;
    const b = (await member.upload(`${ws}/attachments`, 'b.png', PNG)).data as Attachment;
    await member.post(`${ws}/issues/${ids.open}/comments`, {
      body: `see https://ordo.example${a.url}`,
    });
    await member.patch(`${ws}/issues/${ids.open}`, { description: `[b](${b.url})` });
    const names = (await detail(member, ids.open)).attachments.map((x) => x.filename);
    expect(names).toEqual(expect.arrayContaining(['a.png', 'b.png']));
  });

  it('lets uploaders and admins remove attachments, and sweeps the files', async () => {
    const att = (await member.upload(`${ws}/attachments?issueId=${ids.open}`, 'gone.png', PNG))
      .data as Attachment;
    expect((await insider.del(`${ws}/attachments/${att.id}`)).statusCode).toBe(403);
    expect((await member.del(`${ws}/attachments/${att.id}`)).statusCode).toBe(200);
    expect((await member.get(att.url)).statusCode).toBe(404);

    const admins = (await member.upload(`${ws}/attachments?issueId=${ids.open}`, 'x.png', PNG))
      .data as Attachment;
    expect((await owner.del(`${ws}/attachments/${admins.id}`)).statusCode).toBe(200);
  });

  it('sweeps unclaimed uploads after a day and files whose attachment is gone', async () => {
    const att = (await member.upload(`${ws}/attachments`, 'stale.png', PNG)).data as Attachment;
    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, att.id));
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await app.db.update(attachments).set({ createdAt: old }).where(eq(attachments.id, att.id));
    await app.db.update(files).set({ createdAt: old }).where(eq(files.id, row!.fileId));
    await sweepAttachments(app);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, att.id))).toEqual([]);
    expect(await app.db.select().from(files).where(eq(files.id, row!.fileId))).toEqual([]);
  });

  it('enforces the size limit', async () => {
    await app.settings.set('maxAttachmentMb', 1, null);
    try {
      const big = Buffer.alloc(1024 * 1024 + 10, 1);
      const res = await member.upload(`${ws}/attachments?issueId=${ids.open}`, 'big.bin', big);
      expect(res.statusCode).toBe(413);
      expect(res.data.message).toContain('1 MB');
    } finally {
      await app.settings.set('maxAttachmentMb', 25, null);
    }
  });
});
