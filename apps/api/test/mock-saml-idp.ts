import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import { escapeHtml as esc } from '../src/lib/html.ts';

/**
 * A SAML identity provider for tests: reads Ordo's AuthnRequest and writes the response an IdP
 * would post back, signed with a fixture key (test/fixtures, made for these tests only). Options
 * make it misbehave: wrong audience or issuer, expired, unsigned, signed by another key, wrapped.
 */

// xml-crypto's types pull the browser DOM library into the API's whole program; this is all we use.
interface SignedXml {
  addReference(ref: { xpath: string; transforms: string[]; digestAlgorithm: string }): void;
  computeSignature(
    xml: string,
    options: { location: { reference: string; action: 'after' | 'append' } },
  ): void;
  getSignedXml(): string;
}
const { SignedXml } = createRequire(import.meta.url)('xml-crypto') as {
  SignedXml: new (options: {
    privateKey: string;
    publicCert: string;
    signatureAlgorithm: string;
    canonicalizationAlgorithm: string;
  }) => SignedXml;
};

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export const IDP = {
  entityId: 'https://idp.saml.test/metadata',
  ssoUrl: 'https://idp.saml.test/sso',
  cert: fixture('saml-idp.crt'),
  key: fixture('saml-idp.key'),
};
export const OTHER_KEY = { cert: fixture('saml-other.crt'), key: fixture('saml-other.key') };

const SAML = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP = 'urn:oasis:names:tc:SAML:2.0:protocol';
export const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

/** The AuthnRequest in the redirect Ordo sent the browser to. */
export function readRequest(location: string) {
  const url = new URL(location);
  const xml = inflateRawSync(
    Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64'),
  ).toString();
  return {
    id: /\sID="([^"]+)"/.exec(xml)![1]!,
    relayState: url.searchParams.get('RelayState')!,
    xml,
    url,
  };
}

export interface ResponseOptions {
  acsUrl: string;
  audience: string;
  /** The request being answered; null for an unsolicited (IdP-initiated) response. */
  inResponseTo: string | null;
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string | string[]>;
  issuer?: string;
  destination?: string | null;
  recipient?: string | null;
  /** Minutes from now; negative for the past. */
  validFrom?: number;
  validFor?: number;
  sign?: boolean;
  key?: { cert: string; key: string };
}

/** A signed assertion on its own. */
export function assertion(o: ResponseOptions) {
  const now = Date.now();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const from = o.validFrom ?? -1;
  const until = from + (o.validFor ?? 6);
  const id = `_a${randomUUID().replace(/-/g, '')}`;
  const attrs = Object.entries(o.attributes ?? {})
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${esc(name)}">${(Array.isArray(value) ? value : [value])
          .map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`)
          .join('')}</saml:Attribute>`,
    )
    .join('');
  const recipient = o.recipient === undefined ? o.acsUrl : o.recipient;
  const xml =
    `<saml:Assertion xmlns:saml="${SAML}" ID="${id}" IssueInstant="${at(0)}" Version="2.0">` +
    `<saml:Issuer>${esc(o.issuer ?? IDP.entityId)}</saml:Issuer>` +
    '<saml:Subject>' +
    `<saml:NameID Format="${o.nameIdFormat ?? PERSISTENT}">${esc(o.nameId)}</saml:NameID>` +
    '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">' +
    `<saml:SubjectConfirmationData NotOnOrAfter="${at(until)}"` +
    (recipient ? ` Recipient="${esc(recipient)}"` : '') +
    (o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '') +
    '/></saml:SubjectConfirmation></saml:Subject>' +
    `<saml:Conditions NotBefore="${at(from)}" NotOnOrAfter="${at(until)}">` +
    `<saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction>` +
    '</saml:Conditions>' +
    `<saml:AuthnStatement AuthnInstant="${at(0)}" SessionIndex="${id}">` +
    '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>' +
    '</saml:AuthnStatement>' +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '') +
    '</saml:Assertion>';
  if (o.sign === false) return xml;
  const key = o.key ?? IDP;
  const sig = new SignedXml({
    privateKey: key.key,
    publicCert: key.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "/*[local-name(.)='Assertion']",
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, {
    location: {
      reference: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: 'after',
    },
  });
  return sig.getSignedXml();
}

/** The Response envelope around one or more assertions (or anything else, for attacks). */
export function envelope(o: ResponseOptions, inner: string) {
  const destination = o.destination === undefined ? o.acsUrl : o.destination;
  return (
    `<samlp:Response xmlns:samlp="${SAMLP}" xmlns:saml="${SAML}" ID="_r${randomUUID().replace(/-/g, '')}" Version="2.0" IssueInstant="${new Date().toISOString()}"` +
    (destination ? ` Destination="${esc(destination)}"` : '') +
    (o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '') +
    '>' +
    `<saml:Issuer>${esc(o.issuer ?? IDP.entityId)}</saml:Issuer>` +
    '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>' +
    inner +
    '</samlp:Response>'
  );
}

export const response = (o: ResponseOptions) => envelope(o, assertion(o));

/** The form an IdP's page auto-submits to the ACS. */
export const form = (xml: string, relayState: string) =>
  new URLSearchParams({
    SAMLResponse: Buffer.from(xml).toString('base64'),
    RelayState: relayState,
  }).toString();
