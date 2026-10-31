export const rolesToText = (roles: Record<string, string>) =>
  Object.entries(roles)
    .map(([group, role]) => `${group} = ${role}`)
    .join('\n');

export function textToRoles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [group, role] = line.split('=').map((s) => s.trim());
    if (group && role) out[group] = role;
  }
  return out;
}

export const NAMEID_FORMATS = [
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
];

/** Certificates as pasted: PEM blocks, or one bare base64 body. */
export const splitCertificates = (text: string) => {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return blocks ?? (text.trim() ? [text.trim()] : []);
};

export const emptyForm = () => ({
  protocol: 'oidc' as 'oidc' | 'saml',
  name: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  idpEntityId: '',
  ssoUrl: '',
  certificates: '',
  nameIdFormat: '',
  emailAttribute: '',
  nameAttribute: '',
  metadataUrl: '',
  trustEmail: false,
  enabled: true,
  defaultRole: 'member' as 'member' | 'guest',
  groupClaim: '',
  groupRoles: '',
});
