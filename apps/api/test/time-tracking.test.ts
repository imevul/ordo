import type { Bootstrap, IssueTime, RunningTimer, TimeEntry, TimeReport } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let other: Client;
let guest: Client;
let key: string;
const ws = '/api/w/time';
const ids: Record<string, string> = {};

/** Calls an MCP tool as the member and returns its parsed output (or the error text). */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `${ws}/mcp`,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const { content, isError } = res.json().result;
  return isError ? { error: content[0].text as string } : JSON.parse(content[0].text);
}

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Tove Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Time',
    slug: 'time',
    teamName: 'Pub',
    teamKey: 'TPUB',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  member = (await signup(app, 'Tilda Member', { inviteToken: await invite('member') })).client;
  other = (await signup(app, 'Tor Other', { inviteToken: await invite('member') })).client;
  guest = (await signup(app, 'Tage Guest', { inviteToken: await invite('guest') })).client;
  for (const [k, c] of Object.entries({ owner, member, other, guest }))
    ids[k] = (await c.get('/api/auth/me')).data.id;
  await member.patch('/api/me', { username: 'tilda-time' });
  key = (await member.post('/api/me/api-keys', { name: 'time' })).data.token;
  const boot: Bootstrap = (await owner.get(`${ws}/bootstrap`)).data;
  ids.pub = boot.teams[0]!.id;
  await owner.post(`${ws}/teams/${ids.pub}/members`, { userId: ids.guest });
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'TPRV', private: true })
  ).data.id;
  ids.project = (
    await owner.post(`${ws}/projects`, { name: 'Billable', teamIds: [ids.pub] })
  ).data.id;
  ids.issue = (
    await owner.post(`${ws}/issues`, {
      teamId: ids.pub,
      title: 'Build invoices',
      projectId: ids.project,
    })
  ).data.id;
  ids.second = (await owner.post(`${ws}/issues`, { teamId: ids.pub, title: 'Fix login' })).data.id;
  ids.secret = (await owner.post(`${ws}/issues`, { teamId: ids.prv, title: 'Secret' })).data.id;
});

afterAll(() => app.close());

describe('time tracking', () => {
  it('is off until a workspace admin turns it on', async () => {
    const off = await member.get(`${ws}/issues/${ids.issue}/time-entries`);
    expect(off.statusCode).toBe(403);
    expect(off.data.messageKey).toBe('time_tracking_off');
    expect(
      (await member.post(`${ws}/issues/${ids.issue}/time-entries`, { durationSeconds: 60 }))
        .statusCode,
    ).toBe(403);
    expect((await member.get(`${ws}/time-entries/report`)).statusCode).toBe(403);

    expect((await member.patch(ws, { settings: { timeTracking: true } })).statusCode).toBe(403);
    const on = await owner.patch(ws, {
      settings: { timeTracking: true, timezone: 'Europe/Stockholm' },
    });
    expect(on.statusCode).toBe(200);
    expect(on.data.settings.timeTracking).toBe(true);
    const log = JSON.stringify((await owner.get(`${ws}/audit-log?category=workspace`)).data);
    expect(log).toContain('timeTracking');
  });

  it('logs time by hand on issues people can see', async () => {
    const res = await member.post(`${ws}/issues/${ids.issue}/time-entries`, {
      durationSeconds: 5400,
      note: 'Invoice layout',
    });
    expect(res.statusCode).toBe(200);
    const entry = res.data as TimeEntry;
    expect(entry).toMatchObject({
      userId: ids.member,
      durationSeconds: 5400,
      note: 'Invoice layout',
    });
    // It ended now.
    expect(Date.now() - new Date(entry.startedAt).getTime()).toBeGreaterThanOrEqual(5_399_000);
    ids.memberEntry = entry.id;

    expect(
      (await member.post(`${ws}/issues/${ids.issue}/time-entries`, { durationSeconds: 0 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await member.post(`${ws}/issues/${ids.secret}/time-entries`, { durationSeconds: 60 }))
        .statusCode,
    ).toBe(404);
    expect((await member.get(`${ws}/issues/${ids.secret}/time-entries`)).statusCode).toBe(404);

    const time = (await other.get(`${ws}/issues/${ids.issue}/time-entries`)).data as IssueTime;
    expect(time.totalSeconds).toBe(5400);
    expect(time.entries.map((e) => e.id)).toEqual([ids.memberEntry]);
  });

  it('runs one timer per person, stopping the old one on start', async () => {
    expect((await member.get(`${ws}/timer`)).data).toBeNull();
    const first = (await member.post(`${ws}/issues/${ids.issue}/timer`, {})).data as TimeEntry;
    expect(first.durationSeconds).toBeNull();
    const running = (await member.get(`${ws}/timer`)).data as RunningTimer;
    expect(running.entry.id).toBe(first.id);
    expect(running.issue.identifier).toBe('TPUB-1');

    const second = (await member.post(`${ws}/issues/${ids.second}/timer`, { note: 'Login' }))
      .data as TimeEntry;
    const issueTime = (await member.get(`${ws}/issues/${ids.issue}/time-entries`))
      .data as IssueTime;
    expect(issueTime.entries.find((e) => e.id === first.id)!.durationSeconds).toBeGreaterThan(0);
    expect((await member.get(`${ws}/timer`)).data.entry.id).toBe(second.id);
    // Running timers don't count towards the total.
    expect(
      ((await member.get(`${ws}/issues/${ids.second}/time-entries`)).data as IssueTime)
        .totalSeconds,
    ).toBe(0);

    // Someone else's timer is their own.
    expect((await other.get(`${ws}/timer`)).data).toBeNull();
    const stopped = await member.post(`${ws}/timer/stop`, {});
    expect(stopped.statusCode).toBe(200);
    expect(stopped.data.id).toBe(second.id);
    expect(stopped.data.durationSeconds).toBeGreaterThanOrEqual(1);
    const again = await member.post(`${ws}/timer/stop`, {});
    expect(again.statusCode).toBe(404);
    expect(again.data.messageKey).toBe('no_timer');
    // Clean up the two short timer entries so the report below has round numbers.
    await member.del(`${ws}/time-entries/${first.id}`);
    await member.del(`${ws}/time-entries/${second.id}`);
  });

  it('lets people change their own entries, and admins anyone’s (audited)', async () => {
    const theirs = await other.patch(`${ws}/time-entries/${ids.memberEntry}`, { note: 'Mine now' });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.data.messageKey).toBe('own_time_entries');
    expect((await other.del(`${ws}/time-entries/${ids.memberEntry}`)).statusCode).toBe(403);

    const own = await member.patch(`${ws}/time-entries/${ids.memberEntry}`, {
      note: 'Invoice layout and totals',
      startedAt: '2026-03-02T09:00:00Z',
    });
    expect(own.statusCode).toBe(200);
    expect(own.data).toMatchObject({ note: 'Invoice layout and totals', durationSeconds: 5400 });

    const fixed = await owner.patch(`${ws}/time-entries/${ids.memberEntry}`, {
      durationSeconds: 3600,
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.data.durationSeconds).toBe(3600);
    const log = JSON.stringify((await owner.get(`${ws}/audit-log?category=workspace`)).data);
    expect(log).toContain('time_entry.updated');

    const mistake = (
      await other.post(`${ws}/issues/${ids.issue}/time-entries`, { durationSeconds: 60 })
    ).data as TimeEntry;
    expect((await owner.del(`${ws}/time-entries/${mistake.id}`)).statusCode).toBe(200);
    expect(JSON.stringify((await owner.get(`${ws}/audit-log`)).data)).toContain(
      'time_entry.deleted',
    );
  });

  it('reports by person, project and day, as JSON or CSV', async () => {
    // 23:30 UTC is already the next day in Stockholm.
    await other.post(`${ws}/issues/${ids.second}/time-entries`, {
      durationSeconds: 1800,
      startedAt: '2026-03-02T23:30:00Z',
      note: 'Late, "quoted", fix',
    });
    await owner.post(`${ws}/issues/${ids.secret}/time-entries`, {
      durationSeconds: 7200,
      startedAt: '2026-03-02T10:00:00Z',
    });

    const all = (await owner.get(`${ws}/time-entries/report?from=2026-03-01&to=2026-03-31`))
      .data as TimeReport;
    expect(all.totalSeconds).toBe(3600 + 1800 + 7200);
    expect(all.byUser).toEqual([
      { userId: ids.owner, seconds: 7200 },
      { userId: ids.member, seconds: 3600 },
      { userId: ids.other, seconds: 1800 },
    ]);
    expect(all.entries.map((e) => e.date)).toEqual(['2026-03-02', '2026-03-02', '2026-03-03']);

    // Members don't see time on issues they can't read.
    const seen = (await member.get(`${ws}/time-entries/report`)).data as TimeReport;
    expect(seen.totalSeconds).toBe(3600 + 1800);

    const q = (s: string) =>
      owner.get(`${ws}/time-entries/report?${s}`).then((r) => r.data as TimeReport);
    expect((await q(`userId=${ids.other}`)).totalSeconds).toBe(1800);
    expect((await q(`projectId=${ids.project}`)).totalSeconds).toBe(3600);
    expect((await q('projectId=none')).totalSeconds).toBe(1800 + 7200);
    expect((await q(`teamId=${ids.prv}`)).totalSeconds).toBe(7200);
    expect((await q('from=2026-03-03')).totalSeconds).toBe(1800);
    expect((await q('to=2026-03-02')).totalSeconds).toBe(3600 + 7200);
    expect((await owner.get(`${ws}/time-entries/report?from=March`)).statusCode).toBe(400);

    const csv = await owner.get(`${ws}/time-entries/report?format=csv&teamId=${ids.pub}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe(
      'Date,Person,Email,Issue,Title,Project,Cycle,Hours,Minutes,Note,Started at',
    );
    expect(lines[1]).toMatch(
      /^2026-03-02,Tilda Member,\S+,TPUB-1,Build invoices,Billable,,1\.00,60,/,
    );
    expect(lines[2]).toContain('0.50,30,"Late, ""quoted"", fix"');
  });

  it('shows guests only their own time', async () => {
    expect(
      (await guest.post(`${ws}/issues/${ids.issue}/time-entries`, { durationSeconds: 600 }))
        .statusCode,
    ).toBe(200);
    const report = (await guest.get(`${ws}/time-entries/report`)).data as TimeReport;
    expect(report.entries.map((e) => e.userId)).toEqual([ids.guest]);
    // The member's hour on the same issue stays out of the guest's view and total.
    const onIssue = (await guest.get(`${ws}/issues/${ids.issue}/time-entries`)).data as IssueTime;
    expect(onIssue.entries.map((e) => e.userId)).toEqual([ids.guest]);
    expect(onIssue.totalSeconds).toBe(600);
    const forMember = (await member.get(`${ws}/issues/${ids.issue}/time-entries`))
      .data as IssueTime;
    expect(forMember.totalSeconds).toBe(3600 + 600);
  });

  it('answers 409, not 500, when two timer starts race', async () => {
    const starts = await Promise.all(
      [1, 2, 3].map(() => other.post(`${ws}/issues/${ids.second}/timer`, {})),
    );
    for (const res of starts) {
      expect([200, 409]).toContain(res.statusCode);
      if (res.statusCode === 409) expect(res.data.messageKey).toBe('timer_conflict');
    }
    const stopped = await other.post(`${ws}/timer/stop`, {});
    expect(stopped.statusCode).toBe(200);
    expect((await other.get(`${ws}/timer`)).data).toBeNull();
    for (const res of starts)
      if (res.statusCode === 200) await other.del(`${ws}/time-entries/${res.data.id}`);
  });

  it('neutralises formulas in the CSV', async () => {
    const entry = (
      await other.post(`${ws}/issues/${ids.second}/time-entries`, {
        durationSeconds: 60,
        startedAt: '2026-04-01T10:00:00Z',
        note: '=HYPERLINK("http://evil.test","Click")',
      })
    ).data as TimeEntry;
    const csv = await owner.get(
      `${ws}/time-entries/report?format=csv&from=2026-04-01&to=2026-04-01`,
    );
    expect(csv.body).toContain(`"'=HYPERLINK(""http://evil.test"",""Click"")"`);
    await other.del(`${ws}/time-entries/${entry.id}`);
  });

  it('works over MCP', async () => {
    const logged = await tool('log_time', {
      issue: 'TPUB-2',
      duration: '1h 15m',
      note: 'Reproduced it',
      date: '2026-03-04',
    });
    expect(logged).toMatchObject({ person: 'tilda-time', time: '1h 15m', seconds: 4500 });
    expect((await tool('log_time', { issue: 'TPUB-2', duration: 'a while' })).error).toContain(
      'not a duration',
    );
    expect(await tool('start_timer', { issue: 'TPUB-1' })).toMatchObject({ time: 'running' });
    expect((await tool('stop_timer')).seconds).toBeGreaterThanOrEqual(1);
    const time = await tool('issue_time', { issue: 'TPUB-2' });
    expect(time.entries.some((e: { note?: string }) => e.note === 'Reproduced it')).toBe(true);
    const report = await tool('time_report', {
      from: '2026-03-04',
      to: '2026-03-04',
      person: 'me',
    });
    expect(report).toMatchObject({
      total: '1h 15m',
      byPerson: [{ person: 'tilda-time', seconds: 4500 }],
      entries: [{ date: '2026-03-04', issue: 'TPUB-2' }],
    });
  });

  it('logs a past day over MCP on that day in zones far east of UTC', async () => {
    await owner.patch(ws, { settings: { timezone: 'Pacific/Kiritimati' } });
    try {
      await tool('log_time', { issue: 'TPUB-2', duration: '10m', date: '2026-05-06' });
      const report = await tool('time_report', {
        from: '2026-05-06',
        to: '2026-05-06',
        person: 'me',
      });
      expect(report).toMatchObject({ total: '10m', entries: [{ date: '2026-05-06' }] });
    } finally {
      await owner.patch(ws, { settings: { timezone: 'Europe/Stockholm' } });
    }
  });

  it('asks for a team when a cycle name matches cycles in several teams', async () => {
    const other2 = (await owner.post(`${ws}/teams`, { name: 'Second', key: 'TSEC' })).data.id;
    for (const team of [ids.pub, other2])
      expect(
        (
          await owner.post(`${ws}/teams/${team}/cycles`, {
            name: 'Sprint',
            startsAt: '2026-06-01',
            endsAt: '2026-06-15',
          })
        ).statusCode,
      ).toBe(200);
    await owner.post(`${ws}/teams/${other2}/members`, { userId: ids.member });
    expect((await tool('time_report', { cycle: 'Sprint' })).error).toContain('give a team');
    expect(await tool('time_report', { cycle: 'Sprint', team: 'TPUB' })).toMatchObject({
      total: expect.any(String),
    });
  });
});
