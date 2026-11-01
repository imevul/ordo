import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrationApps, integrations } from '../db/schema.ts';
import { GITHUB_EVENTS, github } from '../integrations/github.ts';
import { callApi } from '../integrations/http.ts';
import {
  authInfo,
  authorizeWorkspace,
  requireAdmin,
  requireUser,
  type WorkspaceCtx,
} from '../lib/auth.ts';
import { badRequest, forbidden, parse, tryParse } from '../lib/errors.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { createIntegration, readAppSecrets, sealAppSecrets } from '../services/integrations.ts';
import { consumeToken, createToken, peekToken } from '../services/tokens.ts';

/**
 * The GitHub App flow. An instance admin creates the app from a manifest (GitHub's one-click app
 * registration). It's public, so workspace admins can install it on any GitHub account, and any
 * number of workspaces can connect to the same installation. Connecting always starts with the
 * admin signing in to GitHub, which says which installations they can see; that list, not a query
 * string, decides what they may connect. State travels as single-use tokens bound to the user who
 * started the flow.
 */

const AUTHORIZED_PATH = '/api/integrations/github/authorized';

/** An installation of the app that GitHub says the signed-in user can see. */
interface Installation {
  id: string;
  account: string;
  type: string;
  avatarUrl: string | null;
}

type AppRow = typeof integrationApps.$inferSelect;

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
      // Sends the admin back after they change an installation that already exists, too.
      setup_on_update: true,
      // Installable on any account, so several workspaces (and organisations) can use it.
      public: true,
      default_permissions: {
        metadata: 'read',
        contents: 'read',
        pull_requests: 'write',
        checks: 'read',
        statuses: 'read',
      },
      default_events: GITHUB_EVENTS,
    };
    return {
      action: org
        ? `${app.env.github.webUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
        : `${app.env.github.webUrl}/settings/apps/new?state=${state}`,
      manifest: JSON.stringify(manifest),
    };
  });

  /**
   * Starts connecting: the admin signs in to GitHub, then connects an installation they can see.
   * `fresh` goes straight to installing the app on another account instead.
   */
  app.post('/integrations/github/install', async (req) => {
    const ws = requireAdmin(req);
    const row = await githubApp(app);
    if (!row) throw badRequest('Create the GitHub App first');
    const { fresh } = parse(z.object({ fresh: z.boolean().optional() }), req.body ?? {});
    const userId = requireUser(req).id;
    return {
      url: fresh
        ? await installUrl(app, row, userId, ws.id)
        : await authorizeUrl(app, row, userId, { appId: row.id, workspaceId: ws.id }),
    };
  });

  /** The installations an admin may pick from, after signing in to GitHub showed several. */
  app.get('/integrations/github/choices', async (req) => {
    const ws = requireAdmin(req);
    const { state } = parse(z.object({ state: z.string().max(500) }), req.query);
    const choice = await chooseToken(peekToken(app.db, 'integration_setup', state), req, ws);
    const connected = await connectedHere(app, ws.id, choice.appId);
    return {
      installations: choice.installations.map((i) => ({ ...i, connected: connected.has(i.id) })),
    };
  });

  app.post('/integrations/github/connect', async (req) => {
    const ws = requireAdmin(req);
    const { state, installationId } = parse(
      z.object({ state: z.string().max(500), installationId: z.string().max(50) }),
      req.body,
    );
    const choice = await chooseToken(consumeToken(app.db, 'integration_setup', state), req, ws);
    const installation = choice.installations.find((i) => i.id === installationId);
    if (!installation) throw badRequest("Your GitHub account can't access that installation");
    const row = await githubApp(app);
    if (!row || row.id !== choice.appId)
      throw badRequest('This GitHub App is no longer set up on this instance');
    await connectInstallation(app, ws, requireUser(req).id, row, installation);
    return { ok: true };
  });
}

/** A `choose` token, checked to belong to this user and workspace. */
async function chooseToken(
  pending: ReturnType<typeof peekToken>,
  req: { user: { id: string } | null },
  ws: WorkspaceCtx,
) {
  const token = await pending;
  const data = token.data as { step?: string; appId: string; workspaceId: string };
  if (token.userId !== req.user?.id || data.step !== 'choose' || data.workspaceId !== ws.id)
    throw badRequest('This link belongs to someone else').as('link_other_person');
  return token.data as { appId: string; installations: Installation[] };
}

/** Installation ids of the app this workspace has already connected. */
async function connectedHere(app: FastifyInstance, workspaceId: string, appId: string) {
  const rows = await app.db
    .select({ externalId: integrations.externalId })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.appId, appId)));
  return new Set(rows.map((r) => r.externalId));
}

/**
 * Connects an installation to a workspace. Other workspaces may hold the same one: webhooks fan out
 * to all of them. Connecting one the workspace already has changes nothing.
 */
async function connectInstallation(
  app: FastifyInstance,
  ws: Pick<WorkspaceCtx, 'id' | 'access'>,
  userId: string,
  row: AppRow,
  installation: Installation,
) {
  if ((await connectedHere(app, ws.id, row.id)).has(installation.id)) return;
  await runInWorkspace(
    app,
    { workspaceId: ws.id, actorId: userId, source: 'web', access: ws.access },
    (ctx) =>
      createIntegration(app, ctx, {
        provider: github,
        name: `GitHub · ${installation.account}`,
        appId: row.id,
        externalId: installation.id,
        config: {
          mode: 'app',
          apiUrl: app.env.github.apiUrl,
          webUrl: app.env.github.webUrl,
          repos: [],
          commentOnPullRequests: true,
        },
        secrets: {},
      }),
  );
}

/** GitHub's page for installing the app on an account; it comes back through the setup route. */
async function installUrl(app: FastifyInstance, row: AppRow, userId: string, workspaceId: string) {
  const state = await createToken(app.db, userId, 'integration_setup', 60, {
    step: 'install',
    appId: row.id,
    workspaceId,
  });
  const { htmlUrl } = row.config as { htmlUrl: string };
  return `${htmlUrl}/installations/new?state=${state}`;
}

/** GitHub sign-in, which proves which installations the user can see. */
async function authorizeUrl(
  app: FastifyInstance,
  row: AppRow,
  userId: string,
  data: { appId: string; workspaceId: string; installationId?: string },
) {
  const config = row.config as { clientId?: string; webUrl?: string };
  if (!config.clientId) throw badRequest('This GitHub App is no longer set up on this instance');
  const state = await createToken(app.db, userId, 'integration_setup', 10, {
    step: 'authorize',
    ...data,
  });
  const authorize = new URL(`${config.webUrl ?? app.env.github.webUrl}/login/oauth/authorize`);
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', `${app.env.publicUrl}${AUTHORIZED_PATH}`);
  authorize.searchParams.set('state', state);
  return authorize.toString();
}

/** What GitHub puts on its redirects back: the manifest code, the installation, the OAuth code. */
const callbackQuerySchema = z.object({
  code: z.string().max(500).optional(),
  state: z.string().max(500).optional(),
  installation_id: z.string().max(50).optional(),
  /** `request`: a member asked an owner of the organisation to approve the install. */
  setup_action: z.string().max(20).optional(),
});

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

  /** Throws inside each handler's try, so a mangled link redirects like any other failure. */
  const callbackQuery = (query: unknown) => {
    const q = tryParse(callbackQuerySchema, query);
    if (!q) throw badRequest('That link from GitHub is malformed. Start again from Ordo.');
    return q;
  };

  app.get('/integrations/github/callback', async (req, reply) => {
    let code: string | undefined;
    let data: { appId: string; workspaceId: string };
    try {
      const q = callbackQuery(req.query);
      code = q.code;
      data = await claim(req, q.state, 'manifest');
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
    const [row] = await app.db
      .select()
      .from(integrationApps)
      .where(eq(integrationApps.id, data.appId));
    return reply.redirect(await installUrl(app, row!, req.user!.id, data.workspaceId));
  });

  /**
   * GitHub's setup redirect names the installation in the query string, where anyone can change
   * it. So it only remembers which one, then has the user sign in to GitHub (below) to prove they
   * can access it before anything is connected.
   */
  app.get('/integrations/github/setup', async (req, reply) => {
    let installationId: string | undefined;
    let data: { appId: string; workspaceId: string };
    try {
      const q = callbackQuery(req.query);
      installationId = q.installation_id;
      data = await claim(req, q.state, 'install');
      if (q.setup_action === 'request')
        throw badRequest(
          'GitHub asked an owner of the organisation to approve the install. Connect it from Ordo once they have.',
        );
      if (!installationId || !/^\d+$/.test(installationId))
        throw badRequest('GitHub did not say which installation this is');
    } catch (err) {
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
    const row = await githubApp(app);
    if (!row || row.id !== data.appId)
      return reply.redirect(fail('This GitHub App is no longer set up on this instance'));
    try {
      return reply.redirect(
        await authorizeUrl(app, row, req.user!.id, {
          appId: data.appId,
          workspaceId: data.workspaceId,
          installationId,
        }),
      );
    } catch (err) {
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
  });

  app.get(AUTHORIZED_PATH.replace('/api', ''), async (req, reply) => {
    let code: string | undefined;
    let data: { appId: string; workspaceId: string; installationId?: string };
    try {
      const q = callbackQuery(req.query);
      code = q.code;
      data = await claim(req, q.state, 'authorize');
      if (!code) throw badRequest('GitHub sign-in was cancelled');
    } catch (err) {
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
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
    const settings = `/${ws.slug}/settings/integrations`;
    try {
      const visible = await visibleInstallations(app, row, code);
      let pick: Installation | undefined;
      if (data.installationId) {
        // Back from installing or changing one on GitHub: that one, if they can really see it.
        pick = visible.find((i) => i.id === String(data.installationId));
        if (!pick) throw badRequest("Your GitHub account can't access that installation");
      } else if (visible.length === 0) {
        // Not installed anywhere they can see yet.
        return reply.redirect(await installUrl(app, row, req.user!.id, ws.id));
      } else {
        const connected = await connectedHere(app, ws.id, row.id);
        const open = visible.filter((i) => !connected.has(i.id));
        // One to choose from needs no choosing.
        if (visible.length === 1) pick = visible[0];
        else if (open.length === 1) pick = open[0];
      }
      if (pick) {
        await connectInstallation(app, ws, req.user!.id, row, pick);
        return reply.redirect(settings);
      }
      const choose = await createToken(app.db, req.user!.id, 'integration_setup', 15, {
        step: 'choose',
        appId: row.id,
        workspaceId: ws.id,
        installations: visible,
      });
      return reply.redirect(`${settings}?github=${choose}`);
    } catch (err) {
      req.log.warn({ err }, 'GitHub installation check failed');
      return reply.redirect(fail(err instanceof Error ? err.message : 'GitHub setup failed'));
    }
  });
}

/**
 * Trades the sign-in code for a user token and asks GitHub which of this app's installations that
 * user can see. The token is used for this one question and then forgotten.
 */
async function visibleInstallations(
  app: FastifyInstance,
  row: AppRow,
  code: string,
): Promise<Installation[]> {
  const config = row.config as {
    appId: string;
    clientId: string;
    apiUrl?: string;
    webUrl?: string;
  };
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
  const found: Installation[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await callApi<{
      installations: {
        id: number;
        app_id?: number;
        account?: { login?: string; type?: string; avatar_url?: string } | null;
      }[];
    }>(app, `${api}/user/installations?per_page=100&page=${page}`, {
      headers: {
        authorization: `Bearer ${grant.access_token}`,
        accept: 'application/vnd.github+json',
      },
    });
    for (const i of data.installations) {
      // The user's token lists installations of every app they've signed in to.
      if (String(i.app_id) !== String(config.appId)) continue;
      found.push({
        id: String(i.id),
        account: i.account?.login ?? String(i.id),
        type: i.account?.type ?? 'User',
        avatarUrl: i.account?.avatar_url ?? null,
      });
    }
    if (data.installations.length < 100) break;
  }
  return found;
}
