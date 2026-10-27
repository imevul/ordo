import { randomBytes, X509Certificate } from 'node:crypto';
import { type CacheProvider, type Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { type SamlCertificateInfo, type SamlSettings, samlServiceProvider } from '@ordo/shared';
import { DOMParser, type XmlElement } from '@xmldom/xmldom/lib/dom-parser.js';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authProviders, authStates } from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import { safeFetch } from '../lib/safeFetch.ts';
import { type Provider, type SsoClaims, STATE_TTL_MS, safeRedirect, takeState } from './sso.ts';

/**
 * SAML 2.0 sign-in: SP-initiated only, AuthnRequest over HTTP-Redirect, signed assertions back
 * over HTTP-POST.
 *
 * The response arrives as a cross-site POST, which carries none of our SameSite=Lax cookies. So
 * the ACS only validates it and parks the claims on the sign-in attempt, then sends the browser on
 * (303) to a GET that does carry the cookie; that GET checks it's the browser that started, and
 * finishes. Defences against signature wrapping and replay: assertions must be signed by one of the
 * configured certificates, identity comes only from the verified assertion, the response must answer
 * this attempt's AuthnRequest (no IdP-initiated sign-in), Issuer, Audience, Destination and Recipient
 * must match, and any DOCTYPE is refused.
 */

export const SAML_COOKIE = 'ordo_saml';
export const SAML_COOKIE_PATH = '/api/auth/saml';

const MAX_RESPONSE_BYTES = 512 * 1024;
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const NAMEID_TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';

// The usual attribute names, in order of preference, when the admin hasn't named one.
const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_ATTRIBUTES = [
  'displayName',
  'name',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'cn',
];
const GIVEN_NAME = ['givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
const SURNAME = ['sn', 'surname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];

export const serviceProvider = (app: FastifyInstance, providerId: string) =>
  samlServiceProvider(app.env.publicUrl, providerId);

/** The message for anything wrong with a SAML response; details go to the log, not the page. */
export class SamlError extends Error {}

// ─── certificates ────────────────────────────────────────────────────────

/** Accepts PEM or bare base64 (as metadata has it) and returns PEM, or throws if it isn't one. */
export function normalizeCertificate(input: string) {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`;
  try {
    new X509Certificate(pem);
  } catch {
    throw badRequest("That isn't an X.509 certificate").as('invalid_certificate');
  }
  return pem;
}

export function certificateInfo(pem: string): SamlCertificateInfo {
  try {
    const cert = new X509Certificate(pem);
    return {
      subject: cert.subject.replace(/\n/g, ', '),
      notAfter: new Date(cert.validTo).toISOString(),
      fingerprint: cert.fingerprint256,
    };
  } catch {
    return { subject: '?', notAfter: '', fingerprint: '' };
  }
}

// ─── the flow ────────────────────────────────────────────────────────────

function samlSettings(provider: Provider) {
  if (provider.protocol !== 'saml' || !provider.saml) throw new Error('Not a SAML provider');
  return provider.saml;
}

/** A node-saml client for one provider; `requestId` is the one AuthnRequest a response may answer. */
function client(app: FastifyInstance, provider: Provider, requestId: string | null = null) {
  const settings = samlSettings(provider);
  const sp = serviceProvider(app, provider.id);
  let issued: string | null = null;
  // Request IDs live on the sign-in attempt (auth_states), not in node-saml's process memory.
  const cacheProvider: CacheProvider = {
    async saveAsync(key, value) {
      issued = key;
      return { value, createdAt: Date.now() };
    },
    // node-saml reads the value as when the request was made; the attempt's own expiry is checked
    // before this runs, so "now" just passes its age check.
    async getAsync(key) {
      return requestId !== null && key === requestId ? new Date().toISOString() : null;
    },
    async removeAsync() {
      return null;
    },
  };
  const saml = new SAML({
    entryPoint: settings.ssoUrl,
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    audience: sp.entityId,
    idpCert: settings.certificates,
    idpIssuer: settings.idpEntityId,
    identifierFormat: settings.nameIdFormat,
    wantAssertionsSigned: true,
    // Most IdPs sign only the assertion; that's the part identity is read from.
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 120_000,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: STATE_TTL_MS,
    cacheProvider,
    // Asking for password authentication would turn away people who use passkeys or MFA at the IdP.
    disableRequestedAuthnContext: true,
  });
  return { saml, issued: () => issued };
}

export async function beginSamlLogin(
  app: FastifyInstance,
  provider: Provider,
  opts: { mode: 'login' | 'link' | 'test'; userId?: string | null; redirect?: string | null },
) {
  const state = randomBytes(24).toString('base64url');
  const { saml, issued } = client(app, provider);
  // RelayState carries the attempt's id through the IdP and back.
  const url = await saml.getAuthorizeUrlAsync(state, undefined, {});
  const requestId = issued();
  if (!requestId) throw new Error('No AuthnRequest ID');
  await app.db.insert(authStates).values({
    id: state,
    providerId: provider.id,
    requestId,
    mode: opts.mode,
    userId: opts.userId ?? null,
    redirect: safeRedirect(opts.redirect),
    expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  return { url, state };
}

const parseXml = (xml: string) => {
  // Entities and external subsets are where XML parsers get into trouble; SAML never needs them.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SamlError('DOCTYPE is not allowed');
  let failed: string | null = null;
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (msg: string) => {
        failed = msg;
      },
      fatalError: (msg: string) => {
        failed = msg;
      },
    },
  }).parseFromString(xml, 'text/xml');
  if (failed || !doc?.documentElement) throw new SamlError(`Not valid XML (${failed ?? 'empty'})`);
  return doc;
};

const children = (el: XmlElement, ns: string, name: string) =>
  Array.from(el.getElementsByTagNameNS(ns, name));

/**
 * The ACS: checks a response against the attempt named by RelayState and parks the claims there.
 * Returns the attempt's id for the browser to finish with.
 */
export async function receiveSamlResponse(
  app: FastifyInstance,
  providerId: string,
  body: { SAMLResponse?: unknown; RelayState?: unknown },
) {
  const relayState = typeof body.RelayState === 'string' ? body.RelayState : '';
  const encoded = typeof body.SAMLResponse === 'string' ? body.SAMLResponse : '';
  if (!relayState) throw new SamlError('No RelayState: sign-ins must start at Ordo');
  if (!encoded || encoded.length > (MAX_RESPONSE_BYTES * 4) / 3)
    throw new SamlError('Missing or oversized SAMLResponse');

  const [row] = await app.db
    .select()
    .from(authStates)
    .where(
      and(
        eq(authStates.id, relayState),
        eq(authStates.providerId, providerId),
        isNull(authStates.claims),
        gt(authStates.expiresAt, new Date().toISOString()),
      ),
    );
  if (!row?.requestId) throw new SamlError('This sign-in attempt expired or was already used');
  const { provider } = await peekProvider(app, row.providerId, row.mode);
  const settings = samlSettings(provider);
  const sp = serviceProvider(app, provider.id);

  const xml = Buffer.from(encoded, 'base64').toString('utf8');
  const response = parseXml(xml).documentElement!;
  if (
    response.localName !== 'Response' ||
    response.namespaceURI !== 'urn:oasis:names:tc:SAML:2.0:protocol'
  )
    throw new SamlError('Not a SAML response');
  const destination = response.getAttribute('Destination');
  if (destination && destination !== sp.acsUrl) throw new SamlError('Wrong Destination');

  const { saml } = client(app, provider, row.requestId);
  let profile: Profile | null;
  try {
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: encoded }));
  } catch (err) {
    throw new SamlError(err instanceof Error ? err.message : String(err));
  }
  if (!profile?.getAssertionXml) throw new SamlError('No assertion');

  // node-saml checks the signature, times, audience and InResponseTo. The rest is read from the
  // assertion it verified, never from the unsigned envelope around it.
  const assertion = parseXml(profile.getAssertionXml()).documentElement!;
  const issuer = Array.from(assertion.childNodes).find((n) => n.localName === 'Issuer');
  if (issuer?.textContent?.trim() !== settings.idpEntityId) throw new SamlError('Wrong Issuer');
  const recipients = children(assertion, ASSERTION, 'SubjectConfirmationData').map((d) =>
    d.getAttribute('Recipient'),
  );
  if (!recipients.length || recipients.some((r) => r !== sp.acsUrl))
    throw new SamlError('Wrong or missing Recipient');
  if (!profile.nameID) throw new SamlError('No NameID');
  if (profile.nameIDFormat === NAMEID_TRANSIENT && row.mode !== 'test')
    throw new SamlError(
      'The identity provider sent a transient NameID, which changes every time. Ask your administrator to send a persistent one.',
    );

  const claims = samlClaims(profile, settings);
  const [saved] = await app.db
    .update(authStates)
    .set({ claims })
    .where(and(eq(authStates.id, row.id), isNull(authStates.claims)))
    .returning({ id: authStates.id });
  if (!saved) throw new SamlError('This sign-in attempt was already used');
  return saved.id;
}

async function peekProvider(app: FastifyInstance, providerId: string, mode: string) {
  const [provider] = await app.db
    .select()
    .from(authProviders)
    .where(eq(authProviders.id, providerId));
  if (provider?.protocol !== 'saml' || (!provider.enabled && mode !== 'test'))
    throw new SamlError('This sign-in method is no longer available');
  return { provider };
}

/** SAML attributes as the claims the rest of SSO reads (sub, email, name, groups by attribute). */
export function samlClaims(profile: Profile, settings: SamlSettings): SsoClaims {
  const attributes = (profile.attributes ?? {}) as Record<string, unknown>;
  const first = (names: (string | null)[]) => {
    for (const name of names) {
      if (!name) continue;
      const value = attributes[name];
      const one = Array.isArray(value) ? value[0] : value;
      if (typeof one === 'string' && one.trim()) return one.trim();
    }
    return undefined;
  };
  const email =
    first([settings.emailAttribute, ...EMAIL_ATTRIBUTES]) ??
    (profile.nameIDFormat === NAMEID_EMAIL ? profile.nameID : undefined);
  const given = first(GIVEN_NAME);
  const surname = first(SURNAME);
  const name =
    first([settings.nameAttribute, ...NAME_ATTRIBUTES]) ??
    ([given, surname].filter(Boolean).join(' ') || undefined);
  return {
    ...attributes,
    sub: profile.nameID,
    nameIdFormat: profile.nameIDFormat,
    ...(email && { email }),
    ...(name && { name }),
  };
}

/** The browser is back with its cookie: hands over what the ACS parked for this attempt. */
export async function completeSamlLogin(
  app: FastifyInstance,
  state: string | null | undefined,
  cookieState: string | undefined,
) {
  const result = await takeState(app, state, cookieState);
  if (result.provider.protocol !== 'saml' || !result.state.claims)
    throw badRequest('This sign-in attempt expired. Try again.').as('sign_in_expired');
  return { ...result, claims: result.state.claims as SsoClaims };
}

export function serviceProviderMetadata(app: FastifyInstance, provider: Provider) {
  return client(app, provider).saml.generateServiceProviderMetadata(null, null);
}

// ─── IdP metadata ────────────────────────────────────────────────────────

/** Reads the settings Ordo needs out of an IdP's metadata XML. */
export function parseIdpMetadata(xml: string): Omit<SamlSettings, 'metadataUrl'> & {
  nameIdFormats: string[];
} {
  let doc: ReturnType<typeof parseXml>;
  try {
    doc = parseXml(xml);
  } catch (err) {
    throw badRequest(`That metadata couldn't be read: ${(err as Error).message}`);
  }
  const entities = Array.from(doc.getElementsByTagNameNS(MD, 'EntityDescriptor'));
  const entity = entities.find((e) => children(e, MD, 'IDPSSODescriptor').length > 0);
  const idp = entity && children(entity, MD, 'IDPSSODescriptor')[0];
  if (!entity || !idp) throw badRequest('That metadata describes no identity provider');
  const sso = children(idp, MD, 'SingleSignOnService').find(
    (s) => s.getAttribute('Binding') === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  );
  if (!sso?.getAttribute('Location'))
    throw badRequest('That identity provider offers no HTTP-Redirect sign-in');
  const certificates = children(idp, MD, 'KeyDescriptor')
    .filter((k) => (k.getAttribute('use') ?? 'signing') === 'signing')
    .flatMap((k) => children(k, DSIG, 'X509Certificate'))
    .map((c) => normalizeCertificate(c.textContent ?? ''));
  if (!certificates.length) throw badRequest('That metadata has no signing certificate');
  return {
    idpEntityId: entity.getAttribute('entityID') ?? '',
    ssoUrl: sso.getAttribute('Location')!,
    certificates: [...new Set(certificates)],
    nameIdFormat: null,
    emailAttribute: null,
    nameAttribute: null,
    nameIdFormats: children(idp, MD, 'NameIDFormat').map((n) => n.textContent?.trim() ?? ''),
  };
}

export async function fetchIdpMetadata(app: FastifyInstance, url: string) {
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(url, {
      allowPrivate: app.settings.get('allowPrivateNetworkTargets'),
      headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
      maxBytes: 2_000_000,
    });
  } catch (err) {
    throw badRequest(`Fetching the metadata failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw badRequest(`Fetching the metadata failed (HTTP ${res.status})`);
  return res.text();
}
