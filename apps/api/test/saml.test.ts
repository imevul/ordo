import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { samlServiceProvider } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userIdentities, users, workspaceMembers } from '../src/db/schema.ts';
import { Client, signup, testApp } from './helpers.ts';
import {
  assertion,
  envelope,
  form,
  IDP,
  OTHER_KEY,
  type ResponseOptions,
  readRequest,
  response,
  TRANSIENT,
} from './mock-saml-idp.ts';

let app: FastifyInstance;
let owner: Client;
let wsId: string;
const providerId = randomUUID();
const slug = `saml-${Date.now()}`;
const ws = `/api/w/${slug}`;
const domain = `${slug}.test`;
let sp: ReturnType<typeof samlServiceProvider>;
let n = 0;

const samlSettings = {
  idpEntityId: IDP.entityId,
  ssoUrl: IDP.ssoUrl,
  certificates: [IDP.cert],
};

beforeAll(async () => {
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  sp = samlServiceProvider(app.env.publicUrl, providerId);
  owner = (await signup(app, 'Saml Owner')).client;
  await owner.post('/api/workspaces', { name: 'Initech', slug, teamName: 'Core', teamKey: 'COR' });
  wsId = (await owner.get(`${ws}/bootstrap`)).data.workspace.id;
  const added = (await owner.post(`${ws}/domains`, { domain })).data;
  app.resolveTxt = async () => [[`ordo-verify=${added.verificationToken}`]];
  await owner.post(`${ws}/domains/${added.id}/verify`);
  const created = await owner.post(`${ws}/auth-providers`, {
    id: providerId,
    protocol: 'saml',
    name: 'Initech SAML',
    saml: samlSettings,
    trustEmail: true,
    groupClaim: 'groups',
    groupRoles: { 'ordo-admins': 'admin' },
  });
  expect(created.statusCode).toBe(200);
});
afterAll(async () => {
  await app.close();
});

const cookieOf = (set: string | string[] | undefined, name: string) =>
  (Array.isArray(set) ? set : [set]).find((c) => c?.startsWith(`${name}=`))?.split(';')[0];

type Request = ReturnType<typeof readRequest>;
const person = (local: string) => {
  const id = ++n;
  return { nameId: `${local}-${id}`, email: `${local}-${id}@${domain}` };
};
const options = (req: Request | null, p: { nameId: string; email?: string }): ResponseOptions => ({
  acsUrl: sp.acsUrl,
  audience: sp.entityId,
  inResponseTo: req?.id ?? null,
  nameId: p.nameId,
  attributes: {
    ...(p.email && { email: p.email }),
    displayName: `${p.nameId} person`,
  },
});

/** Start → IdP → ACS (cross-site POST) → complete. `build` writes the IdP's response. */
async function saml(
  p: { nameId: string; email?: string; groups?: string[] },
  opts: {
    client?: Client;
    mode?: 'login' | 'link' | 'test';
    build?: (req: Request) => string;
    relayState?: (req: Request) => string;
    stateCookie?: string | null;
  } = {},
) {
  const client = opts.client ?? new Client(app);
  // Linking starts with a POST that answers the URL; sign-in and tests are plain navigations.
  const start =
    opts.mode === 'link'
      ? await app.inject({
          method: 'POST',
          url: `/api/auth/sso/${providerId}/link`,
          headers: client.cookie ? { cookie: client.cookie } : {},
          payload: {},
        })
      : await app.inject({
          method: 'GET',
          url: `/api/auth/sso/${providerId}/start?mode=${opts.mode ?? 'login'}`,
          headers: client.cookie ? { cookie: client.cookie } : {},
        });
  expect(start.statusCode).toBe(opts.mode === 'link' ? 200 : 302);
  const req = readRequest(String(opts.mode === 'link' ? start.json().url : start.headers.location));
  const base = options(req, p);
  if (p.groups) base.attributes!.groups = p.groups;
  const xml = opts.build ? opts.build(req) : response(base);
  const acs = await app.inject({
    method: 'POST',
    url: `/api/auth/saml/${providerId}/acs`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://idp.saml.test',
      'sec-fetch-site': 'cross-site',
    },
    payload: form(xml, opts.relayState ? opts.relayState(req) : req.relayState),
  });
  if (acs.statusCode !== 303)
    return { client, req, acs, res: acs, xml, location: String(acs.headers.location ?? '') };
  const state =
    opts.stateCookie === undefined
      ? cookieOf(start.headers['set-cookie'], 'ordo_saml')
      : opts.stateCookie;
  const res = await app.inject({
    method: 'GET',
    url: String(acs.headers.location),
    headers: { cookie: [client.cookie, state].filter(Boolean).join('; ') },
  });
  const session = cookieOf(res.headers['set-cookie'], 'ordo_session');
  if (session) client.cookie = session;
  return { client, req, acs, res, xml, location: String(res.headers.location ?? '') };
}

const signedIn = (r: { res: { headers: Record<string, unknown> } }) =>
  !!cookieOf(r.res.headers['set-cookie'] as string[] | undefined, 'ordo_session');

const refused = (r: Awaited<ReturnType<typeof saml>>) => {
  expect(r.location).toMatch(/^\/login\?error=/);
  expect(signedIn(r)).toBe(false);
  return decodeURIComponent(r.location);
};

const roleOf = async (email: string) => {
  const [row] = await app.db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(users.email, email), eq(workspaceMembers.workspaceId, wsId)));
  return row?.role ?? null;
};

const metadataXml = (extra = '') =>
  `<?xml version="1.0"?>${extra}<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP.entityId}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${IDP.cert.replace(/-----[A-Z ]+-----|\s/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${OTHER_KEY.cert.replace(/-----[A-Z ]+-----|\s/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.saml.test/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP.ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe('providers', () => {
  it('keeps the chosen id and returns certificate details', async () => {
    const [p] = (await owner.get(`${ws}/auth-providers`)).data.providers;
    expect(p).toMatchObject({ id: providerId, protocol: 'saml', issuer: null, trustEmail: true });
    expect(p.saml.certificateInfo[0].subject).toContain('saml-idp.test');
    expect(new Date(p.saml.certificateInfo[0].notAfter).getFullYear()).toBeGreaterThan(2100);
    const again = await owner.post(`${ws}/auth-providers`, {
      id: providerId,
      protocol: 'saml',
      name: 'Twice',
      saml: samlSettings,
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses certificates that are not certificates, and settings of the other protocol', async () => {
    const bad = await owner.post(`${ws}/auth-providers`, {
      protocol: 'saml',
      name: 'Broken',
      saml: { ...samlSettings, certificates: ['not a certificate'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.data.messageKey).toBe('invalid_certificate');
    const mixed = await owner.patch(`${ws}/auth-providers/${providerId}`, {
      issuer: 'https://idp.example.com',
    });
    expect(mixed.statusCode).toBe(400);
  });

  it('publishes service provider metadata', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/auth/saml/${providerId}/metadata` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('samlmetadata+xml');
    expect(res.body).toContain(`entityID="${sp.entityId}"`);
    expect(res.body).toContain(`Location="${sp.acsUrl}"`);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/auth/saml/${randomUUID()}/metadata`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('reads IdP metadata, pasted or fetched, signing certificates only', async () => {
    const pasted = await owner.post(`${ws}/auth-providers/saml/metadata`, { xml: metadataXml() });
    expect(pasted.statusCode).toBe(200);
    expect(pasted.data).toMatchObject({
      idpEntityId: IDP.entityId,
      ssoUrl: IDP.ssoUrl,
      metadataUrl: null,
      nameIdFormats: ['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'],
    });
    expect(pasted.data.certificates).toHaveLength(1);

    const server: Server = createServer((_req, res) => res.end(metadataXml()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/metadata`;
    const fetched = await owner.post(`${ws}/auth-providers/saml/metadata`, { url });
    server.close();
    expect(fetched.data).toMatchObject({ idpEntityId: IDP.entityId, metadataUrl: url });

    const doctype = await owner.post(`${ws}/auth-providers/saml/metadata`, {
      xml: metadataXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'),
    });
    expect(doctype.statusCode).toBe(400);
    const postOnly = metadataXml().replace(
      /<md:SingleSignOnService Binding="[^"]+HTTP-Redirect"[^>]+>/,
      '',
    );
    expect(
      (await owner.post(`${ws}/auth-providers/saml/metadata`, { xml: postOnly })).statusCode,
    ).toBe(400);
  });
});

describe('sign-in', () => {
  it('creates and joins people from a trusted, verified domain', async () => {
    const p = person('new');
    const first = await saml(p);
    expect(first.acs.statusCode).toBe(303);
    expect(first.location).toBe(`/${slug}`);
    const me = (await first.client.get('/api/auth/me')).data;
    expect(me).toMatchObject({ email: p.email, name: `${p.nameId} person` });
    expect(await roleOf(p.email)).toBe('member');
    const again = await saml({ nameId: p.nameId });
    expect((await again.client.get('/api/auth/me')).data.id).toBe(me.id);
  });

  it('maps groups to roles', async () => {
    const p = person('boss');
    await saml({ ...p, groups: ['staff', 'ordo-admins'] });
    expect(await roleOf(p.email)).toBe('admin');
  });

  it('demotes on a later sign-in, but never an owner', async () => {
    const patched = await owner.patch(`${ws}/auth-providers/${providerId}`, {
      groupRoles: { 'ordo-admins': 'admin', contractors: 'guest' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const p = person('demoted');
    await saml({ ...p, groups: ['ordo-admins'] });
    expect(await roleOf(p.email)).toBe('admin');
    await saml({ ...p, groups: ['contractors'] });
    expect(await roleOf(p.email)).toBe('guest');

    const o = person('chief');
    await saml({ ...o, groups: ['ordo-admins'] });
    const [{ id }] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, o.email));
    expect((await owner.patch(`${ws}/members/${id}`, { role: 'owner' })).statusCode).toBe(200);
    await saml({ ...o, groups: ['contractors'] });
    expect(await roleOf(o.email)).toBe('owner');
  });

  it('shows admins the received attributes in test mode without signing anyone in', async () => {
    const r = await saml(
      { nameId: 'tester', email: `tester@${domain}` },
      { client: owner, mode: 'test' },
    );
    expect(r.res.statusCode).toBe(200);
    expect(r.res.body).toContain('tester person');
    expect(r.res.body).toContain('persistent NameID');
    expect(cookieOf(r.res.headers['set-cookie'], 'ordo_session')).toBeUndefined();
  });

  it('links an identity to the signed-in user', async () => {
    const someone = await signup(app, 'Linker');
    const me = (await someone.client.get('/api/auth/me')).data;
    await app.db.insert(workspaceMembers).values({ workspaceId: wsId, userId: me.id });
    const p = { nameId: `linked-${++n}`, email: `elsewhere-${n}@example.com` };
    const linked = await saml(p, { client: someone.client, mode: 'link' });
    expect(linked.location).not.toContain('error=');
    expect((await someone.client.get('/api/me/identities')).data).toHaveLength(1);
    const fresh = await saml(p);
    expect((await fresh.client.get('/api/auth/me')).data.email).toBe(someone.email);
  });

  it("matches emails only when the admin trusts the IdP's emails", async () => {
    await owner.patch(`${ws}/auth-providers/${providerId}`, { trustEmail: false });
    const p = person('untrusted');
    expect(refused(await saml(p))).toContain("isn't linked");
    const [none] = await app.db.select().from(users).where(eq(users.email, p.email));
    expect(none).toBeUndefined();
    await owner.patch(`${ws}/auth-providers/${providerId}`, { trustEmail: true });
    refused(await saml({ nameId: `other-${++n}`, email: `x-${n}@unverified.example` }));
  });

  it('refuses transient NameIDs, which change every sign-in', async () => {
    const p = person('transient');
    const r = await saml(p, {
      build: (req) => response({ ...options(req, p), nameIdFormat: TRANSIENT }),
    });
    expect(refused(r)).toContain('transient');
  });

  it('satisfies a workspace that requires SSO', async () => {
    const p = person('enforced');
    const member = (await saml(p)).client;
    await owner.patch(`${ws}/`, { settings: { requireSso: true } });
    expect((await member.get(`${ws}/bootstrap`)).statusCode).toBe(200);
    await owner.patch(`${ws}/`, { settings: { requireSso: false } });
  });
});

describe('refused responses', () => {
  const tampered = (change: Partial<ResponseOptions>) => (req: Request) =>
    response({ ...options(req, person('t')), ...change });

  it('for another audience, destination, recipient or issuer', async () => {
    refused(await saml(person('a'), { build: tampered({ audience: 'https://other.example/sp' }) }));
    refused(
      await saml(person('d'), { build: tampered({ destination: 'https://other.example/acs' }) }),
    );
    refused(
      await saml(person('r'), { build: tampered({ recipient: 'https://other.example/acs' }) }),
    );
    refused(await saml(person('r0'), { build: tampered({ recipient: null }) }));
    refused(await saml(person('i'), { build: tampered({ issuer: 'https://evil.test/idp' }) }));
  });

  it('outside its validity window (beyond two minutes of clock skew)', async () => {
    refused(await saml(person('old'), { build: tampered({ validFrom: -20, validFor: 10 }) }));
    refused(await saml(person('early'), { build: tampered({ validFrom: 10 }) }));
    const skewed = await saml(person('skew'), { build: tampered({ validFrom: 1, validFor: 6 }) });
    expect(signedIn(skewed)).toBe(true);
  });

  it('unsigned, or signed by another key', async () => {
    refused(await saml(person('u'), { build: tampered({ sign: false }) }));
    refused(await saml(person('k'), { build: tampered({ key: OTHER_KEY }) }));
  });

  it('unsolicited, or answering another attempt', async () => {
    refused(await saml(person('idp'), { build: tampered({ inResponseTo: null }) }));
    const other = await app.inject({ method: 'GET', url: `/api/auth/sso/${providerId}/start` });
    const otherReq = readRequest(String(other.headers.location));
    refused(await saml(person('x'), { build: tampered({ inResponseTo: otherReq.id }) }));
  });

  it('replayed', async () => {
    const first = await saml(person('replay'));
    expect(signedIn(first)).toBe(true);
    const again = await app.inject({
      method: 'POST',
      url: `/api/auth/saml/${providerId}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form(first.xml, first.req.relayState),
    });
    expect(String(again.headers.location)).toMatch(/^\/login\?error=/);
  });

  it('finished in another browser', async () => {
    refused(await saml(person('csrf'), { stateCookie: null }));
    refused(await saml(person('csrf2'), { stateCookie: 'ordo_saml=someone-elses' }));
  });

  it('with a DOCTYPE', async () => {
    const r = await saml(person('dtd'), {
      build: (req) => `<!DOCTYPE r [<!ENTITY x "y">]>${response(options(req, person('dtd')))}`,
    });
    expect(refused(r)).toContain('DOCTYPE');
  });

  describe('signature wrapping', () => {
    let victim: { nameId: string; email: string };
    beforeAll(async () => {
      victim = person('victim');
      expect(signedIn(await saml(victim))).toBe(true);
    });

    it('an unsigned assertion beside a signed one', async () => {
      const r = await saml(person('attacker'), {
        build: (req) => {
          const legit = assertion(options(req, person('attacker')));
          const evil = assertion({ ...options(req, victim), sign: false });
          return envelope(
            options(req, victim),
            `<samlp:Extensions>${legit}</samlp:Extensions>${evil}`,
          );
        },
      });
      refused(r);
    });

    it("an assertion carrying another assertion's signature", async () => {
      const r = await saml(person('attacker'), {
        build: (req) => {
          const legit = assertion(options(req, person('attacker')));
          const id = /ID="([^"]+)"/.exec(legit)![1]!;
          const signature = /<Signature[\s\S]*<\/Signature>/.exec(legit)![0];
          const unsigned = legit.replace(signature, '');
          const evil = assertion({ ...options(req, victim), sign: false })
            .replace(/ID="[^"]+"/, `ID="${id}"`)
            .replace(
              '</saml:Issuer>',
              `</saml:Issuer>${signature.replace('</Signature>', `<Object>${unsigned}</Object></Signature>`)}`,
            );
          return envelope(options(req, victim), evil);
        },
      });
      refused(r);
    });

    it('a comment splitting the NameID and email', async () => {
      const spoof = { nameId: `${victim.nameId}.evil`, email: `${victim.email}.evil.test` };
      const r = await saml(spoof, {
        build: (req) =>
          response(options(req, spoof))
            .replace(`>${spoof.nameId}<`, `>${victim.nameId}<!---->.evil<`)
            .replace(`>${spoof.email}<`, `>${victim.email}<!---->.evil.test<`),
      });
      // The signature still holds (comments aren't signed), but the whole text counts, not the
      // part before the comment: this is someone else, from a domain nobody verified.
      expect(r.acs.statusCode).toBe(303);
      refused(r);
      const [identity] = await app.db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.subject, victim.nameId));
      expect(identity).toBeDefined();
    });
  });

  it('when the provider is turned off', async () => {
    await owner.patch(`${ws}/auth-providers/${providerId}`, { enabled: false });
    const start = await app.inject({ method: 'GET', url: `/api/auth/sso/${providerId}/start` });
    expect(String(start.headers.location)).toMatch(/^\/login\?error=/);
    await owner.patch(`${ws}/auth-providers/${providerId}`, { enabled: true });
  });
});
