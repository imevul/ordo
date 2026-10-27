import type {
  Bootstrap,
  Comment,
  Customer,
  Integration,
  Issue,
  IssueDetail,
  Team,
} from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
const ws = '/api/w/mail';
let team: Team;
let intake: Integration;

async function settle(rounds = 2) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

const send = async (mime: string) => {
  const res = await app.inject({
    method: 'POST',
    url: intake.inboundUrl!.slice(app.env.publicUrl.length),
    payload: mime,
    headers: { 'content-type': 'message/rfc822' },
  });
  await settle();
  return res;
};

const message = (o: {
  id: string;
  from: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  headers?: string;
}) =>
  [
    `From: ${o.from}`,
    'To: support@ordo.test',
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}>`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    ...(o.headers ? [o.headers] : []),
    'Date: Tue, 27 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body,
    '--b1',
    'Content-Type: text/plain; name="log.txt"',
    'Content-Disposition: attachment; filename="log.txt"',
    '',
    'error: boom',
    '--b1--',
    '',
  ].join('\r\n');

const triage = async () =>
  (await owner.post(`${ws}/issues/query`, { filter: { teamId: team.id } })).data as Issue[];

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Mail',
    slug: 'mail',
    teamName: 'Support',
    teamKey: 'SUP',
  });
  team = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!;
  team = (await owner.patch(`${ws}/teams/${team.id}`, { triageEnabled: true })).data as Team;
});

afterAll(() => app.close());

describe('email intake', () => {
  it('needs a team, and IMAP details when polling', async () => {
    expect(
      (await owner.post(`${ws}/integrations`, { provider: 'email', config: {} })).statusCode,
    ).toBe(400);
    expect(
      (
        await owner.post(`${ws}/integrations`, {
          provider: 'email',
          config: { delivery: 'imap', teamId: team.id, host: 'imap.example.com' },
        })
      ).statusCode,
    ).toBe(400);
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'email',
      config: { delivery: 'webhook', teamId: team.id, address: 'support@ordo.test' },
    });
    expect(res.statusCode).toBe(200);
    intake = res.data;
    expect(intake.inboundUrl).toContain('/api/hooks/email/');
  });

  it('turns a message into a triage issue, a customer request and an attachment', async () => {
    const res = await send(
      message({
        id: 'm1@acme.com',
        from: 'Ada Lovelace <ada@acme.com>',
        subject: 'Export crashes',
        body: 'Clicking export crashes the app.',
      }),
    );
    expect(res.statusCode).toBe(202);
    const [issue] = await triage();
    expect(issue).toMatchObject({
      title: 'Export crashes',
      description: 'Clicking export crashes the app.',
    });
    expect(team.states.find((s) => s.id === issue!.stateId)?.type).toBe('triage');
    const detail = (await owner.get(`${ws}/issues/${issue!.id}`)).data as IssueDetail;
    expect(detail.customerRequests[0]).toMatchObject({
      source: 'email',
      contact: 'Ada Lovelace <ada@acme.com>',
      body: 'Clicking export crashes the app.',
    });
    expect(detail.attachments.map((a) => a.filename)).toEqual(['log.txt']);
    expect(detail.links[0]).toMatchObject({ provider: 'email', kind: 'message' });
    const customers = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).customers;
    expect(customers.map((c: Customer) => [c.name, c.domains])).toEqual([['Acme', ['acme.com']]]);
  });

  it('adds replies in the thread as comments, and ignores redelivery', async () => {
    await send(
      message({
        id: 'm2@acme.com',
        from: 'Ada Lovelace <ada@acme.com>',
        subject: 'Re: Export crashes',
        body: 'It also happens on Firefox.',
        inReplyTo: 'm1@acme.com',
      }),
    );
    await send(
      message({
        id: 'm1@acme.com',
        from: 'Ada Lovelace <ada@acme.com>',
        subject: 'Export crashes',
        body: 'Clicking export crashes the app.',
      }),
    );
    const issues = await triage();
    expect(issues).toHaveLength(1);
    const comments = (await owner.get(`${ws}/issues/${issues[0]!.id}/comments`)).data as Comment[];
    expect(comments.map((c) => c.body)).toEqual([
      '**Ada Lovelace <ada@acme.com>** wrote:\n\nIt also happens on Firefox.',
    ]);
  });

  it('ignores auto-replies and bounces', async () => {
    await send(
      message({
        id: 'm3@acme.com',
        from: 'Bob <bob@acme.com>',
        subject: 'Out of office',
        body: 'Back Monday.',
        headers: 'Auto-Submitted: auto-replied',
      }),
    );
    await send(
      message({
        id: 'm4@mx.example',
        from: 'MAILER-DAEMON@mx.example',
        subject: 'Undeliverable',
        body: '550',
      }),
    );
    expect(await triage()).toHaveLength(1);
  });

  it('lets triage rules pick out email', async () => {
    await owner.post(`${ws}/teams/${team.id}/triage-rules`, {
      name: 'Email is high priority',
      conditions: { sources: ['email'] },
      actions: { priority: 2 },
    });
    await send(
      message({
        id: 'm5@globex.com',
        from: 'hank@globex.com',
        subject: 'Billing question',
        body: '?',
      }),
    );
    const billing = (await triage()).find((i) => i.title === 'Billing question')!;
    expect(billing.priority).toBe(2);
  });
});
