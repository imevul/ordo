import {
  type LinkedIdentity,
  linkIdentitySchema,
  type SsoDiscovery,
  samlCompleteQuerySchema,
  ssoDiscoverQuerySchema,
  ssoProvidersQuerySchema,
  ssoStartQuerySchema,
} from '@ordo/shared';
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
import { badRequest, HttpError, notFound, parse, tryParse } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import { beginLogin, CALLBACK_PATH, completeLogin } from '../services/oidc.ts';
import {
  beginSamlLogin,
  completeSamlLogin,
  receiveSamlResponse,
  SAML_COOKIE,
  SAML_COOKIE_PATH,
  SamlError,
  serviceProviderMetadata,
} from '../services/saml.ts';
import { finishSso, LAST_SSO_COOKIE, loginError } from '../services/sso.ts';

const STATE_COOKIE = 'ordo_oidc';

export async function ssoRoutes(app: FastifyInstance) {
  const { db } = app;
  /**
   * Sign-in options for an email address: providers of workspaces that verified its domain.
   * Answers per domain, never per person, so it can't be used to find out who has an account.
   */
  app.get('/auth/discover', async (req): Promise<SsoDiscovery> => {
    const { email } = parse(ssoDiscoverQuerySchema, req.query);
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
    const { workspace } = parse(ssoProvidersQuerySchema, req.query);
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
    const query = tryParse(ssoStartQuerySchema, req.query);
    // Followed from a button or a bookmark, so a mangled link lands on the sign-in page.
    if (!query) return loginError(reply, "That sign-in link isn't valid. Sign in another way.");
    const { redirect, mode } = query;
    // Linking attaches whatever identity comes back to the signed-in account, so a plain link
    // must never start it: anyone could send one that ends at their own identity provider.
    if (mode === 'link') throw badRequest('Connect accounts from Settings → Connected accounts');
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
    if (mode === 'test') {
      // Only the workspace's admins test its providers.
      const ws = await authorizeWorkspace(
        db,
        requireUser(req),
        { id: provider.workspaceId },
        { ...authInfo(req), ignoreSso: true },
      );
      if (!ws.access.isAdmin) throw notFound('Sign-in method');
    }
    const url = await begin(req, reply, provider, mode, redirect);
    if (!url) return reply;
    return reply.redirect(url);
  };
  app.get('/auth/sso/:providerId/start', start);
  app.get('/auth/oidc/:providerId/start', start);

  /**
   * Starts linking a provider to the signed-in account. A JSON POST, so the same-origin checks in
   * app.ts apply, and only for providers of the user's own workspaces. Answers the URL to go to.
   */
  app.post('/auth/sso/:providerId/link', async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const { redirect } = parse(linkIdentitySchema, req.body);
    const user = requireUser(req);
    const [provider] = await db
      .select()
      .from(authProviders)
      .where(and(eq(authProviders.id, providerId), eq(authProviders.enabled, true)));
    if (!provider) throw notFound('Sign-in method');
    await authorizeWorkspace(
      db,
      user,
      { id: provider.workspaceId },
      { ...authInfo(req), ignoreSso: true },
    ).catch(() => {
      throw notFound('Sign-in method');
    });
    const url = await begin(req, reply, provider, 'link', redirect);
    return { url };
  });

  /** Asks the provider for a sign-in URL and sets the state cookie. Null when it already replied. */
  async function begin(
    req: FastifyRequest,
    reply: FastifyReply,
    provider: typeof authProviders.$inferSelect,
    mode: 'login' | 'link' | 'test',
    redirect: string | undefined,
  ): Promise<string | null> {
    const saml = provider.protocol === 'saml';
    let url: string;
    let state: string;
    try {
      ({ url, state } = await (saml ? beginSamlLogin : beginLogin)(app, provider, {
        mode,
        userId: req.user?.id,
        redirect,
      }));
    } catch (err) {
      req.log.warn({ err, provider: provider.id }, 'Starting single sign-on failed');
      if (mode === 'login') {
        loginError(reply, `Couldn't reach ${provider.name}. Try again later or use your password.`);
        return null;
      }
      throw badRequest(
        `Couldn't reach the provider: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    reply.setCookie(saml ? SAML_COOKIE : STATE_COOKIE, state, {
      path: saml ? SAML_COOKIE_PATH : '/api/auth/oidc',
      httpOnly: true,
      sameSite: 'lax',
      secure: app.env.secureCookies,
      maxAge: 600,
    });
    return url;
  }

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

  // ─── SAML ──────────────────────────────────────────────────────────────

  /** What the identity provider needs to know about Ordo: entity ID, ACS URL. Public on purpose. */
  app.get('/auth/saml/:providerId/metadata', async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const [provider] = /^[0-9a-f-]{36}$/.test(providerId)
      ? await db.select().from(authProviders).where(eq(authProviders.id, providerId))
      : [];
    if (provider?.protocol !== 'saml' || !provider.saml) throw notFound('Sign-in method');
    return reply
      .header('content-type', 'application/samlmetadata+xml; charset=utf-8')
      .send(serviceProviderMetadata(app, provider));
  });

  // The IdP posts the response as a form, from its own site: the one cross-site POST Ordo takes
  // (app.ts lets it through). It signs nobody in by itself; see services/saml.ts.
  await app.register(async (acs) => {
    acs.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 * 1024 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    acs.post('/auth/saml/:providerId/acs', async (req, reply) => {
      const { providerId } = req.params as { providerId: string };
      let state: string;
      try {
        state = await receiveSamlResponse(app, providerId, (req.body ?? {}) as object);
      } catch (err) {
        req.log.warn({ err, provider: providerId }, 'SAML response refused');
        if (err instanceof SamlError) return loginError(reply, `Sign-in failed (${err.message})`);
        throw err;
      }
      // 303: the browser follows with a GET, which carries the SameSite=Lax state cookie.
      return reply.redirect(`/api/auth/saml/complete?state=${encodeURIComponent(state)}`, 303);
    });
  });

  app.get('/auth/saml/complete', async (req, reply) => {
    // A malformed state counts as none: completeSamlLogin refuses it with a message for people.
    const state = tryParse(samlCompleteQuerySchema, req.query)?.state;
    reply.clearCookie(SAML_COOKIE, { path: SAML_COOKIE_PATH });
    let result: Awaited<ReturnType<typeof completeSamlLogin>>;
    try {
      result = await completeSamlLogin(app, state, req.cookies[SAML_COOKIE]);
    } catch (err) {
      if (err instanceof HttpError) return loginError(reply, err.message);
      throw err;
    }
    return finishSso(app, req, reply, { ...result, emailTrusted: result.provider.trustEmail });
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
