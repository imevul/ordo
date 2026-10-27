import type { LinkedIdentity, SsoDiscovery } from '@ordo/shared';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  authProviders,
  userIdentities,
  users,
  workspaceDomains,
  workspaces,
} from '../db/schema.ts';
import { authInfo, authorizeWorkspace, requireUser } from '../lib/auth.ts';
import { badRequest, HttpError, notFound } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import { beginLogin, CALLBACK_PATH, completeLogin } from '../services/oidc.ts';
import { finishSso, LAST_SSO_COOKIE, loginError } from '../services/sso.ts';

const STATE_COOKIE = 'ordo_oidc';

export async function ssoRoutes(app: FastifyInstance) {
  const { db } = app;
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

  /**
   * Starts a sign-in (or a link, or an admin's test) with a provider, whatever its protocol. The
   * older /auth/oidc/:providerId/start stays for bookmarks and IdP-side app tiles.
   */
  const start = async (req: FastifyRequest, reply: FastifyReply) => {
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
  };
  app.get('/auth/sso/:providerId/start', start);
  app.get('/auth/oidc/:providerId/start', start);

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
    return finishSso(app, req, reply, {
      ...result,
      emailTrusted: result.claims.email_verified === true,
    });
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
