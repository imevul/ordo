import type { Bootstrap, Issue, IssueDetail, Notification, RealtimeEvent } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAccess } from '../src/services/access.ts';
import { type Client, signup, testApp } from './helpers.ts';

/**
 * Access matrix. One workspace with a public team (PUB) and a private team (PRV):
 *   owner, admin            — see everything
 *   insider                 — member of PRV
 *   member                  — plain member, sees PUB only
 *   guest                   — guest added to PUB only
 *   outsider                — not in the workspace
 */
let app: FastifyInstance;
const ws = '/api/w/acl';
const c: Record<'owner' | 'admin' | 'insider' | 'member' | 'guest' | 'outsider', Client> =
  {} as never;
const ids: Record<string, string> = {};
let boot: Bootstrap;

const ALLOWED = ['owner', 'admin', 'insider'] as const;
const DENIED = ['member', 'guest'] as const;

async function invite(role: 'admin' | 'member' | 'guest') {
  return (await c.owner.post(`${ws}/invites`, { role })).data[0].token as string;
}

beforeAll(async () => {
  app = await testApp();
  c.owner = (await signup(app, 'Olga Owner')).client;
  await c.owner.post('/api/workspaces', {
    name: 'ACL',
    slug: 'acl',
    teamName: 'Public',
    teamKey: 'PUB',
  });
  c.admin = (await signup(app, 'Adam Admin', { inviteToken: await invite('admin') })).client;
  c.insider = (await signup(app, 'Ines Insider', { inviteToken: await invite('member') })).client;
  c.member = (await signup(app, 'Mona Member', { inviteToken: await invite('member') })).client;
  c.guest = (await signup(app, 'Gus Guest', { inviteToken: await invite('guest') })).client;
  c.outsider = (await signup(app, 'Otto Outsider')).client;
  for (const k of Object.keys(c) as (keyof typeof c)[])
    ids[k] = (await c[k].get('/api/auth/me')).data.id;

  const prv = (await c.owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true }))
    .data;
  boot = (await c.owner.get(`${ws}/bootstrap`)).data;
  ids.pub = boot.teams.find((t) => t.key === 'PUB')!.id;
  ids.prv = prv.id;
  expect(
    (await c.owner.post(`${ws}/teams/${ids.prv}/members`, { userId: ids.insider })).statusCode,
  ).toBe(200);
  expect(
    (await c.owner.post(`${ws}/teams/${ids.pub}/members`, { userId: ids.guest })).statusCode,
  ).toBe(200);

  const label = (
    await c.owner.post(`${ws}/labels`, { name: 'Classified', color: '#ef4444', teamId: ids.prv })
  ).data;
  ids.label = label.id;
  ids.secretProject = (
    await c.owner.post(`${ws}/projects`, { name: 'Secret plan', teamIds: [ids.prv] })
  ).data.id;
  ids.mixedProject = (
    await c.owner.post(`${ws}/projects`, { name: 'Mixed bag', teamIds: [ids.pub, ids.prv] })
  ).data.id;
  ids.cycle = (
    await c.owner.post(`${ws}/teams/${ids.prv}/cycles`, {
      startsAt: '2026-01-01',
      endsAt: '2026-01-15',
    })
  ).data.id;

  const priv = (
    await c.owner.post(`${ws}/issues`, {
      teamId: ids.prv,
      title: 'Zebra classified launch',
      labelIds: [ids.label],
      projectId: ids.mixedProject,
      cycleId: ids.cycle,
      assigneeId: ids.insider,
    })
  ).data as Issue;
  ids.priv = priv.id;
  const pub = (
    await c.owner.post(`${ws}/issues`, {
      teamId: ids.pub,
      title: 'Public roadmap',
      projectId: ids.mixedProject,
    })
  ).data as Issue;
  ids.pubIssue = pub.id;
  ids.relation = (
    await c.owner.post(`${ws}/issues/${pub.id}/relations`, {
      type: 'blocked_by',
      relatedIssueId: priv.id,
    })
  ).data.id;
});

afterAll(() => app.close());

describe('private team issues', () => {
  const reads = (who: keyof typeof c) => [
    c[who].get(`${ws}/issues/PRV-1`),
    c[who].get(`${ws}/issues/${ids.priv}/history`),
    c[who].get(`${ws}/issues/${ids.priv}/comments`),
  ];

  it('are readable by owner, admin and team members only', async () => {
    for (const who of ALLOWED)
      for (const r of await Promise.all(reads(who))) expect(r.statusCode, who).toBe(200);
    for (const who of DENIED)
      for (const r of await Promise.all(reads(who))) expect(r.statusCode, who).toBe(404);
    expect((await c.outsider.get(`${ws}/issues/PRV-1`)).statusCode).toBe(404);
  });

  it('are writable by the same people only', async () => {
    for (const who of DENIED) {
      expect(
        (await c[who].patch(`${ws}/issues/${ids.priv}`, { priority: 1 })).statusCode,
        who,
      ).toBe(404);
      expect(
        (await c[who].post(`${ws}/issues/${ids.priv}/comments`, { body: 'hi' })).statusCode,
        who,
      ).toBe(404);
      expect((await c[who].post(`${ws}/issues/${ids.priv}/subscription`)).statusCode, who).toBe(
        404,
      );
      expect(
        (await c[who].post(`${ws}/issues/batch`, { ids: [ids.priv], patch: { priority: 2 } }))
          .statusCode,
        who,
      ).toBe(404);
      expect(
        (await c[who].post(`${ws}/issues/batch-delete`, { ids: [ids.priv] })).statusCode,
        who,
      ).toBe(404);
      expect((await c[who].del(`${ws}/issues/${ids.priv}`)).statusCode, who).toBe(404);
      expect(
        (await c[who].post(`${ws}/issues`, { teamId: ids.prv, title: 'sneaky' })).statusCode,
        who,
      ).toBe(404);
      expect((await c[who].del(`${ws}/relations/${ids.relation}`)).statusCode, who).toBe(404);
    }
    for (const who of ALLOWED) {
      expect(
        (await c[who].patch(`${ws}/issues/${ids.priv}`, { priority: 3 })).statusCode,
        who,
      ).toBe(200);
      expect(
        (await c[who].post(`${ws}/issues/${ids.priv}/comments`, { body: `ok from ${who}` }))
          .statusCode,
        who,
      ).toBe(200);
    }
  });

  it("can't be reached sideways: moves, parents, relations, assignees", async () => {
    expect(
      (await c.member.patch(`${ws}/issues/${ids.pubIssue}`, { teamId: ids.prv })).statusCode,
    ).toBe(404);
    expect(
      (await c.member.patch(`${ws}/issues/${ids.pubIssue}`, { parentId: ids.priv })).statusCode,
    ).toBe(400);
    expect(
      (
        await c.member.post(`${ws}/issues/${ids.pubIssue}/relations`, {
          type: 'related',
          relatedIssueId: ids.priv,
        })
      ).statusCode,
    ).toBe(404);
    // Assigning a private-team issue to someone who can't see the team is refused.
    expect(
      (await c.owner.patch(`${ws}/issues/${ids.priv}`, { assigneeId: ids.member })).statusCode,
    ).toBe(400);
    expect(
      (await c.owner.patch(`${ws}/issues/${ids.priv}`, { assigneeId: ids.insider })).statusCode,
    ).toBe(200);
  });

  it('are absent from lists, search, relations and detail references', async () => {
    const titles = async (who: keyof typeof c) =>
      ((await c[who].post(`${ws}/issues/query`, { filter: {} })).data as Issue[]).map(
        (i) => i.title,
      );
    for (const who of ALLOWED) expect(await titles(who), who).toContain('Zebra classified launch');
    for (const who of DENIED)
      expect(await titles(who), who).not.toContain('Zebra classified launch');

    for (const who of DENIED) {
      const search = (await c[who].get(`${ws}/search?q=zebra`)).data;
      expect(search.issues, who).toHaveLength(0);
      expect((await c[who].get(`${ws}/search?q=secret`)).data.projects, who).toHaveLength(0);
    }
    expect((await c.insider.get(`${ws}/search?q=zebra`)).data.issues).toHaveLength(1);

    const detail = (await c.member.get(`${ws}/issues/${ids.pubIssue}`)).data as IssueDetail;
    expect(detail.relations).toHaveLength(0);
    const ownerDetail = (await c.owner.get(`${ws}/issues/${ids.pubIssue}`)).data as IssueDetail;
    expect(ownerDetail.relations).toHaveLength(1);
  });
});

describe('bootstrap', () => {
  const load = async (who: keyof typeof c) =>
    (await c[who].get(`${ws}/bootstrap`)).data as Bootstrap;

  it('shows only visible teams, labels, projects and cycles, with honest progress', async () => {
    for (const who of ALLOWED) {
      const b = await load(who);
      expect(b.teams.map((t) => t.key).sort(), who).toEqual(['PRV', 'PUB']);
      expect(
        b.labels.map((l) => l.name),
        who,
      ).toContain('Classified');
      expect(b.projects.map((p) => p.name).sort(), who).toEqual(['Mixed bag', 'Secret plan']);
      expect(b.projects.find((p) => p.name === 'Mixed bag')!.progress.total, who).toBe(2);
      expect(
        b.cycles.map((x) => x.id),
        who,
      ).toContain(ids.cycle);
    }
    const member = await load('member');
    expect(member.teams.map((t) => t.key)).toEqual(['PUB']);
    expect(member.labels.map((l) => l.name)).not.toContain('Classified');
    expect(member.projects.map((p) => p.name)).toEqual(['Mixed bag']);
    expect(member.projects[0]!.progress.total).toBe(1);
    expect(member.projects[0]!.teamIds).toEqual([ids.pub]);
    expect(member.cycles).toHaveLength(0);

    const guest = await load('guest');
    expect(guest.teams.map((t) => t.key)).toEqual(['PUB']);
    expect(guest.members.find((m) => m.id === ids.owner)!.email).toBe('');
    expect(guest.members.find((m) => m.id === ids.guest)!.email).not.toBe('');
  });

  it('keeps the workspace hidden from outsiders', async () => {
    expect((await c.outsider.get(`${ws}/bootstrap`)).statusCode).toBe(404);
  });
});

describe('sync', () => {
  type Who = keyof typeof c;
  const snapshot = async (who: Who) => (await c[who].get(`${ws}/sync/snapshot`)).data;
  const issuePage = async (who: Who) =>
    ((await c[who].post(`${ws}/sync/issues`, {})).data.issues as Issue[]).map((i) => i.id);
  const changes = async (who: Who, since: number, epoch: number) => {
    const res = await c[who].get(`${ws}/sync/changes?since=${since}&epoch=${epoch}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.data;
  };

  it('loads only what each person may see', async () => {
    for (const who of [...ALLOWED, ...DENIED]) {
      const snap = await snapshot(who);
      const teams = snap.bootstrap.teams.map((t: { key: string }) => t.key);
      expect(teams.includes('PRV'), who).toBe(ALLOWED.includes(who as never));
      expect((await issuePage(who)).includes(ids.priv!), who).toBe(ALLOWED.includes(who as never));
    }
    expect((await c.outsider.get(`${ws}/sync/snapshot`)).statusCode).toBe(404);
  });

  it('follows changes without showing private ones', async () => {
    const start = Object.fromEntries(
      await Promise.all([...ALLOWED, ...DENIED].map(async (w) => [w, await snapshot(w)])),
    );
    await c.owner.patch(`${ws}/issues/${ids.priv}`, { description: 'Launch codes inside' });
    const comment = (await c.owner.post(`${ws}/issues/${ids.priv}/comments`, { body: 'psst' })).data
      .id;
    for (const who of [...ALLOWED, ...DENIED]) {
      const got = await changes(who, start[who].seq, start[who].epoch);
      const sees = ALLOWED.includes(who as never);
      expect(got.issues.map((i: Issue) => i.id).includes(ids.priv!), who).toBe(sees);
      expect(got.comments.map((x: { id: string }) => x.id).includes(comment), who).toBe(sees);
      expect(JSON.stringify(got).includes('Launch codes'), who).toBe(sees);
      expect(got.deletedIssueIds, who).toEqual([]);
    }
  });

  it('turns an issue moved into a private team into a deletion for those outside it', async () => {
    const moved = (await c.owner.post(`${ws}/issues`, { teamId: ids.pub, title: 'Going dark' }))
      .data.id;
    const start = await snapshot('member');
    await c.owner.patch(`${ws}/issues/${moved}`, { teamId: ids.prv });
    const got = await changes('member', start.seq, start.epoch);
    expect(got.deletedIssueIds).toEqual([moved]);
    expect(got.issues).toEqual([]);
    const insider = await changes('insider', start.seq, start.epoch);
    expect(insider.issues.map((i: Issue) => i.id)).toEqual([moved]);
  });

  it('asks clients from another epoch to start over', async () => {
    const { seq, epoch } = await snapshot('member');
    const res = await c.member.get(`${ws}/sync/changes?since=${seq}&epoch=${epoch + 1}`);
    expect(res.statusCode).toBe(410);
    expect(res.data.messageKey).toBe('resync');
  });
});

describe('notifications', () => {
  it("never reach people who can't see the issue", async () => {
    const members = ((await c.owner.get(`${ws}/bootstrap`)).data as Bootstrap).members;
    const handle = (id: string) => members.find((m) => m.id === id)!.username;
    await c.owner.post(`${ws}/issues/${ids.priv}/comments`, {
      body: `Ping @${handle(ids.member!)} and @${handle(ids.insider!)}`,
    });
    const types = async (who: keyof typeof c) =>
      ((await c[who].get(`${ws}/notifications`)).data as Notification[])
        .filter((n) => n.issueId === ids.priv)
        .map((n) => n.type);
    expect(await types('insider')).toContain('issue_mention');
    expect(await types('member')).toHaveLength(0);
    const counts = async (who: keyof typeof c) =>
      (await c[who].get(`${ws}/notifications/counts`)).data as Record<string, number>;
    expect((await counts('insider')).issue_mention).toBeGreaterThan(0);
    expect((await counts('member')).issue_mention).toBeUndefined();
  });
});

describe('roles and teams', () => {
  it('lets only team admins change team settings and membership', async () => {
    expect((await c.member.patch(`${ws}/teams/${ids.pub}`, { name: 'Hijacked' })).statusCode).toBe(
      403,
    );
    expect(
      (
        await c.member.post(`${ws}/teams/${ids.pub}/states`, {
          name: 'Nope',
          type: 'started',
          color: '#ffffff',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await c.member.post(`${ws}/teams/${ids.pub}/members`, { userId: ids.outsider })).statusCode,
    ).toBe(403);
    expect(
      (await c.member.post(`${ws}/teams/${ids.pub}/members`, { role: 'admin' })).statusCode,
    ).toBe(403);
    // Joining a public team yourself is fine; a private one isn't even visible.
    expect((await c.member.post(`${ws}/teams/${ids.pub}/members`, {})).statusCode).toBe(200);
    expect((await c.member.post(`${ws}/teams/${ids.prv}/members`, {})).statusCode).toBe(404);
    // Team admins don't need to be workspace admins.
    await c.owner.patch(`${ws}/teams/${ids.prv}/members/${ids.insider}`, { role: 'admin' });
    expect(
      (await c.insider.patch(`${ws}/teams/${ids.prv}`, { description: 'Run by Ines' })).statusCode,
    ).toBe(200);
    await c.owner.patch(`${ws}/teams/${ids.prv}/members/${ids.insider}`, { role: 'member' });
  });

  it('lets people leave teams, but only team admins remove others', async () => {
    const remove = (who: keyof typeof c, team: string, user: string) =>
      c[who].del(`${ws}/teams/${team}/members/${ids[user]}`);
    expect((await remove('member', ids.pub!, 'guest')).statusCode).toBe(403);
    expect((await remove('member', ids.prv!, 'insider')).statusCode).toBe(404);
    expect((await remove('member', ids.prv!, 'member')).statusCode).toBe(404);
    expect((await remove('member', ids.pub!, 'member')).statusCode).toBe(200);
    expect((await c.member.post(`${ws}/teams/${ids.pub}/members`, {})).statusCode).toBe(200);
    const teams = ((await c.owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams;
    const members = (id: string) => teams.find((t) => t.id === id)!.members.map((m) => m.userId);
    expect(members(ids.prv!)).toContain(ids.insider);
    expect(members(ids.pub!)).toEqual(expect.arrayContaining([ids.guest, ids.member]));
  });

  it('keeps guests to issue work', async () => {
    expect((await c.guest.post(`${ws}/teams`, { name: 'Guest team', key: 'GST' })).statusCode).toBe(
      403,
    );
    expect(
      (await c.guest.post(`${ws}/projects`, { name: 'Guest project', teamIds: [ids.pub] }))
        .statusCode,
    ).toBe(403);
    expect(
      (await c.guest.post(`${ws}/views`, { name: 'Guest view', filters: {} })).statusCode,
    ).toBe(403);
    expect(
      (await c.guest.post(`${ws}/labels`, { name: 'Guest label', color: '#ffffff' })).statusCode,
    ).toBe(403);
    expect(
      (
        await c.guest.post(`${ws}/teams/${ids.pub}/cycles`, {
          startsAt: '2026-02-01',
          endsAt: '2026-02-14',
        })
      ).statusCode,
    ).toBe(403);
    // …but guests do work on issues in their team.
    expect(
      (await c.guest.post(`${ws}/issues`, { teamId: ids.pub, title: 'Guest bug report' }))
        .statusCode,
    ).toBe(200);
  });

  it('protects ownership', async () => {
    expect((await c.admin.patch(`${ws}/members/${ids.member}`, { role: 'owner' })).statusCode).toBe(
      403,
    );
    expect((await c.admin.patch(`${ws}/members/${ids.owner}`, { role: 'member' })).statusCode).toBe(
      403,
    );
    expect((await c.admin.del(`${ws}/members/${ids.owner}`)).statusCode).toBe(403);
    expect((await c.owner.patch(`${ws}/members/${ids.owner}`, { role: 'admin' })).statusCode).toBe(
      400,
    );
    expect((await c.owner.patch(`${ws}/members/${ids.admin}`, { role: 'owner' })).statusCode).toBe(
      200,
    );
    expect((await c.owner.patch(`${ws}/members/${ids.owner}`, { role: 'admin' })).statusCode).toBe(
      200,
    );
    expect((await c.admin.patch(`${ws}/members/${ids.owner}`, { role: 'owner' })).statusCode).toBe(
      200,
    );
    expect(
      (await c.member.patch(`${ws}/members/${ids.guest}`, { role: 'member' })).statusCode,
    ).toBe(403);
    expect((await c.owner.post(`${ws}/invites`, { role: 'owner' })).statusCode).toBe(400);
  });
});

describe('realtime', () => {
  it('drops events for teams a client cannot read', async () => {
    const received: RealtimeEvent[] = [];
    const access = await computeAccess(app.db, ids.member!, boot.workspace.id, 'member');
    const remove = app.realtime.add({
      userId: ids.member!,
      workspaceId: boot.workspace.id,
      access,
      send: (d) => received.push(JSON.parse(d)),
    });
    const base = { kind: 'issue', action: 'updated', workspaceId: boot.workspace.id } as const;
    app.realtime.publish([
      { ...base, id: ids.priv!, teamId: ids.prv },
      { ...base, id: ids.pubIssue!, teamId: ids.pub },
    ]);
    remove();
    expect(received.map((e) => e.id)).toEqual([ids.pubIssue]);
  });

  it('tells those who saw an issue only where it was that it left', async () => {
    const received: RealtimeEvent[] = [];
    const access = await computeAccess(app.db, ids.member!, boot.workspace.id, 'member');
    const remove = app.realtime.add({
      userId: ids.member!,
      workspaceId: boot.workspace.id,
      access,
      send: (d) => received.push(JSON.parse(d)),
    });
    app.realtime.publish([
      {
        kind: 'issue',
        action: 'updated',
        workspaceId: boot.workspace.id,
        id: ids.pubIssue!,
        teamId: ids.prv,
        prevTeamId: ids.pub,
      },
    ]);
    remove();
    expect(received).toEqual([
      expect.objectContaining({ id: ids.pubIssue, action: 'deleted', teamId: ids.pub }),
    ]);
    expect(received[0]!.prevTeamId).toBeUndefined();
  });
});

describe('MCP tools', () => {
  const keys: Partial<Record<keyof typeof c, string>> = {};
  const call = async (who: keyof typeof c, name: string, args: Record<string, unknown> = {}) => {
    keys[who] ??= (await c[who].post('/api/me/api-keys', { name: 'agent' })).data.token;
    const res = await app.inject({
      method: 'POST',
      url: `${ws}/mcp`,
      headers: { authorization: `Bearer ${keys[who]}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    if (res.statusCode !== 200) return { status: res.statusCode };
    const { content, isError } = res.json().result;
    return isError ? { error: content[0].text as string } : JSON.parse(content[0].text);
  };

  it("gives the agent exactly its user's access", async () => {
    for (const who of ALLOWED) {
      expect((await call(who, 'get_issue', { issue: 'PRV-1' })).title, who).toBe(
        'Zebra classified launch',
      );
      const found = await call(who, 'search_issues', { query: 'zebra' });
      expect(found.count, who).toBe(1);
    }
    for (const who of DENIED) {
      expect(await call(who, 'get_issue', { issue: 'PRV-1' }), who).toEqual({
        error: 'Issue not found',
      });
      expect((await call(who, 'search_issues', { query: 'zebra' })).count, who).toBe(0);
      const teams = (await call(who, 'list_teams')).map((t: { key: string }) => t.key);
      expect(teams, who).toEqual(['PUB']);
      expect((await call(who, 'create_issue', { team: 'PRV', title: 'x' })).error, who).toContain(
        'Unknown team "PRV"',
      );
      expect((await call(who, 'add_comment', { issue: 'PRV-1', body: 'hi' })).error, who).toBe(
        'Issue not found',
      );
      const labels = (await call(who, 'list_labels')).map((l: { name: string }) => l.name);
      expect(labels, who).not.toContain('Classified');
      const projects = (await call(who, 'list_projects')).map((p: { name: string }) => p.name);
      expect(projects, who).not.toContain('Secret plan');
      expect(await call(who, 'list_cycles', { includePast: true }), who).toEqual([]);
    }
    // The public issue is blocked by the private one; that relation stays hidden.
    expect((await call('member', 'get_issue', { issue: ids.pubIssue })).relations).toEqual([]);
    expect(await call('outsider', 'list_teams')).toEqual({ status: 404 });
  });

  it("hides other people's email from guests", async () => {
    const people = await call('guest', 'list_members');
    expect(people.filter((p: { email?: string }) => p.email)).toHaveLength(1);
  });
});

describe('insights', () => {
  const total = (day: { issues: Record<string, number> }) =>
    Object.values(day.issues).reduce((a, b) => a + b, 0);

  it('hide private teams, their cycles and their issues', async () => {
    for (const who of DENIED) {
      for (const q of [
        `teamId=${ids.prv}`,
        `cycleId=${ids.cycle}`,
        `projectId=${ids.secretProject}`,
      ])
        expect((await c[who].get(`${ws}/insights/timeline?${q}`)).statusCode, who).toBe(404);
      expect((await c[who].get(`${ws}/insights/velocity?teamId=${ids.prv}`)).statusCode, who).toBe(
        404,
      );
    }
    for (const who of ALLOWED) {
      expect((await c[who].get(`${ws}/insights/timeline?teamId=${ids.prv}`)).statusCode, who).toBe(
        200,
      );
      expect((await c[who].get(`${ws}/insights/velocity?teamId=${ids.prv}`)).statusCode, who).toBe(
        200,
      );
    }
    const last = async (who: keyof typeof c, q: string) =>
      total((await c[who].get(`${ws}/insights/timeline?${q}`)).data.days.at(-1));
    expect(await last('member', `projectId=${ids.mixedProject}`)).toBe(1);
    expect(await last('insider', `projectId=${ids.mixedProject}`)).toBe(2);
    expect(await last('member', '')).toBeLessThan(await last('owner', ''));
  });
});

describe('project documents', () => {
  it('stay with the projects people can see', async () => {
    const doc = (
      await c.owner.post(`${ws}/projects/${ids.secretProject}/documents`, { title: 'Pricing' })
    ).data.id;
    for (const who of DENIED) {
      expect((await c[who].get(`${ws}/projects/${ids.secretProject}/documents`)).statusCode).toBe(
        404,
      );
      expect(
        (await c[who].post(`${ws}/projects/${ids.secretProject}/documents`, { title: 'x' }))
          .statusCode,
        who,
      ).toBe(404);
      expect((await c[who].get(`${ws}/documents/${doc}`)).statusCode, who).toBe(404);
      expect(
        (await c[who].patch(`${ws}/documents/${doc}`, { title: 'Leaked' })).statusCode,
        who,
      ).toBe(404);
      expect((await c[who].del(`${ws}/documents/${doc}`)).statusCode, who).toBe(404);
    }
    for (const who of ALLOWED)
      expect((await c[who].get(`${ws}/documents/${doc}`)).statusCode, who).toBe(200);
    expect(
      (await c.insider.patch(`${ws}/documents/${doc}`, { title: 'Pricing v2' })).statusCode,
    ).toBe(200);
    expect((await c.owner.get(`${ws}/documents/${doc}`)).data.title).toBe('Pricing v2');
    expect((await c.insider.del(`${ws}/documents/${doc}`)).statusCode).toBe(200);
  });
});

/**
 * Every workspace route must be accounted for: exercised by this matrix, or listed with the reason
 * it needs no team check. A new route that is in neither list fails the build.
 */
describe('route inventory', () => {
  const COVERED = new Set([
    'POST /issues/query',
    'GET /issues/:id',
    'POST /issues',
    'PATCH /issues/:id',
    'POST /issues/batch',
    'POST /issues/batch-delete',
    'DELETE /issues/:id',
    'GET /issues/:id/history',
    'POST /issues/:id/subscription',
    'POST /issues/:id/relations',
    'DELETE /relations/:id',
    'GET /issues/:id/comments',
    'POST /issues/:id/comments',
    'GET /bootstrap',
    'GET /sync/snapshot',
    'POST /sync/issues',
    'GET /sync/changes',
    'GET /search',
    'GET /notifications',
    'GET /notifications/counts',
    'POST /teams',
    'PATCH /teams/:teamId',
    'POST /teams/:teamId/members',
    'PATCH /teams/:teamId/members/:userId',
    'DELETE /teams/:teamId/members/:userId',
    'POST /teams/:teamId/states',
    'POST /teams/:teamId/cycles',
    'GET /insights/timeline',
    'GET /insights/velocity',
    'POST /projects',
    'POST /views',
    'POST /labels',
    'PATCH /members/:userId',
    'DELETE /members/:userId',
    'POST /invites',
    'POST /mcp',
    'GET /projects/:id/documents',
    'POST /projects/:id/documents',
    'GET /documents/:id',
    'PATCH /documents/:id',
    'DELETE /documents/:id',
  ]);
  // Routes that go through the same service as a covered route, or have no team-scoped data.
  const ALLOWLISTED: Record<string, string> = {
    'POST /issues/:id/restore': 'trashIssue, like DELETE /issues/:id',
    'DELETE /issues/:id/purge': 'admin only; purgeIssue is team-scoped',
    'DELETE /issues/:id/subscription': 'resolveIssue, like POST',
    'PATCH /comments/:id': 'loadComment checks the issue team',
    'POST /issues/:id/archive':
      "setArchived uses getIssue with the caller's access (archive.test.ts)",
    'POST /issues/:id/unarchive':
      "setArchived uses getIssue with the caller's access (archive.test.ts)",
    'POST /projects/:id/milestones': 'loadProject, like PATCH /projects/:id (milestones.test.ts)',
    'PATCH /milestones/:id': "loadMilestone checks the milestone's project (milestones.test.ts)",
    'DELETE /milestones/:id': "loadMilestone checks the milestone's project (milestones.test.ts)",
    'GET /initiatives': 'listInitiatives, same as bootstrap (initiatives.test.ts)',
    'POST /initiatives': 'non-guests, like projects (initiatives.test.ts)',
    'PATCH /initiatives/:id': 'loadInitiative: workspace-scoped, non-guests (initiatives.test.ts)',
    'DELETE /initiatives/:id': 'loadInitiative: workspace-scoped, non-guests (initiatives.test.ts)',
    'POST /teams/:teamId/triage-rules': 'loadTeam(admin), like workflow states (triage.test.ts)',
    'PATCH /triage-rules/:id': "loadTeam(admin) of the rule's team (triage.test.ts)",
    'DELETE /triage-rules/:id': "loadTeam(admin) of the rule's team (triage.test.ts)",
    'GET /customers': 'workspace-level; guests get none (customers.test.ts)',
    'POST /customers': 'non-guests (customers.test.ts)',
    'PATCH /customers/:id': 'loadCustomer: workspace-scoped, non-guests (customers.test.ts)',
    'DELETE /customers/:id': 'loadCustomer: workspace-scoped, non-guests (customers.test.ts)',
    'GET /customers/:id/requests':
      'only requests on issues the caller can read (customers.test.ts)',
    'POST /issues/:id/customer-requests': "getIssue with the caller's access (customers.test.ts)",
    'DELETE /customer-requests/:id': "getIssue with the caller's access (customers.test.ts)",
    'GET /recurring': 'listRecurring, team-scoped like bootstrap (recurring.test.ts)',
    'POST /recurring': 'assertLabelTeam on its team, like templates (recurring.test.ts)',
    'PATCH /recurring/:id': 'load checks the team (recurring.test.ts)',
    'DELETE /recurring/:id': 'load checks the team (recurring.test.ts)',
    'GET /templates': 'listTemplates, same as bootstrap (templates.test.ts)',
    'POST /templates': 'assertLabelTeam, like labels (templates.test.ts)',
    'PATCH /templates/:id': 'loadTemplate checks the team (templates.test.ts)',
    'DELETE /templates/:id': 'loadTemplate checks the team (templates.test.ts)',
    'PUT /comments/:id/reactions/:emoji': 'loadComment checks the issue team (reactions.test.ts)',
    'DELETE /comments/:id/reactions/:emoji':
      'loadComment checks the issue team (reactions.test.ts)',
    'DELETE /comments/:id': 'loadComment checks the issue team',
    'GET /teams': 'listTeams, same as bootstrap',
    'DELETE /teams/:teamId': 'workspace admins only',
    'PATCH /states/:stateId': 'loadState requires team admin',
    'DELETE /states/:stateId': 'loadState requires team admin',
    'GET /cycles': 'listCycles, same as bootstrap',
    'PATCH /cycles/:id': 'loadCycle checks team access',
    'DELETE /cycles/:id': 'loadCycle checks team access',
    'GET /cycles/:id/workload': 'readableCycle checks team access (workload.test.ts)',
    'PUT /cycles/:id/capacity/:userId': 'loadCycle checks team access (workload.test.ts)',
    'GET /projects': 'listProjects, same as bootstrap',
    'GET /projects/:id': 'listProjects',
    'PATCH /projects/:id': 'loadProject',
    'DELETE /projects/:id': 'loadProject',
    'GET /projects/:id/updates': 'listProjects',
    'POST /projects/:id/updates': 'loadProject',
    'DELETE /project-updates/:id': 'listProjects',
    'PATCH /labels/:id': 'loadLabel',
    'DELETE /labels/:id': 'loadLabel',
    'GET /custom-fields': 'listCustomFields, same as bootstrap (custom-fields.test.ts)',
    'POST /custom-fields': 'admins, or team admins for team fields (custom-fields.test.ts)',
    'PATCH /custom-fields/:id': 'manageableField checks the team (custom-fields.test.ts)',
    'DELETE /custom-fields/:id': 'manageableField checks the team (custom-fields.test.ts)',
    'PATCH /views/:id': 'owner or admin; results are filtered when queried',
    'DELETE /views/:id': 'owner or admin',
    'PATCH /': 'workspace admins only',
    'GET /invites': 'workspace admins only',
    'DELETE /invites/:id': 'workspace admins only',
    'GET /audit-log': 'workspace admins only',
    'GET /ai/settings': 'workspace admins only',
    'PUT /ai/provider': 'workspace admins only',
    'DELETE /ai/provider': 'workspace admins only',
    'POST /ai/provider/test': 'workspace admins only',
    'POST /favorites': "the caller's own data; bootstrap hides invisible targets",
    'DELETE /favorites/:id': "the caller's own data",
    'POST /notifications/read': "the caller's own notifications",
    'POST /notifications/delete': "the caller's own notifications",
    'POST /notifications/snooze': "the caller's own notifications (snooze.test.ts)",
    'DELETE /': 'owners only, confirmed by slug',
    'POST /logo': 'workspace admins only',
    'DELETE /logo': 'workspace admins only',
    'POST /transfer-ownership': 'owners only',
    'POST /invites/:id/resend': 'admins, or the member who created it',
    'GET /domains': 'workspace admins only',
    'POST /domains': 'workspace admins only',
    'POST /domains/:id/verify': 'workspace admins only',
    'DELETE /domains/:id': 'workspace admins only',
    'GET /auth-providers': 'workspace admins only',
    'GET /webhooks': 'workspace admins only',
    'POST /webhooks': 'workspace admins only',
    'PATCH /webhooks/:id': 'workspace admins only',
    'DELETE /webhooks/:id': 'workspace admins only',
    'GET /webhooks/:id/secret': 'workspace admins only',
    'POST /webhooks/:id/rotate-secret': 'workspace admins only',
    'GET /webhooks/:id/deliveries': 'workspace admins only',
    'GET /webhooks/:id/deliveries/:deliveryId': 'workspace admins only',
    'POST /webhooks/:id/deliveries/:deliveryId/redeliver': 'workspace admins only',
    'POST /webhooks/:id/ping': 'workspace admins only',
    'GET /integrations': 'workspace admins only',
    'POST /integrations': 'workspace admins only',
    'PATCH /integrations/:id': 'workspace admins only',
    'DELETE /integrations/:id': 'workspace admins only',
    'GET /integrations/:id/repositories': 'workspace admins only (forges.test.ts)',
    'POST /issues/:id/links': "getIssue with the caller's access",
    'DELETE /issue-links/:id': 'deleteIssueLink checks the issue team',
    'POST /attachments': "getIssue with the caller's access (attachments.test.ts)",
    'DELETE /attachments/:id': 'checks the issue team, uploader or admin (attachments.test.ts)',
    'GET /integrations/github/app': 'workspace admins only',
    'POST /integrations/github/manifest': 'instance admins only',
    'POST /integrations/github/install': 'workspace admins only',
    'GET /integrations/slack/app': 'workspace admins only',
    'PUT /integrations/slack/app': 'instance admins only',
    'POST /integrations/slack/install': 'workspace admins only',
    'GET /me/external-accounts': "the caller's own claims",
    'POST /me/external-accounts': "the caller's own claims",
    'DELETE /me/external-accounts/:id': "the caller's own claims",
    'GET /me/chat-accounts': "the caller's own chat accounts (tested in chat.test.ts)",
    'POST /me/chat-accounts/:integrationId/code': 'a link code for the caller (chat.test.ts)',
    'PATCH /me/chat-accounts/:id': "the caller's own chat accounts (chat.test.ts)",
    'DELETE /me/chat-accounts/:id': "the caller's own chat accounts (chat.test.ts)",
    'POST /auth-providers': 'workspace admins only',
    'PATCH /auth-providers/:id': 'workspace admins only',
    'DELETE /auth-providers/:id': 'workspace admins only',
    'POST /auth-providers/saml/metadata': 'workspace admins only',
    'GET /scim/tokens': 'workspace admins only (scim.test.ts)',
    'POST /scim/tokens': 'workspace admins only (scim.test.ts)',
    'DELETE /scim/tokens/:id': 'workspace admins only (scim.test.ts)',
    'GET /scim/groups': 'workspace admins only (scim.test.ts)',
    'POST /scim/groups/:id/preview': 'workspace admins only (scim.test.ts)',
    'PUT /scim/groups/:id/team': 'workspace admins only (scim.test.ts)',
    'GET /imports': 'workspace admins only (imports.test.ts)',
    'GET /imports/:id': 'workspace admins only',
    'POST /imports': 'workspace admins only (imports.test.ts)',
    'PATCH /imports/:id': 'workspace admins only',
    'POST /imports/:id/dry-run': 'workspace admins only',
    'POST /imports/:id/run': 'workspace admins only',
    'POST /imports/:id/cancel': 'workspace admins only',
    'POST /imports/:id/undo': 'workspace admins only (imports.test.ts)',
    'DELETE /imports/:id': 'workspace admins only',
    'GET /placeholders': 'workspace admins only (placeholders.test.ts)',
    'GET /exports': 'workspace admins only (exports.test.ts)',
    'POST /exports': 'workspace admins only (exports.test.ts)',
    'DELETE /exports/:id': 'workspace admins only; scoped to the workspace (exports.test.ts)',
    'POST /placeholders/:id/merge': 'workspace admins only (placeholders.test.ts)',
    'GET /mcp': 'always 405',
    'POST /graphql': "resolvers call the REST services with the caller's access (graphql.test.ts)",
    'GET /graphql': 'always 405',
    'DELETE /mcp': 'always 405',
    'POST /ai/issues/:id/summary': "readIssue with the caller's access (ai.test.ts)",
    'POST /ai/issues/:id/triage':
      "getIssue and similarIssues with the caller's access (ai.test.ts)",
    'POST /ai/draft': 'assertTeamAccess write on the team (ai.test.ts)',
    'GET /agents': 'workspace admins only (agents.test.ts)',
    'POST /agents': 'workspace admins only (agents.test.ts)',
    'PATCH /agents/:id': 'workspace admins only (agents.test.ts)',
    'POST /agents/:id/keys': 'workspace admins only (agents.test.ts)',
    'DELETE /agents/:id/keys/:keyId': 'workspace admins only',
    'GET /issues/:id/agent-runs': "getIssue with the caller's access (agents.test.ts)",
    'POST /issues/:id/agent-runs': "getIssue with the caller's access (agents.test.ts)",
    'POST /agent-runs/:id/cancel': "loadRun is scoped to the caller's teams (agents.test.ts)",
    'POST /agent-runs/:id/restart': "loadRun is scoped to the caller's teams (agents.test.ts)",
    'POST /agent-runs/:id/dismiss': "loadRun is scoped to the caller's teams (agents.test.ts)",
    'POST /agent-runs/:id/run-anyway': "loadRun is scoped to the caller's teams (agents.test.ts)",
    'GET /agent-pauses': 'workspace-scoped; only agent ids and times (agents.test.ts)',
    'GET /agent-usage': "usage totals count only runs on the caller's teams (agents.test.ts)",
    'POST /agents/:id/unpause': 'workspace admins only (agents.test.ts)',
    'GET /agent-runs': "listWorkspaceRuns is scoped to the caller's teams (agents.test.ts)",
    'GET /agent-runs/active-count':
      "countActiveRuns is scoped to the caller's teams (agents.test.ts)",
    'GET /agent/me': "the calling agent's own teams (agents.test.ts)",
    'POST /agent/claim':
      "the calling agent's runs; the issue is loaded with its access, else the run is cancelled (agents.test.ts)",
    'POST /agent/runs/:id/heartbeat':
      "ownRun: the calling agent's own runs only (agents.test.ts, another agent's run)",
    'PATCH /agent/runs/:id':
      "ownRun: the calling agent's own runs only (agents.test.ts, another agent's run)",
    'GET /repositories': 'names and URLs, workspace-wide like the bootstrap (agents.test.ts)',
    'POST /repositories': 'workspace admins only (agents.test.ts)',
    'PATCH /repositories/:id': 'workspace admins only',
    'DELETE /repositories/:id': 'workspace admins only',
  };

  it('accounts for every workspace route', () => {
    const prefix = '/api/w/:ws';
    const routes = app.routeList
      .filter((r) => r.url.startsWith(prefix))
      .map((r) => `${r.method} ${r.url.slice(prefix.length) || '/'}`);
    const unknown = routes.filter((r) => !COVERED.has(r) && !(r in ALLOWLISTED));
    expect(unknown).toEqual([]);
    // Entries for routes that are gone (or renamed) would claim coverage nobody has.
    const stale = [...COVERED, ...Object.keys(ALLOWLISTED)].filter((r) => !routes.includes(r));
    expect(stale).toEqual([]);
    expect([...COVERED].filter((r) => r in ALLOWLISTED)).toEqual([]);
  });
});
