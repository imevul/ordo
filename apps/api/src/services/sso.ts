import { randomBytes } from 'node:crypto';
import { AVATAR_COLORS, type MemberRole } from '@ordo/shared';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import type { Tx } from '../db/client.ts';
import {
  authProviders,
  authStates,
  userIdentities,
  users,
  workspaceDomains,
  workspaceMembers,
} from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import { safeFetch } from '../lib/safeFetch.ts';
import { audit } from './audit.ts';
import { joinWorkspace } from './workspaces.ts';

/**
 * OpenID Connect sign-in, configured per workspace.
 *
 * Users are instance-global, but each workspace brings its own identity provider. A provider is
 * trusted only for its own workspace's *verified* domains: an Ordo account is created or matched
 * by email only when the IdP says the email is verified and its domain is verified for that
 * workspace. Otherwise people link the identity explicitly while signed in. This stops a rogue or
 * misconfigured IdP from asserting someone else's address and taking over their account.
 */

type Provider = typeof authProviders.$inferSelect;
export const CALLBACK_PATH = '/api/auth/oidc/callback';
const STATE_TTL_MS = 10 * 60_000;
export const secretAad = (id: string) => `auth_providers:${id}:client_secret`;

const configs = new Map<string, { config: oidc.Configuration; at: number }>();

/** Discovers (and caches for 10 minutes) the provider's configuration, fetched through safeFetch. */
export async function providerConfig(
  app: FastifyInstance,
  provider: Provider,
): Promise<oidc.Configuration> {
  const key = `${provider.id}:${provider.updatedAt}`;
  const cached = configs.get(key);
  if (cached && Date.now() - cached.at < 600_000) return cached.config;
  const allowPrivate = app.settings.get('allowPrivateNetworkTargets');
  const customFetch: oidc.CustomFetch = async (url, init) => {
    const body =
      init.body instanceof URLSearchParams
        ? init.body.toString()
        : (init.body as string | undefined);
    const res = await safeFetch(url, {
      method: init.method,
      headers: Object.fromEntries(
        new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).entries(),
      ),
      body,
      allowPrivate,
    });
    return new Response(res.status === 204 ? null : res.body, {
      status: res.status,
      headers: res.headers,
    });
  };
  const discover = (issuer: string) =>
    oidc.discovery(
      new URL(issuer),
      provider.clientId,
      app.keyring.decrypt(provider.clientSecret, secretAad(provider.id)),
      undefined,
      {
        [oidc.customFetch]: customFetch,
        // Plain-http issuers are only reachable on private networks (e.g. a LAN Keycloak), which the
        // admin has to allow explicitly anyway.
        execute: issuer.startsWith('http://') && allowPrivate ? [oidc.allowInsecureRequests] : [],
      },
    );
  let config: oidc.Configuration;
  try {
    config = await discover(provider.issuer);
  } catch (err) {
    // Issuers must match to the character, and some end in "/" (Authentik) while others don't
    // (Keycloak). Admins paste either, so try the other spelling before giving up, and keep it.
    const other = provider.issuer.endsWith('/')
      ? provider.issuer.replace(/\/+$/, '')
      : `${provider.issuer}/`;
    try {
      config = await discover(other);
    } catch {
      throw err;
    }
    await app.db
      .update(authProviders)
      .set({ issuer: other })
      .where(eq(authProviders.id, provider.id));
    provider.issuer = other;
  }
  configs.set(key, { config, at: Date.now() });
  return config;
}

export async function beginLogin(
  app: FastifyInstance,
  provider: Provider,
  opts: { mode: 'login' | 'link' | 'test'; userId?: string | null; redirect?: string | null },
) {
  const config = await providerConfig(app, provider);
  const state = randomBytes(24).toString('base64url');
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  await app.db.insert(authStates).values({
    id: state,
    providerId: provider.id,
    nonce,
    codeVerifier,
    mode: opts.mode,
    userId: opts.userId ?? null,
    redirect:
      opts.redirect?.startsWith('/') && !opts.redirect.startsWith('//') ? opts.redirect : null,
    expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${app.env.publicUrl}${CALLBACK_PATH}`,
    scope: provider.scopes || 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    // Only the query response mode: a cross-site POST callback wouldn't carry our SameSite=Lax cookie.
    response_mode: 'query',
    state,
    nonce,
  });
  return { url: url.toString(), state };
}

export interface SsoClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

/** Exchanges the code. The state row binds the callback to its provider, so `iss` is checked against it. */
export async function completeLogin(
  app: FastifyInstance,
  callbackUrl: URL,
  cookieState: string | undefined,
) {
  const state = callbackUrl.searchParams.get('state');
  if (!state || state !== cookieState)
    throw badRequest('This sign-in attempt expired or came from another browser. Try again.');
  const [row] = await app.db.delete(authStates).where(eq(authStates.id, state)).returning();
  if (!row || new Date(row.expiresAt).getTime() < Date.now())
    throw badRequest('This sign-in attempt expired. Try again.');
  const [provider] = await app.db
    .select()
    .from(authProviders)
    .where(eq(authProviders.id, row.providerId));
  if (!provider || (!provider.enabled && row.mode !== 'test'))
    throw badRequest('This sign-in method is no longer available');
  const config = await providerConfig(app, provider);
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: row.codeVerifier,
    expectedState: row.id,
    expectedNonce: row.nonce,
    idTokenExpected: true,
  });
  let claims = (tokens.claims() ?? {}) as SsoClaims;
  // Some IdPs only put email and groups in the userinfo response.
  if (
    (!claims.email || (provider.groupClaim && !(provider.groupClaim in claims))) &&
    tokens.access_token
  ) {
    try {
      const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      claims = {
        ...info,
        ...claims,
        email: claims.email ?? info.email,
        email_verified: claims.email_verified ?? info.email_verified,
      } as SsoClaims;
    } catch {
      // userinfo is optional
    }
  }
  return { provider, state: row, claims };
}

/** The highest role any of the user's groups maps to, if the provider maps groups. */
export function roleFromGroups(
  provider: Provider,
  claims: SsoClaims,
): 'admin' | 'member' | 'guest' | null {
  if (!provider.groupClaim) return null;
  const raw = claims[provider.groupClaim];
  const groups = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : [];
  const roles = groups.map((g) => provider.groupRoles[g]).filter(Boolean);
  for (const r of ['admin', 'member', 'guest'] as const) if (roles.includes(r)) return r;
  return null;
}

async function domainVerifiedFor(tx: Tx, workspaceId: string, email: string) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const [row] = await tx
    .select({ id: workspaceDomains.id })
    .from(workspaceDomains)
    .where(
      and(
        eq(workspaceDomains.workspaceId, workspaceId),
        eq(workspaceDomains.domain, domain),
        isNotNull(workspaceDomains.verifiedAt),
      ),
    );
  return !!row;
}

async function uniqueUsername(tx: Tx, base: string) {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 24) || 'user';
  let candidate = clean.length >= 2 ? clean : `${clean}user`;
  for (let i = 2; ; i++) {
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate));
    if (!taken) return candidate;
    candidate = `${clean}${i}`;
  }
}

export class SsoError extends Error {}

/**
 * Resolves the Ordo user for a completed login, creating or linking only when the takeover
 * guard allows, and makes sure they belong to the provider's workspace with the right role.
 */
export async function resolveSsoUser(
  app: FastifyInstance,
  provider: Provider,
  claims: SsoClaims,
  ip: string | null,
) {
  return app.db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const [identity] = await tx
      .select()
      .from(userIdentities)
      .where(
        and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, claims.sub)),
      );
    let userId = identity?.userId ?? null;
    const email = claims.email?.toLowerCase();
    const trusted =
      !!email &&
      claims.email_verified === true &&
      (await domainVerifiedFor(tx, provider.workspaceId, email));

    if (!userId) {
      if (!trusted) {
        throw new SsoError(
          "This sign-in isn't linked to an Ordo account. Sign in another way, then connect it under Settings → Connected accounts.",
        );
      }
      const [existing] = await tx.select().from(users).where(eq(users.email, email!));
      if (existing) userId = existing.id;
      else {
        const [created] = await tx
          .insert(users)
          .values({
            email: email!,
            name: claims.name || claims.preferred_username || email!.split('@')[0]!,
            username: await uniqueUsername(tx, claims.preferred_username || email!.split('@')[0]!),
            passwordHash: null,
            emailVerifiedAt: now,
            avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
          })
          .returning({ id: users.id });
        userId = created!.id;
        await audit(
          tx,
          { action: 'auth.signup', actorId: userId, data: { via: 'sso', provider: provider.name } },
          { ip, userAgent: null },
        );
      }
      await tx
        .insert(userIdentities)
        .values({ userId, providerId: provider.id, subject: claims.sub, email: email ?? null });
      await audit(
        tx,
        {
          action: 'auth.identity_linked',
          workspaceId: provider.workspaceId,
          actorId: userId,
          data: { provider: provider.name, auto: true },
        },
        { ip, userAgent: null },
      );
    }

    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user || user.disabledAt || user.kind !== 'human')
      throw new SsoError('This account has been disabled. Contact your administrator.');
    await tx
      .update(userIdentities)
      .set({ lastLoginAt: now, email: email ?? null })
      .where(
        and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, claims.sub)),
      );

    // Membership: join on first SSO login (domain-trusted only); group mappings apply every time.
    const mapped = roleFromGroups(provider, claims);
    const [membership] = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, provider.workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      );
    if (!membership) {
      if (trusted)
        await joinWorkspace(
          tx,
          provider.workspaceId,
          user.id,
          (mapped ?? provider.defaultRole) as MemberRole,
        );
    } else if (mapped && membership.role !== 'owner' && membership.role !== mapped) {
      await tx
        .update(workspaceMembers)
        .set({ role: mapped })
        .where(
          and(
            eq(workspaceMembers.workspaceId, provider.workspaceId),
            eq(workspaceMembers.userId, user.id),
          ),
        );
      await audit(
        tx,
        {
          action: 'member.role_changed',
          workspaceId: provider.workspaceId,
          actorId: null,
          targetType: 'user',
          targetId: user.id,
          data: { role: mapped, via: 'sso_groups' },
        },
        { ip, userAgent: null },
      );
    }
    return user;
  });
}

/** Links an identity to a signed-in user (explicit linking needs no domain trust). */
export async function linkIdentity(
  app: FastifyInstance,
  provider: Provider,
  claims: SsoClaims,
  userId: string,
) {
  const [taken] = await app.db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, claims.sub)));
  if (taken && taken.userId !== userId)
    throw new SsoError('That identity is already linked to another Ordo account.');
  if (!taken) {
    await app.db.insert(userIdentities).values({
      userId,
      providerId: provider.id,
      subject: claims.sub,
      email: claims.email?.toLowerCase() ?? null,
    });
    await audit(app.db, {
      action: 'auth.identity_linked',
      workspaceId: provider.workspaceId,
      actorId: userId,
      data: { provider: provider.name },
    });
  }
}

export async function purgeExpiredStates(app: FastifyInstance) {
  await app.db.delete(authStates).where(lt(authStates.expiresAt, sql`now()`));
}
