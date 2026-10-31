import type { Bootstrap, Customer, CustomerRequest, IssueDetail } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAutomation } from '../src/services/automation.ts';
import { customerForEmail } from '../src/services/customers.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let guest: Client;
const ws = '/api/w/cust';
const ids: Record<string, string> = {};
let boot: Bootstrap;

const customers = async (c: Client) =>
  ((await c.get(`${ws}/bootstrap`)).data as Bootstrap).customers;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Cust',
    slug: 'cust',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite('member') })).client;
  guest = (await signup(app, 'Gus Guest', { inviteToken: await invite('guest') })).client;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  ids.pub = boot.teams[0]!.id;
  const guestId = (await guest.get('/api/auth/me')).data.id;
  await owner.post(`${ws}/teams/${ids.pub}/members`, { userId: guestId });
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })
  ).data.id;
  ids.open = (
    await owner.post(`${ws}/issues`, { teamId: ids.pub, title: 'Export to CSV' })
  ).data.id;
  ids.secret = (
    await owner.post(`${ws}/issues`, { teamId: ids.prv, title: 'Secret deal' })
  ).data.id;
});

afterAll(() => app.close());

describe('customers', () => {
  it('are created by members, with normalised domains', async () => {
    expect(
      (await member.post(`${ws}/customers`, { name: 'Bad', domains: ['not a domain'] })).statusCode,
    ).toBe(400);
    const res = await member.post(`${ws}/customers`, { name: 'Acme', domains: ['ACME.com'] });
    expect(res.statusCode).toBe(200);
    expect(res.data as Customer).toMatchObject({
      name: 'Acme',
      domains: ['acme.com'],
      requestCount: 0,
    });
    ids.acme = (res.data as Customer).id;
    expect((await guest.post(`${ws}/customers`, { name: 'Nope' })).statusCode).toBe(403);
  });

  it('tie requests to issues and count them per viewer', async () => {
    const res = await member.post(`${ws}/issues/${ids.open}/customer-requests`, {
      customerId: ids.acme,
      body: 'We need this for our quarterly report.',
      contact: 'Ada <ada@acme.com>',
    });
    expect(res.statusCode).toBe(200);
    expect(res.data as CustomerRequest).toMatchObject({ source: 'manual', issueId: ids.open });
    expect(
      (await member.post(`${ws}/issues/${ids.secret}/customer-requests`, { customerId: ids.acme }))
        .statusCode,
    ).toBe(404);
    await owner.post(`${ws}/issues/${ids.secret}/customer-requests`, { customerId: ids.acme });

    expect((await customers(owner))[0]).toMatchObject({ requestCount: 2, openIssueCount: 2 });
    expect((await customers(member))[0]).toMatchObject({ requestCount: 1, openIssueCount: 1 });
    const theirs = (await member.get(`${ws}/customers/${ids.acme}/requests`))
      .data as CustomerRequest[];
    expect(theirs.map((r) => r.issueId)).toEqual([ids.open]);
    const detail = (await member.get(`${ws}/issues/${ids.open}`)).data as IssueDetail;
    expect(detail.customerRequests.map((r) => r.body)).toEqual([
      'We need this for our quarterly report.',
    ]);
  });

  it('stay out of sight for guests', async () => {
    expect(await customers(guest)).toEqual([]);
    expect((await guest.get(`${ws}/customers/${ids.acme}/requests`)).statusCode).toBe(403);
    const detail = (await guest.get(`${ws}/issues/${ids.open}`)).data as IssueDetail;
    expect(detail.customerRequests).toEqual([]);
    // Not even on an issue in their own team.
    const posted = await guest.post(`${ws}/issues/${ids.open}/customer-requests`, {
      customerId: ids.acme,
      body: 'From a guest',
    });
    expect(posted.statusCode).toBe(403);
    const requests = (await owner.get(`${ws}/customers/${ids.acme}/requests`))
      .data as CustomerRequest[];
    expect(requests.map((r) => r.body)).not.toContain('From a guest');
  });

  it('are found or made from an email address', async () => {
    const find = (email: string, name?: string) =>
      runAutomation(app, boot.workspace.id, (ctx) => customerForEmail(ctx, email, name));
    expect(await find('Bob@acme.com')).toBe(ids.acme);
    const globex = await find('hank@mail.globex.co.uk');
    const again = await find('marge@mail.globex.co.uk');
    expect(again).toBe(globex);
    const personal = await find('someone@gmail.com', 'Some One');
    expect(await find('someone@gmail.com')).toBe(personal);
    expect(await find('other@gmail.com')).not.toBe(personal);
    const list = await customers(owner);
    expect(list.find((c) => c.id === globex)).toMatchObject({
      name: 'Globex',
      domains: ['mail.globex.co.uk'],
    });
    expect(list.find((c) => c.id === personal)?.name).toBe('someone@gmail.com');
  });

  it('can be updated and deleted, taking their requests along', async () => {
    const res = await member.patch(`${ws}/customers/${ids.acme}`, { notes: 'Enterprise plan' });
    expect((res.data as Customer).notes).toBe('Enterprise plan');
    const requests = (await owner.get(`${ws}/customers/${ids.acme}/requests`))
      .data as CustomerRequest[];
    // The request on the private team's issue is out of the member's reach.
    const secret = requests.find((r) => r.issueId === ids.secret)!;
    expect((await member.del(`${ws}/customer-requests/${secret.id}`)).statusCode).toBe(404);
    expect((await owner.del(`${ws}/customer-requests/${secret.id}`)).statusCode).toBe(200);
    expect((await member.del(`${ws}/customers/${ids.acme}`)).statusCode).toBe(200);
    const detail = (await owner.get(`${ws}/issues/${ids.open}`)).data as IssueDetail;
    expect(detail.customerRequests).toEqual([]);
  });
});
