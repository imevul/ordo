import type { Bootstrap, Notification } from '@ordo/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs, notifications, pushSubscriptions, users } from '../src/db/schema.ts';
import { expireStatuses } from '../src/services/status.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/dlv';
const ids: Record<string, string> = {};

const inbox = async (c: Client, query = '') =>
  (await c.get(`${ws}/notifications${query}`)).data as Notification[];
const pushJobs = async () =>
  (
    await app.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.name, 'push.notify'))
  ).map((j) => (j.payload as { notificationId: string }).notificationId);
const newIssue = async (title: string, assign = true) =>
  (
    await owner.post(`${ws}/issues`, {
      teamId: ids.team,
      title,
      assigneeId: assign ? ids.member : undefined,
    })
  ).data as { id: string; identifier: string };

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Dlv',
    slug: 'dlv',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  member = (
    await signup(app, 'Mona Member', {
      inviteToken: (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token,
    })
  ).client;
  const me = (await member.get('/api/auth/me')).data;
  ids.member = me.id;
  ids.username = me.username;
  ids.team = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!.id;
  await app.db.insert(pushSubscriptions).values({
    userId: ids.member,
    endpoint: 'https://push.example.com/device',
    p256dh: 'x',
    auth: 'y',
  });
});

afterAll(() => app.close());

describe('notification delivery rules', () => {
  it('records why someone got a notification', async () => {
    const issue = await newIssue('Reasons');
    await owner.post(`${ws}/issues/${issue.id}/comments`, { body: `Hey @${ids.username}` });
    const list = (await inbox(member)).filter((n) => n.issueId === issue.id);
    expect(list.map((n) => [n.type, n.data.reason]).sort()).toEqual([
      ['issue_assigned', 'assignee'],
      ['issue_mention', 'mention'],
    ]);
  });

  it('creates nothing for a type turned off in the inbox, on any channel', async () => {
    await member.patch('/api/me/preferences', {
      notifications: { inbox: { issue_assigned: false } },
    });
    const before = (await pushJobs()).length;
    const issue = await newIssue('Quiet');
    expect((await inbox(member)).some((n) => n.issueId === issue.id)).toBe(false);
    expect((await pushJobs()).length).toBe(before);
    await member.patch('/api/me/preferences', {
      notifications: { inbox: { issue_assigned: true } },
    });
  });

  it('keeps it in the inbox but skips push when push is off for the type', async () => {
    await member.patch('/api/me/preferences', {
      notifications: { push: { issue_assigned: false } },
    });
    const issue = await newIssue('No push');
    const n = (await inbox(member)).find((x) => x.issueId === issue.id)!;
    expect(n).toBeDefined();
    expect(await pushJobs()).not.toContain(n.id);
    await member.patch('/api/me/preferences', {
      notifications: { push: { issue_assigned: true } },
    });
    const again = await newIssue('Push');
    const m = (await inbox(member)).find((x) => x.issueId === again.id)!;
    expect(await pushJobs()).toContain(m.id);
  });

  it('never pushes reactions, whatever the settings say', async () => {
    await member.patch('/api/me/preferences', {
      notifications: { push: { comment_reaction: true } },
    });
    const issue = await newIssue('Reacted', false);
    const comment = (await member.post(`${ws}/issues/${issue.id}/comments`, { body: 'Mine' })).data;
    await owner.req('PUT', `${ws}/comments/${comment.id}/reactions/${encodeURIComponent('👍')}`);
    const n = (await inbox(member)).find((x) => x.type === 'comment_reaction')!;
    expect(n).toBeDefined();
    expect(await pushJobs()).not.toContain(n.id);
    const rows = await app.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.name, 'push.notify'), sql`${jobs.payload}->>'notificationId' = ${n.id}`));
    expect(rows).toHaveLength(0);
  });

  it('saves and returns every channel', async () => {
    const res = await member.patch('/api/me/preferences', {
      notifications: { chat: { issue_comment: false }, inbox: { comment_reaction: false } },
    });
    expect(res.data.notifications.chat.issue_comment).toBe(false);
    expect(res.data.notifications.inbox.comment_reaction).toBe(false);
    expect(res.data.notifications.inbox.issue_mention).toBe(true);
    expect(
      (await member.patch('/api/me/preferences', { notifications: { push: { nope: true } } }))
        .statusCode,
    ).toBe(400);
  });
});

describe('inbox filters', () => {
  let other: Client;
  const mark: Record<string, string> = {};
  beforeAll(async () => {
    // A fresh person, so only this block's notifications are in their inbox.
    other = (
      await signup(app, 'Fia Filter', {
        inviteToken: (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token,
      })
    ).client;
    const me = (await other.get('/api/auth/me')).data;
    const a = (
      await owner.post(`${ws}/issues`, { teamId: ids.team, title: 'Urgent one', priority: 1 })
    ).data;
    const b = (
      await owner.post(`${ws}/issues`, { teamId: ids.team, title: 'Mine', assigneeId: me.id })
    ).data;
    await owner.post(`${ws}/issues/${a.id}/comments`, { body: `Look @${me.username}` });
    await other.post(`${ws}/issues/${a.id}/subscription`, { subscribed: true });
    await owner.post(`${ws}/issues/${a.id}/comments`, { body: 'Plain comment' });
    const list = await inbox(other);
    mark.mention = list.find((n) => n.type === 'issue_mention')!.id;
    mark.comment = list.find((n) => n.type === 'issue_comment')!.id;
    mark.assigned = list.find((n) => n.type === 'issue_assigned' && n.issueId === b.id)!.id;
  });

  const shown = async (query: string) => (await inbox(other, query)).map((n) => n.id).sort();

  it('narrows by type, reason, priority, unread and who did it', async () => {
    expect(await shown('?types=issue_mention')).toEqual([mark.mention]);
    expect(await shown('?types=issue_mention,issue_comment')).toEqual(
      [mark.mention, mark.comment].sort(),
    );
    expect(await shown('?reasons=assignee')).toEqual([mark.assigned]);
    expect(await shown('?priorities=1')).toEqual([mark.mention, mark.comment].sort());
    expect(await shown('?from=bots')).toEqual([]);
    expect((await shown('?from=people')).length).toBe(3);
    await other.post(`${ws}/notifications/read`, { ids: [mark.comment] });
    expect(await shown('?unread=1')).toEqual([mark.mention, mark.assigned].sort());
    expect((await other.get(`${ws}/notifications?types=nope`)).statusCode).toBe(400);
  });

  it('counts unread per type', async () => {
    const counts = (await other.get(`${ws}/notifications/counts`)).data;
    expect(counts).toEqual({ issue_mention: 1, issue_assigned: 1 });
  });

  it('marks read and deletes only what the filter matches', async () => {
    await other.post(`${ws}/notifications/read`, { filter: { types: ['issue_mention'] } });
    expect(await shown('?unread=1')).toEqual([mark.assigned]);
    await other.post(`${ws}/notifications/delete`, {
      read: true,
      filter: { types: ['issue_mention'] },
    });
    expect(await shown('')).toEqual([mark.comment, mark.assigned].sort());
    // Someone else's filter never reaches this person's notifications.
    await member.post(`${ws}/notifications/delete`, { read: true, filter: {} });
    expect(await shown('')).toEqual([mark.comment, mark.assigned].sort());
  });
});

describe('status and pause', () => {
  const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const memberOf = async (c: Client, id: string) =>
    ((await c.get(`${ws}/bootstrap`)).data as Bootstrap).members.find((m) => m.id === id)!;
  const lastFor = async (issueId: string) =>
    (await inbox(member)).find((n) => n.issueId === issueId)!;

  it('shows a status to others, but keeps the pause private', async () => {
    const until = later(48);
    expect(
      (
        await member.put('/api/me/status', {
          kind: 'vacation',
          text: 'Back Monday',
          until,
          pause: 'all',
        })
      ).statusCode,
    ).toBe(200);
    const seen = await memberOf(owner, ids.member!);
    expect(seen.status).toMatchObject({ kind: 'vacation', text: 'Back Monday' });
    expect(Date.parse(seen.status!.until!)).toBe(Date.parse(until));
    expect(JSON.stringify(seen)).not.toContain('notifyPause');
    const me = (await member.get('/api/auth/me')).data;
    expect(me.notifyPause).toMatchObject({ mode: 'all' });
    expect((await member.put('/api/me/status', { kind: null, until: null })).statusCode).toBe(400);
    expect(
      (await member.put('/api/me/status', { kind: 'away', until: later(-1) })).statusCode,
    ).toBe(400);
  });

  it('mute: keeps everything in the inbox, sends nothing', async () => {
    const issue = await newIssue('While away');
    const n = await lastFor(issue.id);
    expect(n).toBeDefined();
    expect(await pushJobs()).not.toContain(n.id);
    const [row] = await app.db.select().from(notifications).where(eq(notifications.id, n.id));
    expect(row!.emailedAt).not.toBeNull();
  });

  it('only mentions: lets mentions through and holds the rest', async () => {
    await member.put('/api/me/notify-pause', { mode: 'mentions', until: null });
    const issue = await newIssue('Focus time');
    expect(await pushJobs()).not.toContain((await lastFor(issue.id)).id);
    await owner.post(`${ws}/issues/${issue.id}/comments`, { body: `Need you @${ids.username}` });
    const mention = (await inbox(member)).find(
      (n) => n.issueId === issue.id && n.type === 'issue_mention',
    )!;
    expect(await pushJobs()).toContain(mention.id);
  });

  it('clearing the status ends the pause that came with it, not one set on its own', async () => {
    await member.put('/api/me/status', { kind: 'dnd', until: later(2), pause: 'all' });
    await member.del('/api/me/status');
    let me = (await member.get('/api/auth/me')).data;
    expect(me.status).toBeNull();
    expect(me.notifyPause).toBeNull();
    await member.put('/api/me/status', { kind: 'away', until: later(1) });
    await member.put('/api/me/notify-pause', { mode: 'all', until: later(3) });
    await member.del('/api/me/status');
    me = (await member.get('/api/auth/me')).data;
    expect(me.notifyPause).toMatchObject({ mode: 'all' });
    await member.put('/api/me/notify-pause', { mode: null, until: null });
  });

  it('expires statuses and pauses on time', async () => {
    await member.put('/api/me/status', { kind: 'focus', until: later(1), pause: 'mentions' });
    await app.db
      .update(users)
      .set({ statusUntil: later(-1), notifyPauseUntil: later(-1) })
      .where(eq(users.id, ids.member!));
    // Read as gone even before the job runs…
    expect((await memberOf(owner, ids.member!)).status).toBeNull();
    const issue = await newIssue('Back again');
    expect(await pushJobs()).toContain((await lastFor(issue.id)).id);
    // …and cleared by it.
    await expireStatuses(app);
    const [row] = await app.db.select().from(users).where(eq(users.id, ids.member!));
    expect(row).toMatchObject({ statusKind: null, notifyPause: null });
  });
});
