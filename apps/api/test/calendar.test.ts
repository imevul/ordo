import type { Bootstrap, CalendarFeed } from '@ordo/shared';
import { and, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, calendarFeeds } from '../src/db/schema.ts';
import { escapeText, foldLine, renderCalendar } from '../src/services/calendar.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/calfeed';
const ids: Record<string, string> = {};

/** Fetches a feed URL the way a calendar app does: no cookie, no headers. */
const fetchFeed = (url: string) => app.inject({ method: 'GET', url: new URL(url).pathname });
const events = (ics: string) => ics.split('BEGIN:VEVENT').slice(1);
const summaries = (ics: string) =>
  events(ics).map((e) => /\r\nSUMMARY:(.*)\r\n/.exec(e)?.[1] ?? '');

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Celia Calowner')).client;
  await owner.post('/api/workspaces', {
    name: 'Cal Feed',
    slug: 'calfeed',
    teamName: 'Public',
    teamKey: 'CAL',
  });
  const token = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Milo Calmember', { inviteToken: token })).client;
  ids.owner = (await owner.get('/api/auth/me')).data.id;
  ids.member = (await member.get('/api/auth/me')).data.id;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  ids.pub = boot.teams[0]!.id;
  await owner.post(`${ws}/teams/${ids.pub}/members`, { userId: ids.member });
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Hidden', key: 'HID', private: true })
  ).data.id;
  await owner.post(`${ws}/teams/${ids.prv}/members`, { userId: ids.member });

  const issue = async (body: Record<string, unknown>) =>
    (await owner.post(`${ws}/issues`, body)).data;
  await issue({
    teamId: ids.pub,
    title: 'Ship the feed, finally; really',
    dueDate: '2026-11-20',
    assigneeId: ids.member,
  });
  await issue({ teamId: ids.pub, title: 'Not mine', dueDate: '2026-11-21' });
  await issue({ teamId: ids.pub, title: 'Mine without a date', assigneeId: ids.member });
  ids.secretIssue = (
    await issue({
      teamId: ids.prv,
      title: 'Secret due',
      dueDate: '2026-11-22',
      assigneeId: ids.member,
    })
  ).id;
  await owner.post(`${ws}/teams/${ids.pub}/cycles`, {
    startsAt: '2026-11-02',
    endsAt: '2026-11-15',
    name: 'Autumn',
  });
  const project = (await owner.post(`${ws}/projects`, { name: 'Launch', teamIds: [ids.pub] })).data;
  await owner.post(`${ws}/projects/${project.id}/milestones`, {
    name: 'Beta',
    targetDate: '2026-11-05',
  });
  await owner.post(`${ws}/projects/${project.id}/milestones`, { name: 'Someday' });
});

afterAll(() => app.close());

describe('iCalendar rendering', () => {
  it('escapes text and folds long lines at 75 octets without splitting characters', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const long = `SUMMARY:${'å'.repeat(60)}`;
    const folded = foldLine(long);
    for (const line of folded.split('\r\n'))
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('writes all-day events with an exclusive end date', () => {
    const ics = renderCalendar(
      'Test',
      [
        { uid: 'x@h', date: '2026-12-31', summary: 'NYE' },
        { uid: 'y@h', date: '2026-02-27', endDate: '2026-02-28', summary: 'Span' },
      ],
      new Date('2026-10-31T12:00:00.000Z'),
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTAMP:20261031T120000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260227\r\nDTEND;VALUE=DATE:20260301');
  });
});

describe('calendar feeds', () => {
  let personal: string;

  it('gives a secret URL, once, and lists the feed without it', async () => {
    const res = await member.post(`${ws}/calendar-feeds`, {});
    expect(res.statusCode).toBe(200);
    personal = res.data.url;
    expect(personal).toMatch(/\/api\/calendar\/ordo_cal_[\w-]+\.ics$/);
    const list = (await member.get(`${ws}/calendar-feeds`)).data as CalendarFeed[];
    expect(list).toHaveLength(1);
    expect(list[0]!.viewId).toBeNull();
    expect(JSON.stringify(list)).not.toContain(personal.split('/').pop()!.slice(13, -4));
    // Only the hash is stored.
    const [row] = await app.db
      .select()
      .from(calendarFeeds)
      .where(eq(calendarFeeds.id, list[0]!.id));
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(personal).not.toContain(row!.tokenHash);
    // The database keeps one personal feed per user and workspace, even for racing requests.
    await expect(
      app.db.insert(calendarFeeds).values({
        workspaceId: row!.workspaceId,
        userId: row!.userId,
        tokenHash: 'f'.repeat(64),
        prefix: 'ordo_cal_xxxx',
      }),
    ).rejects.toThrow();
  });

  it('serves my due dates, my teams’ cycles and milestones without a session', async () => {
    const res = await fetchFeed(personal);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    const ics = res.body;
    expect(summaries(ics)).toEqual(
      expect.arrayContaining([
        'CAL-1 Ship the feed\\, finally\\; really',
        'HID-1 Secret due',
        'CAL Cycle 1: Autumn',
        'Launch: Beta',
      ]),
    );
    expect(ics).not.toContain('Not mine');
    expect(ics).not.toContain('Mine without a date');
    expect(ics).not.toContain('Someday');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261116');
    expect(ics).toContain('/calfeed/issue/CAL-1');
  });

  it('follows the owner’s current team access', async () => {
    await owner.del(`${ws}/teams/${ids.prv}/members/${ids.member}`);
    const ics = (await fetchFeed(personal)).body;
    expect(ics).not.toContain('Secret due');
    expect(ics).toContain('CAL-1');
  });

  it('subscribes to a saved view', async () => {
    const view = (
      await owner.post(`${ws}/views`, {
        name: 'Due soon',
        shared: true,
        filters: { teamId: ids.pub },
      })
    ).data;
    const res = await member.post(`${ws}/calendar-feeds`, { viewId: view.id });
    expect(res.statusCode).toBe(200);
    const ics = (await fetchFeed(res.data.url)).body;
    expect(ics).toContain('X-WR-CALNAME:Due soon · Cal Feed');
    expect(summaries(ics).sort()).toEqual([
      'CAL-1 Ship the feed\\, finally\\; really',
      'CAL-2 Not mine',
    ]);

    // A private view of someone else can't be subscribed to.
    const hidden = (
      await owner.post(`${ws}/views`, { name: 'Mine only', shared: false, filters: {} })
    ).data;
    expect((await member.post(`${ws}/calendar-feeds`, { viewId: hidden.id })).statusCode).toBe(404);

    // Deleting the view ends its feed.
    await owner.del(`${ws}/views/${view.id}`);
    expect((await fetchFeed(res.data.url)).statusCode).toBe(404);
  });

  it('is replaced by creating a new one, and revoked', async () => {
    const next = (await member.post(`${ws}/calendar-feeds`, {})).data;
    expect((await fetchFeed(personal)).statusCode).toBe(404);
    expect((await fetchFeed(next.url)).statusCode).toBe(200);
    expect((await owner.del(`${ws}/calendar-feeds/${next.feed.id}`)).statusCode).toBe(404);
    expect((await member.del(`${ws}/calendar-feeds/${next.feed.id}`)).statusCode).toBe(200);
    expect((await fetchFeed(next.url)).statusCode).toBe(404);
    const logged = await app.db
      .select({ action: auditLog.action, data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.actorId, ids.member), like(auditLog.action, 'calendar_feed.%')));
    expect(logged.map((l) => l.action)).toEqual(
      expect.arrayContaining(['calendar_feed.created', 'calendar_feed.revoked']),
    );
    expect(logged.some((l) => (l.data as { via?: string }).via === 'replaced')).toBe(true);
  });

  it('stops for suspended members and unknown tokens', async () => {
    const { url } = (await member.post(`${ws}/calendar-feeds`, {})).data;
    await owner.patch(`${ws}/members/${ids.member}`, { suspended: true });
    expect((await fetchFeed(url)).statusCode).toBe(404);
    await owner.patch(`${ws}/members/${ids.member}`, { suspended: false });
    expect((await fetchFeed(url)).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/calendar/ordo_cal_nope.ics' })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/calendar/whatever' })).statusCode).toBe(
      404,
    );
  });

  it('is revoked with API keys after a password change', async () => {
    const { url } = (await member.post(`${ws}/calendar-feeds`, {})).data;
    const res = await member.post('/api/me/password', {
      currentPassword: 'correct horse battery',
      newPassword: 'correct horse battery staple',
      revokeCredentials: true,
    });
    expect(res.statusCode).toBe(200);
    expect((await fetchFeed(url)).statusCode).toBe(404);
  });
});
