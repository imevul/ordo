import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Claims for the next sign-in (beyond iss/aud/nonce). */
  next: Record<string, unknown>;
  /** Overrides applied to the next ID token (e.g. a wrong `iss`). */
  tamper: Record<string, unknown>;
  close(): Promise<void>;
}

/**
 * A minimal OpenID provider for tests: discovery, authorize (auto-approves and redirects with a
 * code), token (checks client secret and PKCE, signs an RS256 ID token), userinfo and JWKS.
 */
/** `path` puts the provider under a sub-path, e.g. "/application/o/ordo/" like Authentik (trailing slash included). */
export async function startMockIdp(port = 0, path = ''): Promise<MockIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { claims: Record<string, unknown>; nonce: string; challenge: string; redirectUri: string }
  >();
  const tokens = new Map<string, Record<string, unknown>>();

  // Endpoints hang off the path without its trailing slash; the issuer keeps it.
  const base = path.replace(/\/+$/, '');
  let origin = '';
  const idp: MockIdp = {
    issuer: '',
    clientId: 'ordo-test',
    clientSecret: 'top-secret',
    next: {},
    tamper: {},
    close: () => new Promise((r) => server.close(() => r())),
  };

  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, idp.issuer);
    if (path && url.pathname.startsWith(base))
      url.pathname = url.pathname.slice(base.length) || '/';
    let body = '';
    for await (const chunk of req) body += chunk;
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: idp.issuer,
        authorization_endpoint: `${origin}${base}/authorize`,
        token_endpoint: `${origin}${base}/token`,
        userinfo_endpoint: `${origin}${base}/userinfo`,
        jwks_uri: `${origin}${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        claims: idp.next,
        nonce: p.get('nonce')!,
        challenge: p.get('code_challenge')!,
        redirectUri: p.get('redirect_uri')!,
      });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64')
            .toString()
            .split(':')
            .map(decodeURIComponent)
        : [form.get('client_id'), form.get('client_secret')];
      if (basic[0] !== idp.clientId || basic[1] !== idp.clientSecret)
        return json(res, 401, { error: 'invalid_client' });
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!grant || grant.redirectUri !== form.get('redirect_uri'))
        return json(res, 400, { error: 'invalid_grant' });
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (challenge !== grant.challenge)
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      const claims: Record<string, unknown> = {
        ...grant.claims,
        nonce: grant.nonce,
        ...idp.tamper,
      };
      idp.tamper = {};
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer((claims.iss as string) ?? idp.issuer)
        .setAudience(idp.clientId)
        .setSubject(String(grant.claims.sub))
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const accessToken = randomBytes(12).toString('hex');
      tokens.set(accessToken, grant.claims);
      return json(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      });
    }
    if (url.pathname === '/userinfo') {
      const claims = tokens.get(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      return claims ? json(res, 200, claims) : json(res, 401, { error: 'invalid_token' });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.issuer = `${origin}${path}`;
  return idp;
}
