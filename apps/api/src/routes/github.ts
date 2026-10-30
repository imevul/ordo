import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrationApps, integrations, workspaces } from '../db/schema.ts';
import { github } from '../integrations/github.ts';
import { callApi } from '../integrations/http.ts';
import { authInfo, authorizeWorkspace, requireAdmin, requireUser } from '../lib/auth.ts';
import { badRequest, forbidden, parse } from '../lib/errors.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { createIntegration, readAppSecrets, sealAppSecrets } from '../services/integrations.ts';
import { consumeToken, createToken } from '../services/tokens.ts';

/**
 * The GitHub App flow. An instance admin creates the app from a manifest (GitHub's one-click app
 * registration); after that, workspace admins install it on their GitHub accounts. State travels
 * as single-use tokens bound to the user who started the flow.
 */

const AUTHORIZED_PATH = '/api/integrations/github/authorized';

async function githubApp(app: FastifyInstance) {
  const [row] = await app.db
    .select()
    .from(integrationApps)
    .where(eq(integrationApps.provider, 'github'));
  return row ?? null;
}

/** Workspace-scoped: /api/w/:ws/integrations/github/… */
export async function githubWorkspaceRoutes(app: FastifyInstance) {
  app.get('/integrations/github/app', async (req) => {
    requireAdmin(req);
    const row = await githubApp(app);
    const config = row?.config as { slug?: string; htmlUrl?: string } | undefined;
    return {
      app: row
        ? { id: row.id, name: row.name, slug: config?.slug, htmlUrl: config?.htmlUrl }
        : null,
      canCreate: !!req.user?.isInstanceAdmin,
      publicUrl: app.env.publicUrl,
    };
  });

  /** Returns the form an admin's browser posts to GitHub to register the app. */
  app.post('/integrations/github/manifest', async (req) => {
    const ws = requireAdmin(req);
    const user = requireUser(req);
    if (!user.isInstanceAdmin) throw forbidden('Only instance admins can create the GitHub App');
    if (!app.keyring.available) throw badRequest('Set ORDO_SECRET_KEY first');
    if (await githubApp(app)) throw badRequest('This instance already has a GitHub App');
    const { org } = parse(z.object({ org: z.string().trim().max(100).optional() }), req.body);
    const appId = randomUUID();
    const state = await createToken(app.db, user.id, 'integration_setup', 60, {
      step: 'manifest',
      appId,
      workspaceId: ws.id,
    });
    const base = app.env.publicUrl;
    const manifest = {
      name: `Ordo ${new URL(base).host}`.slice(0, 34),
      url: base,
      hook_attributes: { url: `${base}/api/hooks/github/app-${appId}`, active: true },
      redirect_url: `${base}/api/integrations/github/callback`,
      setup_url: `${base}/api/integrations/github/setup`,
      // Where GitHub sends the user back after confirming they can see the installation.
      callback_urls: [`${base}${AUTHORIZED_PATH}`],
      setup_on_update: false,
      public: false,
      default_permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' },
      default_events: ['pull_request', 'pull_request_review', 'push'],
    };
    return {
      action: org
        ? `${app.env.github.webUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
        : `${app.env.github.webUrl}/settings/apps/new?state=${state}`,
      manifest: JSON.stringify(manifest),
    };
  });

  app.post('/integrations/github/install', async (req) => {
    const ws = requireAdmin(req);
    const row = await githubApp(app);
    if (!row) throw badRequest('Create the GitHub App first');
    const state = await createToken(app.db, requireUser(req).id, 'integration_setup', 60, {
      step: 'install',
      appId: row.id,
      workspaceId: ws.id,
    });
    const { htmlUrl } = row.config as { htmlUrl: string };
    return { url: `${htmlUrl}/installations/new?state=${state}` };
  });
}

/** Where GitHub sends the browser back: /api/integrations/github/… */
export async function githubCallbackRoutes(app: FastifyInstance) {
  const fail = (message: string) => `/?error=${encodeURIComponent(message)}`;

  async function claim(
    req: { user: { id: string } | null },
    state: string | undefined,
    step: string,
  ) {
    if (!req.user) throw badRequest('Sign in to Ordo first, then try again').as('sign_in_first');
    const token = await consumeToken(app.db, 'integration_setup', state ?? '');
    if (token.userId !== req.user.id || token.data.step !== step)
      throw badRequest('This link belongs to someone else').as('link_other_person');
    return token.data as { appId: string; workspaceId: string; installationId?: string };
  }

  app.get('/integrations/github/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    let data: { appId: string; workspaceId: string };
    try {
      data = await claim(req, state, 'manifest');
    } catch (err) {
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
    const { data: created } = await callApi<{
      id: number;
      slug: string;
      name: string;
      html_url: string;
      pem: string;
      webhook_secret: string;
      client_id: string;
      client_secret: string;
    }>(
      app,
      `${app.env.github.apiUrl}/app-manifests/${encodeURIComponent(code ?? '')}/conversions`,
      {
        method: 'POST',
      },
    );
    await app.db.insert(integrationApps).values({
      id: data.appId,
      provider: 'github',
      name: created.name,
      config: {
        appId: String(created.id),
        slug: created.slug,
        htmlUrl: created.html_url,
        apiUrl: app.env.github.apiUrl,
        webUrl: app.env.github.webUrl,
        clientId: created.client_id,
      },
      secrets: sealAppSecrets(app, data.appId, {
        privateKey: created.pem,
        webhookSecret: created.webhook_secret,
        clientSecret: created.client_secret,
      }),
    });
    // Straight on to installing it for the workspace that started this.
    const next = await createToken(app.db, req.user!.id, 'integration_setup', 60, {
      step: 'install',
      appId: data.appId,
      workspaceId: data.workspaceId,
    });
    return reply.redirect(`${created.html_url}/installations/new?state=${next}`);
  });

  /**
   * GitHub's setup redirect names the installation in the query string, where anyone can change
   * it. So it only remembers which one, then has the user sign in to GitHub (below) to prove they
   * can access it before anything is connected.
   */
  app.get('/integrations/github/setup', async (req, reply) => {
    const { installation_id: installationId, state } = req.query as {
      installation_id?: string;
      state?: string;
    };
    let data: { appId: string; workspaceId: string };
    try {
      data = await claim(req, state, 'install');
      if (!installationId || !/^\d+$/.test(installationId))
        throw badRequest('GitHub did not say which installation this is');
    } catch (err) {
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
    const row = await githubApp(app);
    const config = row?.config as { clientId?: string; webUrl?: string } | undefined;
    if (!row || row.id !== data.appId || !config?.clientId)
      return reply.redirect(fail('This GitHub App is no longer set up on this instance'));
    const next = await createToken(app.db, req.user!.id, 'integration_setup', 10, {
      step: 'authorize',
      appId: data.appId,
      workspaceId: data.workspaceId,
      installationId,
    });
    const authorize = new URL(`${config.webUrl ?? app.env.github.webUrl}/login/oauth/authorize`);
    authorize.searchParams.set('client_id', config.clientId);
    authorize.searchParams.set('redirect_uri', `${app.env.publicUrl}${AUTHORIZED_PATH}`);
    authorize.searchParams.set('state', next);
    return reply.redirect(authorize.toString());
  });

  app.get(AUTHORIZED_PATH.replace('/api', ''), async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    let data: { appId: string; workspaceId: string; installationId?: string };
    try {
      data = await claim(req, state, 'authorize');
      if (!code) throw badRequest('GitHub sign-in was cancelled');
    } catch (err) {
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
    const installationId = String(data.installationId);
    const ws = await authorizeWorkspace(
      app.db,
      req.user!,
      { id: data.workspaceId },
      authInfo(req),
    ).catch(() => null);
    if (!ws?.access.isAdmin)
      return reply.redirect(fail('Only workspace admins can connect GitHub'));
    const row = await githubApp(app);
    if (!row || row.id !== data.appId)
      return reply.redirect(fail('This GitHub App is no longer set up on this instance'));
    try {
      if (!(await canAccessInstallation(app, row, code, installationId)))
        throw badRequest("Your GitHub account can't access that installation");
    } catch (err) {
      req.log.warn({ err }, 'GitHub installation check failed');
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
    const [slug] = await app.db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id));
    const holders = await app.db
      .select({ workspaceId: integrations.workspaceId })
      .from(integrations)
      .where(and(eq(integrations.appId, data.appId), eq(integrations.externalId, installationId)));
    if (holders.some((h) => h.workspaceId !== ws.id))
      return reply.redirect(
        fail('This GitHub installation is already connected to another Ordo workspace'),
      );
    if (holders.length === 0) {
      await runInWorkspace(
        app,
        { workspaceId: ws.id, actorId: req.user!.id, source: 'web', access: ws.access },
        (ctx) =>
          createIntegration(app, ctx, {
            provider: github,
            name: 'GitHub',
            appId: data.appId,
            externalId: installationId,
            config: {
              mode: 'app',
              apiUrl: app.env.github.apiUrl,
              webUrl: app.env.github.webUrl,
              commentOnPullRequests: true,
            },
            secrets: {},
          }),
      );
    }
    return reply.redirect(`/${slug!.slug}/settings/integrations`);
  });
}

/**
 * Trades the sign-in code for a user token and asks GitHub whether that user can see the
 * installation. The token is used for this one question and then forgotten.
 */
async function canAccessInstallation(
  app: FastifyInstance,
  row: typeof integrationApps.$inferSelect,
  code: string,
  installationId: string,
) {
  const config = row.config as { clientId: string; apiUrl?: string; webUrl?: string };
  const { clientSecret } = readAppSecrets(app, row);
  const { data: grant } = await callApi<{ access_token?: string; error_description?: string }>(
    app,
    `${config.webUrl ?? app.env.github.webUrl}/login/oauth/access_token`,
    {
      method: 'POST',
      body: {
        client_id: config.clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${app.env.publicUrl}${AUTHORIZED_PATH}`,
      },
    },
  );
  if (!grant.access_token)
    throw badRequest(`GitHub sign-in failed: ${grant.error_description ?? 'no token'}`);
  const api = config.apiUrl ?? app.env.github.apiUrl;
  for (let page = 1; page <= 10; page++) {
    const { data } = await callApi<{ installations: { id: number }[] }>(
      app,
      `${api}/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${grant.access_token}`,
          accept: 'application/vnd.github+json',
        },
      },
    );
    if (data.installations.some((i) => String(i.id) === installationId)) return true;
    if (data.installations.length < 100) return false;
  }
  return false;
}
