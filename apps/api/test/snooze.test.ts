import type { Bootstrap, Notification } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications } from '../src/db/schema.ts';
import { wakeSnoozed } from '../src/services/notifications.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/snz';
const ids: Record<string, string> = {};

const inbox = async (c: Client, snoozed = false) =>
  (await c.get(`${ws}/notifications${snoozed ? '?snoozed=1' : ''}`)).data as Notification[];
const unread = async (c: Client) =>
  ((await c.get(`${ws}/bootstrap`)).data as Bootstrap).unreadCount;
const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Snz',
    slug: 'snz',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  member = (
    await signup(app, 'Mona Member', {
      inviteToken: (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token,
    })
  ).client;
  const memberId = (await member.get('/api/auth/me')).data.id;
  const teamId = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!.id;
  for (const title of ['First', 'Second'])
    await owner.post(`${ws}/issues`, { teamId, title, assigneeId: memberId });
  const list = await inbox(member);
  ids.first = list.find((n) => n.issue?.title === 'First')!.id;
  ids.second = list.find((n) => n.issue?.title === 'Second')!.id;
});

afterAll(() => app.close());

describe('notification snooze', () => {
  it('hides a notification until later, out of the unread count', async () => {
    expect(await unread(member)).toBe(2);
    const res = await member.post(`${ws}/notifications/snooze`, {
      ids: [ids.first],
      until: later(3),
    });
    expect(res.statusCode).toBe(200);
    expect((await inbox(member)).map((n) => n.id)).toEqual([ids.second]);
    expect((await inbox(member, true)).map((n) => n.id)).toEqual([ids.first]);
    expect(await unread(member)).toBe(1);
    const [row] = await app.db.select().from(notifications).where(eq(notifications.id, ids.first));
    expect(row!.emailedAt).not.toBeNull();
  });

  it('only touches your own notifications, and wants a real time', async () => {
    await owner.post(`${ws}/notifications/snooze`, { ids: [ids.second], until: later(3) });
    expect((await inbox(member)).map((n) => n.id)).toEqual([ids.second]);
    expect(
      (await member.post(`${ws}/notifications/snooze`, { ids: [ids.second], until: 'soon' }))
        .statusCode,
    ).toBe(400);
  });

  it('brings it back unread, on top, when the snooze ends', async () => {
    await member.post(`${ws}/notifications/read`, {});
    await app.db
      .update(notifications)
      .set({ snoozedUntil: sql`now() - interval '1 minute'` })
      .where(eq(notifications.id, ids.first));
    await wakeSnoozed(app);
    const list = await inbox(member);
    expect(list.map((n) => [n.id, n.readAt, n.snoozedUntil])).toEqual([
      [ids.first, null, null],
      [ids.second, expect.any(String), null],
    ]);
  });

  it('can be undone right away', async () => {
    await member.post(`${ws}/notifications/snooze`, { ids: [ids.second], until: later(24) });
    await member.post(`${ws}/notifications/snooze`, { ids: [ids.second], until: null });
    expect((await inbox(member)).map((n) => n.id)[0]).toBe(ids.second);
    expect(await inbox(member, true)).toEqual([]);
  });
});
