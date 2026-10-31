import { AVATAR_COLORS, isOwnerRole, type MemberRole } from '@ordo/shared';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  authProviders,
  authStates,
  userIdentities,
  users,
  workspaceDomains,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { createSession } from '../lib/auth.ts';
import { badRequest, one } from '../lib/errors.ts';
import { escapeHtml as esc } from '../lib/html.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from './audit.ts';
import type { RequestMeta } from './context.ts';
import { publishChanges } from './sync.ts';
import { joinWorkspace, workspaceSettings } from './workspaces.ts';

/**
 * Single sign-on, configured per workspace. The protocol (oidc.ts) proves who someone is at their
 * identity provider; this file decides which Ordo account that is.
 *
 * Users are instance-global, but each workspace brings its own identity provider. A provider is
 * trusted only for its own workspace's *verified* domains: an Ordo account is created or matched
 * by email only when the IdP says the email is verified and its domain is verified for that
 * workspace. Otherwise people link the identity explicitly while signed in. This stops a rogue or
 * misconfigured IdP from asserting someone else's address and taking over their account.
 */

export type Provider = typeof authProviders.$inferSelect;
export const STATE_TTL_MS = 10 * 60_000;

/**
 * Where to go after signing in: only paths on this site. Browsers read `\` as `/`, so `/\evil.com`
 * is another site too; control characters are refused because browsers drop them before parsing.
 */
export function safeRedirect(redirect: string | null | undefined) {
  if (!redirect?.startsWith('/') || redirect.startsWith('//') || redirect.includes('\\'))
    return null;
  for (const ch of redirect) if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return null;
  return redirect;
}

/**
 * Takes the sign-in attempt that a callback belongs to. Each is good once, for ten minutes, and
 * only in the browser that started it (the cookie).
 */
export async function takeState(
  app: FastifyInstance,
  state: string | null | undefined,
  cookieState: string | undefined,
) {
  if (!state || state !== cookieState)
    throw badRequest('This sign-in attempt expired or came from another browser. Try again.').as(
      'sign_in_expired_browser',
    );
  const [row] = await app.db.delete(authStates).where(eq(authStates.id, state)).returning();
  if (!row || new Date(row.expiresAt).getTime() < Date.now())
    throw badRequest('This sign-in attempt expired. Try again.').as('sign_in_expired');
  const [provider] = await app.db
    .select()
    .from(authProviders)
    .where(eq(authProviders.id, row.providerId));
  if (!provider || (!provider.enabled && row.mode !== 'test'))
    throw badRequest('This sign-in method is no longer available').as('sign_in_method_gone');
  return { state: row, provider };
}

/** What a protocol hands over about the person; OIDC claims by name, other protocols mapped to them. */
export interface SsoClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
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

export async function domainVerifiedFor(tx: DbOrTx, workspaceId: string, email: string) {
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

export async function uniqueUsername(tx: DbOrTx, base: string) {
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

/**
 * The account an identity that proves `email` (SSO at a verified domain, SCIM) may take over, if
 * any. An unverified account never proved the address: anyone can create one through open sign-up,
 * an open invite or an email change without mail, to sit there until the real person arrives. So
 * it isn't linked; it moves to an address of its own (and can't sign in by email any more) and the
 * caller creates a fresh account. Bots and placeholders come back as they are, for the caller to refuse.
 */
export async function claimableUser(
  tx: DbOrTx,
  email: string,
  entry: { workspaceId: string; actorId: string | null; via: 'sso' | 'scim' },
  meta: RequestMeta | null,
) {
  const [existing] = await tx
    .select({ id: users.id, kind: users.kind, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.email, email));
  if (!existing || existing.emailVerifiedAt || existing.kind !== 'human') return existing ?? null;
  const released = `unverified-${existing.id}@released.ordo.invalid`;
  await tx
    .update(users)
    .set({ email: released, updatedAt: new Date().toISOString() })
    .where(eq(users.id, existing.id));
  await audit(
    tx,
    {
      action: 'auth.email_changed',
      workspaceId: entry.workspaceId,
      actorId: entry.actorId,
      targetType: 'user',
      targetId: existing.id,
      data: { from: email, to: released, via: entry.via, reason: 'unverified_address_claimed' },
    },
    meta,
  );
  return null;
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
  emailTrusted: boolean,
) {
  let membershipChanged = false;
  const user = await app.db.transaction(async (tx) => {
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
      !!email && emailTrusted && (await domainVerifiedFor(tx, provider.workspaceId, email));

    if (!userId) {
      if (!trusted) {
        throw new SsoError(
          "This sign-in isn't linked to an Ordo account. Sign in another way, then connect it under Settings → Connected accounts.",
        );
      }
      const existing = await claimableUser(
        tx,
        email!,
        { workspaceId: provider.workspaceId, actorId: null, via: 'sso' },
        { ip, userAgent: null },
      );
      if (existing) userId = existing.id;
      else {
        const created = one(
          await tx
            .insert(users)
            .values({
              email: email!,
              name: claims.name || claims.preferred_username || email!.split('@')[0]!,
              username: await uniqueUsername(
                tx,
                claims.preferred_username || email!.split('@')[0]!,
              ),
              passwordHash: null,
              emailVerifiedAt: now,
              avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
            })
            .returning({ id: users.id }),
        );
        userId = created.id;
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
      if (trusted) {
        await joinWorkspace(
          tx,
          provider.workspaceId,
          user.id,
          (mapped ?? provider.defaultRole) as MemberRole,
        );
        membershipChanged = true;
      }
    } else if (mapped && !isOwnerRole(membership.role) && membership.role !== mapped) {
      membershipChanged = true;
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
  if (membershipChanged)
    await publishChanges(app, [
      {
        kind: 'member',
        action: 'updated',
        id: user.id,
        workspaceId: provider.workspaceId,
        actorId: user.id,
      },
    ]);
  return user;
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

export const LAST_SSO_COOKIE = 'ordo_last_sso';

export const loginError = (reply: FastifyReply, message: string) =>
  reply.redirect(`/login?error=${encodeURIComponent(message)}`);

/**
 * The end of every sign-in, whatever the protocol: show an admin's test, link the identity to the
 * signed-in user, or sign in. `emailTrusted` is the protocol's word that the email is the person's.
 */
export async function finishSso(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  {
    provider,
    state,
    claims,
    emailTrusted,
  }: {
    provider: Provider;
    state: typeof authStates.$inferSelect;
    claims: SsoClaims;
    emailTrusted: boolean;
  },
) {
  const { db } = app;

  if (state.mode === 'test') {
    // Shows an admin exactly what the provider sends, without signing anyone in.
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    // SAML's subject is the NameID, and its emails are only as trusted as the admin says.
    const needs =
      provider.protocol === 'saml'
        ? '<b>sub</b> (a persistent NameID), an <b>email</b>'
        : '<b>sub</b>, a verified <b>email</b>';
    return reply.send(`<!doctype html><body style="background:#09090b;color:#fff4fa;font:14px ui-monospace,monospace;padding:32px">
      <p style="color:#ff1493">// ${esc(provider.name)} works</p>
      <p style="color:#b8aab2">These are the claims Ordo received. Ordo needs ${needs}${provider.groupClaim ? ` and <b>${esc(provider.groupClaim)}</b>` : ''}.</p>
      <pre style="background:#121214;border:1px solid #49313e;padding:16px;white-space:pre-wrap">${esc(JSON.stringify(claims, null, 2))}</pre>
      <p><a style="color:#ff5cb8" href="${esc(state.redirect ?? '/')}">Back to Ordo</a></p></body>`);
  }

  if (state.mode === 'link') {
    try {
      await linkIdentity(app, provider, claims, state.userId!);
    } catch (err) {
      return reply.redirect(
        `${state.redirect ?? '/'}?error=${encodeURIComponent(err instanceof Error ? err.message : 'Linking failed')}`,
      );
    }
    return reply.redirect(state.redirect ?? '/');
  }

  try {
    const user = await resolveSsoUser(app, provider, claims, req.ip ?? null, emailTrusted);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, provider.workspaceId));
    const maxAge = ws ? workspaceSettings(ws).ssoSessionMaxAgeHours : null;
    await createSession(app, reply, user.id, req, {
      authProviderId: provider.id,
      ssoExpiresAt: maxAge ? new Date(Date.now() + maxAge * 3_600_000).toISOString() : null,
    });
    // Lets the sign-in page offer this provider first next time, on this device only. Readable
    // by the page on purpose; it holds nothing that isn't on the login screen anyway.
    reply.setCookie(
      LAST_SSO_COOKIE,
      Buffer.from(
        JSON.stringify({
          providerId: provider.id,
          name: provider.name,
          workspace: ws?.name ?? '',
        }),
      ).toString('base64url'),
      { path: '/', sameSite: 'lax', secure: app.env.secureCookies, maxAge: 365 * 86_400 },
    );
    await audit(
      db,
      {
        action: 'auth.login',
        actorId: user.id,
        workspaceId: provider.workspaceId,
        data: { method: 'sso', provider: provider.name },
      },
      requestMeta(req),
    );
    const [member] = await db
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, provider.workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      );
    return reply.redirect(state.redirect ?? (member && ws ? `/${ws.slug}` : '/'));
  } catch (err) {
    if (err instanceof SsoError) return loginError(reply, err.message);
    throw err;
  }
}

export async function purgeExpiredStates(app: FastifyInstance) {
  await app.db.delete(authStates).where(lt(authStates.expiresAt, sql`now()`));
}
