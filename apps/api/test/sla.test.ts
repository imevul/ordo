import type { Bootstrap, Issue, Notification, Team } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issues } from '../src/db/schema.ts';
import { announceSlaBreaches } from '../src/services/sla.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/sla';
let team: Team;
const ids: Record<string, string> = {};
const HOUR = 3_600_000;

const get = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as Issue;
const hoursAfterCreation = (i: Issue) =>
  i.slaBreachesAt ? (Date.parse(i.slaBreachesAt) - Date.parse(i.createdAt)) / HOUR : null;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Sla',
    slug: 'sla',
    teamName: 'Sup',
    teamKey: 'SUP',
  });
  member = (
    await signup(app, 'Mona Member', {
      inviteToken: (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token,
    })
  ).client;
  ids.member = (await member.get('/api/auth/me')).data.id;
  team = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!;
  ids.other = (await owner.post(`${ws}/teams`, { name: 'Other', key: 'OTH' })).data.id;
});

afterAll(() => app.close());

describe('SLAs', () => {
  it('are set per priority on the team', async () => {
    expect((await owner.patch(`${ws}/teams/${team.id}`, { slaHours: { '1': 0 } })).statusCode).toBe(
      400,
    );
    const res = await owner.patch(`${ws}/teams/${team.id}`, { slaHours: { '1': 24, '2': 168 } });
    expect((res.data as Team).slaHours).toEqual({ '1': 24, '2': 168 });
  });

  it('give new issues a deadline from their priority', async () => {
    const urgent = (
      await owner.post(`${ws}/issues`, { teamId: team.id, title: 'Down', priority: 1 })
    ).data as Issue;
    expect(hoursAfterCreation(urgent)).toBe(24);
    const low = (await owner.post(`${ws}/issues`, { teamId: team.id, title: 'Typo', priority: 4 }))
      .data as Issue;
    expect(low.slaBreachesAt).toBeNull();
    ids.urgent = urgent.id;
  });

  it('follow priority and team changes, counted from creation', async () => {
    await owner.patch(`${ws}/issues/${ids.urgent}`, { priority: 2 });
    expect(hoursAfterCreation(await get(ids.urgent!))).toBe(168);
    await owner.patch(`${ws}/issues/${ids.urgent}`, { priority: 0 });
    expect((await get(ids.urgent!)).slaBreachesAt).toBeNull();
    await owner.patch(`${ws}/issues/${ids.urgent}`, { priority: 1 });
    const moved = (await owner.patch(`${ws}/issues/${ids.urgent}`, { teamId: ids.other }))
      .data as Issue;
    expect(moved.slaBreachesAt).toBeNull();
  });

  it('announce a breach once, to the assignee, for open issues only', async () => {
    const make = async (title: string, stateType?: string) => {
      const stateId = stateType ? team.states.find((s) => s.type === stateType)!.id : undefined;
      const issue = (
        await owner.post(`${ws}/issues`, {
          teamId: team.id,
          title,
          priority: 1,
          assigneeId: ids.member,
          stateId,
        })
      ).data as Issue;
      await app.db
        .update(issues)
        .set({ slaBreachesAt: sql`now() - interval '1 hour'` })
        .where(eq(issues.id, issue.id));
      return issue.id;
    };
    const late = await make('Late');
    await make('Done anyway', 'completed');
    await announceSlaBreaches(app);
    await announceSlaBreaches(app);
    const notes = ((await member.get(`${ws}/notifications`)).data as Notification[]).filter(
      (n) => n.type === 'issue_sla_breached',
    );
    expect(notes.map((n) => n.issueId)).toEqual([late]);
  });
});
