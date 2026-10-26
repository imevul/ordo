import type { LinkedIdentity, SsoDiscovery } from '@ordo/shared';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  authProviders,
  userIdentities,
  users,
  workspaceDomains,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { authInfo, authorizeWorkspace, createSession, requireUser } from '../lib/auth.ts';
import { badRequest, HttpError, notFound } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import {
  beginLogin,
  CALLBACK_PATH,
  completeLogin,
  linkIdentity,
  resolveSsoUser,
  SsoError,
} from '../services/sso.ts';
import { workspaceSettings } from '../services/workspaces.ts';

const STATE_COOKIE = 'ordo_oidc';
const LAST_SSO_COOKIE = 'ordo_last_sso';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function ssoRoutes(app: FastifyInstance) {
  const { db } = app;
  const loginError = (reply: FastifyReply, message: string) =>
    reply.redirect(`/login?error=${encodeURIComponent(message)}`);

  /**
   * Sign-in options for an email address: providers of workspaces that verified its domain.
   * Answers per domain, never per person, so it can't be used to find out who has an account.
   */
  app.get('/auth/discover', async (req): Promise<SsoDiscovery> => {
    const { email = '' } = req.query as { email?: string };
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (!domain) return { options: [], ssoRequired: false };
    const rows = await db
      .select({
        providerId: authProviders.id,
        name: authProviders.name,
        workspace: workspaces.name,
        settings: workspaces.settings,
      })
      .from(workspaceDomains)
      .innerJoin(workspaces, eq(workspaces.id, workspaceDomains.workspaceId))
      .innerJoin(
        authProviders,
        and(eq(authProviders.workspaceId, workspaces.id), eq(authProviders.enabled, true)),
      )
      .where(and(eq(workspaceDomains.domain, domain), isNotNull(workspaceDomains.verifiedAt)));
    return {
      options: rows.map(({ settings: _settings, ...o }) => o),
      ssoRequired: rows.some((r) => r.settings?.requireSso),
    };
  });

  /** Enabled providers of one workspace (for /login?workspace=… and the "SSO required" screen). */
  app.get('/auth/providers', async (req): Promise<SsoDiscovery> => {
    const { workspace = '' } = req.query as { workspace?: string };
    const rows = await db
      .select({
        providerId: authProviders.id,
        name: authProviders.name,
        workspace: workspaces.name,
        settings: workspaces.settings,
      })
      .from(authProviders)
      .innerJoin(workspaces, eq(workspaces.id, authProviders.workspaceId))
      .where(and(eq(workspaces.slug, workspace), eq(authProviders.enabled, true)));
    return {
      options: rows.map(({ settings: _settings, ...o }) => o),
      ssoRequired: rows.some((r) => r.settings?.requireSso),
    };
  });

  app.get('/auth/oidc/:providerId/start', async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const { redirect, mode = 'login' } = req.query as {
      redirect?: string;
      mode?: 'login' | 'link' | 'test';
    };
    const [provider] = await db
      .select()
      .from(authProviders)
      .where(eq(authProviders.id, providerId));
    // A remembered or bookmarked button whose provider is gone: back to the sign-in page, not a 404.
    if (mode === 'login' && !provider?.enabled) {
      reply.clearCookie(LAST_SSO_COOKIE, { path: '/' });
      return loginError(reply, 'That sign-in method is no longer available. Sign in another way.');
    }
    if (!provider) throw notFound('Sign-in method');
    if (mode === 'link' || mode === 'test') {
      const user = requireUser(req);
      if (mode === 'test') {
        // Only the workspace's admins test its providers.
        const ws = await authorizeWorkspace(
          db,
          user,
          { id: provider.workspaceId },
          { ...authInfo(req), ignoreSso: true },
        );
        if (!ws.access.isAdmin) throw notFound('Sign-in method');
      }
    }
    let url: string;
    let state: string;
    try {
      ({ url, state } = await beginLogin(app, provider, { mode, userId: req.user?.id, redirect }));
    } catch (err) {
      req.log.warn({ err, provider: provider.id }, 'OIDC discovery failed');
      if (mode === 'login')
        return loginError(
          reply,
          `Couldn't reach ${provider.name}. Try again later or use your password.`,
        );
      throw badRequest(
        `Couldn't reach the provider: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    reply.setCookie(STATE_COOKIE, state, {
      path: '/api/auth/oidc',
      httpOnly: true,
      sameSite: 'lax',
      secure: app.env.secureCookies,
      maxAge: 600,
    });
    return reply.redirect(url);
  });

  app.get(CALLBACK_PATH.replace('/api', ''), async (req, reply) => {
    const url = new URL(req.url, app.env.publicUrl);
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth/oidc' });
    if (url.searchParams.get('error')) {
      return loginError(
        reply,
        url.searchParams.get('error_description') ?? 'Sign-in was cancelled',
      );
    }
    let result: Awaited<ReturnType<typeof completeLogin>>;
    try {
      result = await completeLogin(app, url, req.cookies[STATE_COOKIE]);
    } catch (err) {
      req.log.warn({ err }, 'OIDC callback failed');
      // Our own errors are written for people; library errors get a prefix so they read as one.
      if (err instanceof HttpError) return loginError(reply, err.message);
      return loginError(
        reply,
        `Sign-in failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const { provider, state, claims } = result;

    if (state.mode === 'test') {
      // Shows an admin exactly what the provider sends, without signing anyone in.
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      return reply.send(`<!doctype html><body style="background:#09090b;color:#fff4fa;font:14px ui-monospace,monospace;padding:32px">
        <p style="color:#ff1493">// ${esc(provider.name)} works</p>
        <p style="color:#b8aab2">These are the claims Ordo received. Ordo needs <b>sub</b>, a verified <b>email</b>${provider.groupClaim ? ` and <b>${esc(provider.groupClaim)}</b>` : ''}.</p>
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
      const user = await resolveSsoUser(app, provider, claims, req.ip ?? null);
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, provider.workspaceId));
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
  });

  // ─── connected identities ─────────────────────────────────────────────

  app.get('/me/identities', async (req): Promise<LinkedIdentity[]> => {
    const user = requireUser(req);
    return db
      .select({
        id: userIdentities.id,
        provider: authProviders.name,
        workspace: workspaces.name,
        email: userIdentities.email,
        lastLoginAt: userIdentities.lastLoginAt,
        createdAt: userIdentities.createdAt,
      })
      .from(userIdentities)
      .innerJoin(authProviders, eq(authProviders.id, userIdentities.providerId))
      .innerJoin(workspaces, eq(workspaces.id, authProviders.workspaceId))
      .where(eq(userIdentities.userId, user.id));
  });

  /** Unlinking can't remove someone's last way to sign in. */
  app.delete('/me/identities/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id));
    const [{ n }] = (await db
      .select({ n: count() })
      .from(userIdentities)
      .where(eq(userIdentities.userId, user.id))) as [{ n: number }];
    if (!row?.passwordHash && n <= 1) {
      throw badRequest(
        'This is your only way to sign in. Set a password first (use "Forgot password") before unlinking it.',
      );
    }
    const [removed] = await db
      .delete(userIdentities)
      .where(and(eq(userIdentities.id, id), eq(userIdentities.userId, user.id)))
      .returning();
    if (removed)
      await audit(
        db,
        {
          action: 'auth.identity_unlinked',
          actorId: user.id,
          data: { providerId: removed.providerId },
        },
        requestMeta(req),
      );
    return { ok: true };
  });
}
