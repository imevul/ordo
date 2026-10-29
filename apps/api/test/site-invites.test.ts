import { randomBytes } from 'node:crypto';
import type { Invite, InvitePreview, SiteInvite } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.ts';
import { Client, captureMail, linkIn, signup, testApp } from './helpers.ts';

// Invite-only, with workspace creation off: the instance a site invite is for.
let app: FastifyInstance;
let open: FastifyInstance;
let inbox: ReturnType<typeof captureMail>;
let admin: Client;
let member: Client;
let memberEmail: string;
let n = 0;

const unique = (name: string) =>
  `${name}-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`;
const me = async (c: Client) => (await c.get('/api/auth/me')).data;

/** Signs up on the invite-only instance, without throwing on refusals. */
function signupWith(email: string, inviteToken?: string) {
  n++;
  const c = new Client(app, { ip: `10.77.${(n >> 8) & 255}.${n & 255}` });
  return c
    .post('/api/auth/signup', {
      name: 'Site Person',
      email,
      password: 'correct horse battery',
      inviteToken,
    })
    .then((res) => ({ res, client: c }));
}

beforeAll(async () => {
  // People who already have accounts sign up on an open instance sharing the database.
  open = await testApp();
  const a = await signup(open, 'Sid Admin');
  const m = await signup(open, 'Mo Member');
  memberEmail = m.email;
  // Already in a workspace, so with creation off they may not make another.
  const slug = `mo-${Date.now()}-${randomBytes(2).toString('hex')}`;
  await m.client.post('/api/workspaces', { name: 'Mo', slug });
  app = await testApp({
    settingsFromEnv: {
      signupMode: 'invite',
      allowWorkspaceCreation: false,
      smtp: { url: 'smtp://mail.test:25', from: 'Ordo <ordo@test>' },
    },
  });
  inbox = captureMail(app);
  admin = new Client(app);
  admin.cookie = a.client.cookie;
  member = new Client(app);
  member.cookie = m.client.cookie;
  await app.db
    .update(users)
    .set({ isInstanceAdmin: true })
    .where(eq(users.id, (await me(admin)).id));
});
afterAll(async () => {
  await app.close();
  await open.close();
});

describe('site invites', () => {
  it('are for instance admins only', async () => {
    expect((await member.get('/api/admin/invites')).statusCode).toBe(403);
    expect((await member.post('/api/admin/invites', {})).statusCode).toBe(403);
    expect((await new Client(app).get('/api/admin/invites')).statusCode).toBe(401);
  });

  it('let someone sign up without joining a workspace, once, from the invited address', async () => {
    const email = unique('sia');
    const res = await admin.post('/api/admin/invites', { emails: [email] });
    expect(res.statusCode, res.body).toBe(200);
    const [invite] = res.data as SiteInvite[];
    expect(invite).toMatchObject({ email, canCreateWorkspaces: false, createdByName: 'Sid Admin' });
    expect(invite!.lastSentAt).not.toBeNull();

    await app.jobs.drain();
    const mail = inbox.find((m) => m.to === email);
    expect(mail?.subject).toContain('invited you to Ordo');
    expect(linkIn(mail!.text)).toBe(invite!.url);

    const preview = (await new Client(app).get(`/api/invites/${invite!.token}`))
      .data as InvitePreview;
    expect(preview).toMatchObject({ kind: 'site', workspace: null, email, alreadySignedUp: false });

    // Without an invite the instance is closed; with someone else's address the invite refuses.
    expect((await signupWith(unique('nobody'))).res.data.messageKey).toBe('invite_required');
    const wrong = await signupWith(unique('wrong'), invite!.token);
    expect(wrong.res.statusCode).toBe(403);
    expect(wrong.res.data.messageKey).toBe('invite_other_email');

    const ok = await signupWith(email, invite!.token);
    expect(ok.res.statusCode, ok.res.body).toBe(200);
    expect(ok.res.data.workspaceSlug).toBeNull();
    const account = await me(ok.client);
    expect(account.workspaces).toEqual([]);
    // Not granted, so no first workspace either: they wait to be added.
    expect(account.canCreateWorkspace).toBe(false);
    const create = await ok.client.post('/api/workspaces', { name: 'Mine', slug: `mine-${n}` });
    expect(create.statusCode).toBe(403);
    expect(create.data.messageKey).toBe('workspace_creation_off');

    // Single use, and gone from the open list.
    expect((await signupWith(email, invite!.token)).res.data.messageKey).toBe('invite_invalid');
    const list = (await admin.get('/api/admin/invites')).data as SiteInvite[];
    expect(list.some((i) => i.id === invite!.id)).toBe(false);

    const audit = (await admin.get('/api/admin/audit-log?scope=all&limit=500')).data as {
      action: string;
      targetId: string;
    }[];
    expect(
      audit.some((e) => e.action === 'admin.invite_created' && e.targetId === invite!.id),
    ).toBe(true);
  });

  it('can grant workspace creation, past the instance setting', async () => {
    const link = (
      (await admin.post('/api/admin/invites', { canCreateWorkspaces: true })).data as SiteInvite[]
    )[0]!;
    expect(link).toMatchObject({ email: null, canCreateWorkspaces: true, lastSentAt: null });
    const { res, client } = await signupWith(unique('creator'), link.token);
    expect(res.statusCode, res.body).toBe(200);
    expect((await me(client)).canCreateWorkspace).toBe(true);
    for (const slug of [`one-${n}`, `two-${n}`]) {
      const created = await client.post('/api/workspaces', { name: slug, slug });
      expect(created.statusCode, created.body).toBe(200);
    }
    // An open link stays valid until it expires or is revoked.
    expect((await new Client(app).get(`/api/invites/${link.token}`)).statusCode).toBe(200);
  });

  it("don't apply to people who already have an account", async () => {
    expect((await admin.post('/api/admin/invites', { email: memberEmail })).statusCode).toBe(409);
    const link = ((await admin.post('/api/admin/invites', {})).data as SiteInvite[])[0]!;

    const again = await signupWith(memberEmail, link.token);
    expect(again.res.statusCode).toBe(409);
    expect(again.res.data.messageKey).toBe('invite_already_signed_up');

    // Signed in, the invite says so, and accepting it neither works nor changes the account.
    const preview = (await member.get(`/api/invites/${link.token}`)).data as InvitePreview;
    expect(preview).toMatchObject({ kind: 'site', alreadySignedUp: true });
    const accept = await member.post(`/api/invites/${link.token}/accept`);
    expect(accept.statusCode).toBe(409);
    expect(accept.data.messageKey).toBe('invite_already_signed_up');
    const [row] = await app.db.select().from(users).where(eq(users.email, memberEmail));
    expect(row).toMatchObject({ canCreateWorkspaces: false, siteInvitedAt: null });
    expect((await new Client(app).get(`/api/invites/${link.token}`)).statusCode).toBe(200);
  });

  it('can be resent and revoked, and never show up in a workspace', async () => {
    const email = unique('later');
    const [invite] = (await admin.post('/api/admin/invites', { email })).data as SiteInvite[];
    await app.jobs.drain();
    inbox.length = 0;
    expect((await admin.post(`/api/admin/invites/${invite!.id}/resend`)).statusCode).toBe(200);
    await app.jobs.drain();
    expect(inbox.filter((m) => m.to === email)).toHaveLength(1);

    // The admin hasn't joined a workspace yet, so they may create their first.
    const slug = `siteinv-${n}`;
    expect((await admin.post('/api/workspaces', { name: 'Site', slug })).statusCode).toBe(200);
    const wsInvites = (await admin.get(`/api/w/${slug}/invites`)).data as Invite[];
    expect(wsInvites.some((i) => i.id === invite!.id)).toBe(false);
    await admin.del(`/api/w/${slug}/invites/${invite!.id}`);
    expect((await new Client(app).get(`/api/invites/${invite!.token}`)).statusCode).toBe(200);

    expect((await admin.del(`/api/admin/invites/${invite!.id}`)).statusCode).toBe(200);
    expect((await new Client(app).get(`/api/invites/${invite!.token}`)).statusCode).toBe(404);
    expect((await signupWith(email, invite!.token)).res.data.messageKey).toBe('invite_invalid');
  });

  it('lets admins grant and take back workspace creation per account', async () => {
    const id = (await me(member)).id;
    expect((await me(member)).canCreateWorkspace).toBe(false);
    expect(
      (await member.post('/api/workspaces', { name: 'More', slug: `more-${n}` })).statusCode,
    ).toBe(403);
    expect(
      (await admin.patch(`/api/admin/users/${id}`, { canCreateWorkspaces: true })).statusCode,
    ).toBe(200);
    const found = (await admin.get(`/api/admin/users?q=${encodeURIComponent(memberEmail)}`)).data;
    expect(found[0]).toMatchObject({ id, canCreateWorkspaces: true });
    expect((await me(member)).canCreateWorkspace).toBe(true);
    await admin.patch(`/api/admin/users/${id}`, { canCreateWorkspaces: false });
  });
});
