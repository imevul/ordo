import type { Bootstrap, CustomField, HistoryEntry, Issue } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let guest: Client;
let memberId: string;
let guestId: string;
const ws = '/api/w/fields';
const ids: Record<string, string> = {};
const fields: Record<string, CustomField> = {};

const boot = async (c: Client) => (await c.get(`${ws}/bootstrap`)).data as Bootstrap;
const query = async (c: Client, filter: object) =>
  ((await c.post(`${ws}/issues/query`, { filter })).data as Issue[]).map((i) => i.title).sort();

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Fiona Fields')).client;
  await owner.post('/api/workspaces', {
    name: 'Fields',
    slug: 'fields',
    teamName: 'Eng',
    teamKey: 'ENG',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  member = (await signup(app, 'Mika Fields', { inviteToken: await invite('member') })).client;
  guest = (await signup(app, 'Gale Fields', { inviteToken: await invite('guest') })).client;
  memberId = (await member.get('/api/auth/me')).data.id;
  guestId = (await guest.get('/api/auth/me')).data.id;
  ids.eng = (await boot(owner)).teams[0]!.id;
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })
  ).data.id;
  ids.ops = (await owner.post(`${ws}/teams`, { name: 'Ops', key: 'OPS' })).data.id;
});

afterAll(() => app.close());

describe('custom field definitions', () => {
  it('are created by admins, with option ids and colors', async () => {
    const res = await owner.post(`${ws}/custom-fields`, {
      name: 'Customer tier',
      type: 'select',
      options: [{ name: 'Gold' }, { name: 'Silver', color: '#2de2e6' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    fields.tier = res.data;
    expect(fields.tier).toMatchObject({ teamId: null, type: 'select', name: 'Customer tier' });
    expect(fields.tier.options.map((o) => o.name)).toEqual(['Gold', 'Silver']);
    expect(fields.tier.options[1]!.color).toBe('#2de2e6');
    expect(fields.tier.options.every((o) => o.id && o.color)).toBe(true);

    for (const [name, type] of [
      ['Story points', 'number'],
      ['Release date', 'date'],
      ['Notes', 'text'],
      ['Reviewer', 'person'],
    ] as const) {
      fields[type] = (await owner.post(`${ws}/custom-fields`, { name, type })).data;
    }
    fields.areas = (
      await owner.post(`${ws}/custom-fields`, {
        name: 'Areas',
        type: 'multi_select',
        options: [{ name: 'API' }, { name: 'Web' }, { name: 'CLI' }],
      })
    ).data;
    // Fields after the first go after it.
    expect(fields.number!.position).toBeGreaterThan(fields.tier.position);
  });

  it('are refused to members and guests, and must have unique names', async () => {
    expect(
      (await member.post(`${ws}/custom-fields`, { name: 'Nope', type: 'text' })).statusCode,
    ).toBe(403);
    expect(
      (await guest.post(`${ws}/custom-fields`, { name: 'Nope', type: 'text' })).statusCode,
    ).toBe(403);
    expect(
      (await owner.post(`${ws}/custom-fields`, { name: 'customer TIER', type: 'text' })).statusCode,
    ).toBe(409);
    expect(
      (
        await owner.post(`${ws}/custom-fields`, {
          name: 'Twice',
          type: 'select',
          options: [{ name: 'A' }, { name: 'a' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await owner.post(`${ws}/custom-fields`, { name: 'Odd', type: 'color' })).statusCode,
    ).toBe(400);
  });

  it('can belong to a team, managed by its admins and seen by those who see it', async () => {
    // A team admin (not a workspace admin) manages the team's fields.
    await owner.post(`${ws}/teams/${ids.ops}/members`, { userId: memberId });
    await owner.patch(`${ws}/teams/${ids.ops}/members/${memberId}`, { role: 'admin' });
    const sev = await member.post(`${ws}/custom-fields`, {
      name: 'Severity',
      type: 'select',
      teamId: ids.ops,
      options: [{ name: 'S1' }, { name: 'S2' }],
    });
    expect(sev.statusCode, sev.body).toBe(200);
    fields.severity = sev.data;
    expect(
      (
        await member.post(`${ws}/custom-fields`, {
          name: 'Nope',
          type: 'text',
          teamId: ids.eng,
        })
      ).statusCode,
    ).toBe(403);

    const secret = await owner.post(`${ws}/custom-fields`, {
      name: 'Secret',
      type: 'text',
      teamId: ids.prv,
    });
    fields.secret = secret.data;
    expect((await boot(owner)).customFields.map((f) => f.name)).toContain('Secret');
    const seen = (await boot(member)).customFields.map((f) => f.name);
    expect(seen).toContain('Severity');
    expect(seen).not.toContain('Secret');
    expect(
      ((await member.get(`${ws}/custom-fields`)).data as CustomField[]).map((f) => f.name),
    ).toEqual(seen);
    expect((await member.patch(`${ws}/custom-fields/${fields.secret.id}`, {})).statusCode).toBe(
      404,
    );
    // The same name may be used by two teams, not by a team and the workspace.
    expect(
      (
        await owner.post(`${ws}/custom-fields`, {
          name: 'Severity',
          type: 'text',
          teamId: ids.prv,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await owner.post(`${ws}/custom-fields`, { name: 'Severity', type: 'text' })).statusCode,
    ).toBe(409);
  });
});

describe('custom field values', () => {
  it('are set on create and update, validated, and recorded in history', async () => {
    const [gold, silver] = fields.tier!.options;
    const [api, web] = fields.areas!.options;
    const created = await owner.post(`${ws}/issues`, {
      teamId: ids.eng,
      title: 'Gold one',
      customFields: {
        [fields.tier!.id]: gold!.id,
        [fields.number!.id]: 5,
        [fields.areas!.id]: [web!.id, api!.id, web!.id],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    ids.gold = created.data.id;
    expect((created.data as Issue).customFields).toEqual({
      [fields.tier!.id]: gold!.id,
      [fields.number!.id]: 5,
      // In the field's order, once each.
      [fields.areas!.id]: [api!.id, web!.id],
    });

    const bad = async (customFields: object) =>
      (await owner.patch(`${ws}/issues/${ids.gold}`, { customFields })).statusCode;
    expect(await bad({ [fields.tier!.id]: 'nope' })).toBe(400);
    expect(await bad({ [fields.tier!.id]: 3 })).toBe(400);
    expect(await bad({ [fields.number!.id]: 'five' })).toBe(400);
    expect(await bad({ [fields.date!.id]: '2026-13-45' })).toBe(400);
    expect(await bad({ [fields.areas!.id]: ['nope'] })).toBe(400);
    // A guest who isn't in the team can't be the reviewer; another team's field doesn't apply.
    expect(await bad({ [fields.person!.id]: guestId })).toBe(400);
    expect(await bad({ [fields.severity!.id]: fields.severity!.options[0]!.id })).toBe(400);
    expect(await bad({ [crypto.randomUUID()]: 'x' })).toBe(400);

    const res = await member.patch(`${ws}/issues/${ids.gold}`, {
      customFields: {
        [fields.tier!.id]: silver!.id,
        [fields.number!.id]: null,
        [fields.date!.id]: '2026-12-01',
        [fields.text!.id]: '  Call them first  ',
        [fields.person!.id]: memberId,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.data as Issue).customFields).toEqual({
      [fields.tier!.id]: silver!.id,
      [fields.areas!.id]: [api!.id, web!.id],
      [fields.date!.id]: '2026-12-01',
      [fields.text!.id]: 'Call them first',
      [fields.person!.id]: memberId,
    });
    const history = (await owner.get(`${ws}/issues/${ids.gold}/history`)).data as HistoryEntry[];
    const changes = history.flatMap((h) => h.changes);
    expect(changes).toContainEqual({
      field: `customField:${fields.tier!.id}`,
      from: gold!.id,
      to: silver!.id,
    });
    expect(changes).toContainEqual({
      field: `customField:${fields.number!.id}`,
      from: 5,
      to: null,
    });

    // Setting what's already there changes nothing.
    const before = (await owner.get(`${ws}/issues/${ids.gold}`)).data as Issue;
    await owner.patch(`${ws}/issues/${ids.gold}`, {
      customFields: { [fields.tier!.id]: silver!.id },
    });
    expect(((await owner.get(`${ws}/issues/${ids.gold}`)).data as Issue).updatedAt).toBe(
      before.updatedAt,
    );
  });

  it('filter issues', async () => {
    const [gold, silver] = fields.tier!.options;
    const [api, web, cli] = fields.areas!.options;
    await owner.post(`${ws}/issues`, {
      teamId: ids.eng,
      title: 'Plain one',
      customFields: { [fields.number!.id]: 2.5, [fields.areas!.id]: [cli!.id] },
    });
    await owner.post(`${ws}/issues`, {
      teamId: ids.eng,
      title: 'Gold two',
      customFields: { [fields.tier!.id]: gold!.id, [fields.areas!.id]: [web!.id] },
    });
    const tier = fields.tier!.id;
    expect(await query(owner, { customFields: { [tier]: [silver!.id] } })).toEqual(['Gold one']);
    expect(await query(owner, { customFields: { [tier]: [gold!.id, 'none'] } })).toEqual([
      'Gold two',
      'Plain one',
    ]);
    expect(
      await query(owner, { customFields: { [fields.areas!.id]: [api!.id, cli!.id] } }),
    ).toEqual(['Gold one', 'Plain one']);
    expect(await query(owner, { customFields: { [fields.number!.id]: ['2.5'] } })).toEqual([
      'Plain one',
    ]);
    expect(await query(member, { customFields: { [fields.person!.id]: ['me'] } })).toEqual([
      'Gold one',
    ]);
    expect(await query(owner, { customFields: { [fields.date!.id]: ['2026-12-01'] } })).toEqual([
      'Gold one',
    ]);
    expect(
      await query(owner, {
        customFields: { [tier]: [gold!.id], [fields.areas!.id]: [web!.id] },
      }),
    ).toEqual(['Gold two']);
  });

  it('follow option changes and field deletion', async () => {
    const [gold, silver] = fields.tier!.options;
    const [api, web, cli] = fields.areas!.options;
    // Renaming keeps an option (by id); leaving one out takes it off issues.
    const renamed = await owner.patch(`${ws}/custom-fields/${fields.tier!.id}`, {
      options: [{ id: gold!.id, name: 'Platinum' }, { name: 'Bronze' }],
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((renamed.data as CustomField).options.map((o) => o.name)).toEqual([
      'Platinum',
      'Bronze',
    ]);
    expect((renamed.data as CustomField).options[0]!.color).toBe(gold!.color);
    const goldOne = (await owner.get(`${ws}/issues/${ids.gold}`)).data as Issue;
    expect(goldOne.customFields[fields.tier!.id]).toBeUndefined();
    expect(silver).toBeDefined();
    expect(await query(owner, { customFields: { [fields.tier!.id]: [gold!.id] } })).toEqual([
      'Gold two',
    ]);

    await owner.patch(`${ws}/custom-fields/${fields.areas!.id}`, {
      options: [
        { id: api!.id, name: 'API' },
        { id: cli!.id, name: 'CLI' },
      ],
    });
    const after = ((await owner.post(`${ws}/issues/query`, { filter: {} })).data as Issue[])
      .map((i) => [i.title, i.customFields[fields.areas!.id]])
      .sort();
    expect(after).toEqual([
      ['Gold one', [api!.id]],
      ['Gold two', undefined],
      ['Plain one', [cli!.id]],
    ]);
    expect(web).toBeDefined();

    // Members can't change fields; deleting one takes its values with it.
    expect(
      (await member.patch(`${ws}/custom-fields/${fields.number!.id}`, { name: 'Pts' })).statusCode,
    ).toBe(403);
    expect((await owner.del(`${ws}/custom-fields/${fields.number!.id}`)).statusCode).toBe(200);
    const plain = ((await owner.post(`${ws}/issues/query`, { filter: {} })).data as Issue[]).find(
      (i) => i.title === 'Plain one',
    )!;
    expect(plain.customFields[fields.number!.id]).toBeUndefined();
    expect((await boot(owner)).customFields.map((f) => f.id)).not.toContain(fields.number!.id);
  });

  it("drop the old team's fields when an issue moves", async () => {
    const issue = (
      await owner.post(`${ws}/issues`, {
        teamId: ids.ops,
        title: 'Outage',
        customFields: {
          [fields.severity!.id]: fields.severity!.options[0]!.id,
          [fields.text!.id]: 'Keep me',
        },
      })
    ).data as Issue;
    const moved = (await owner.patch(`${ws}/issues/${issue.id}`, { teamId: ids.eng }))
      .data as Issue;
    expect(moved.customFields).toEqual({ [fields.text!.id]: 'Keep me' });
  });
});
