import { randomUUID } from 'node:crypto';
import { slackAppSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrationApps, integrations, workspaces } from '../db/schema.ts';
import { callApi } from '../integrations/http.ts';
import { slackApiUrl, slackApp, slackProvider } from '../integrations/slack.ts';
import { authInfo, authorizeWorkspace, requireAdmin, requireUser } from '../lib/auth.ts';
import { badRequest, forbidden, parse, tryParse } from '../lib/errors.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { createIntegration, sealAppSecrets, sealSecrets } from '../services/integrations.ts';
import { consumeToken, createToken } from '../services/tokens.ts';

/**
 * One-click Slack: an instance admin registers one Slack app (from a manifest Ordo fills in) and
 * pastes its credentials; after that, workspace admins connect Slack with "Add to Slack" (OAuth).
 * State travels as single-use tokens bound to the user who started the flow.
 */

const BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'chat:write',
  'commands',
  'groups:history',
  'im:history',
  'links:read',
  'links:write',
  'users:read',
];
const BOT_EVENTS = [
  'app_mention',
  'link_shared',
  'message.channels',
  'message.groups',
  'message.im',
];

const redirectUrl = (app: FastifyInstance) =>
  `${app.env.publicUrl}/api/integrations/slack/callback`;

/** The app as Slack's "Create an app from a manifest" wants it. */
export function slackManifest(publicUrl: string, delivery: 'events' | 'socket') {
  const hook = `${publicUrl}/api/hooks/slack/app`;
  const events = delivery === 'events';
  const host = new URL(publicUrl).hostname;
  // Slack only unfurls real domain names.
  const unfurl = host.includes('.') && !/^[\d.]+$/.test(host) ? [host] : undefined;
  return {
    display_information: {
      name: 'Ordo',
      description: 'Issue tracking: notifications, issues from messages, link previews',
      background_color: '#09090b',
    },
    features: {
      bot_user: { display_name: 'Ordo', always_online: true },
      slash_commands: [
        {
          command: '/ordo',
          ...(events && { url: hook }),
          description: 'Link your account, create issues',
          usage_hint: 'link CODE · new [TEAM] title · help',
          should_escape: false,
        },
      ],
      shortcuts: [
        {
          name: 'Create Ordo issue',
          type: 'message',
          callback_id: 'create_issue',
          description: 'File this message as an issue',
        },
      ],
      ...(unfurl && { unfurl_domains: unfurl }),
    },
    oauth_config: {
      redirect_urls: [`${publicUrl}/api/integrations/slack/callback`],
      scopes: { bot: BOT_SCOPES },
    },
    settings: {
      event_subscriptions: { ...(events && { request_url: hook }), bot_events: BOT_EVENTS },
      interactivity: { is_enabled: true, ...(events && { request_url: hook }) },
      org_deploy_enabled: false,
      socket_mode_enabled: !events,
      token_rotation_enabled: false,
    },
  };
}

const manifestLink = (publicUrl: string, delivery: 'events' | 'socket') =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(publicUrl, delivery)))}`;

/** Workspace-scoped: /api/w/:ws/integrations/slack/… */
export async function slackWorkspaceRoutes(app: FastifyInstance) {
  app.get('/integrations/slack/app', async (req) => {
    requireAdmin(req);
    const found = await slackApp(app);
    const canCreate = !!req.user?.isInstanceAdmin;
    const config = found?.row.config as { delivery?: 'events' | 'socket'; clientId?: string };
    return {
      app: found ? { delivery: config.delivery ?? 'events', clientId: config.clientId } : null,
      canCreate,
      // Slack only sends people back to https addresses.
      https: app.env.publicUrl.startsWith('https://'),
      publicUrl: app.env.publicUrl,
      manifests: canCreate
        ? {
            events: manifestLink(app.env.publicUrl, 'events'),
            socket: manifestLink(app.env.publicUrl, 'socket'),
          }
        : null,
    };
  });

  /** Saves (or replaces) the instance's Slack app credentials. Blank secrets keep the old ones. */
  app.put('/integrations/slack/app', async (req) => {
    requireAdmin(req);
    if (!requireUser(req).isInstanceAdmin)
      throw forbidden('Only instance administrators can do this').as('instance_admins_only');
    if (!app.keyring.available)
      throw badRequest('Set ORDO_SECRET_KEY before connecting integrations');
    const input = parse(slackAppSchema, req.body);
    const found = await slackApp(app);
    const secrets = {
      ...found?.secrets,
      ...Object.fromEntries(
        Object.entries({
          clientSecret: input.clientSecret,
          signingSecret: input.signingSecret,
          appToken: input.appToken,
        }).filter(([, v]) => v),
      ),
    } as Record<string, string>;
    if (!secrets.clientSecret || !secrets.signingSecret)
      throw badRequest('Enter the client secret and the signing secret');
    if (input.delivery === 'socket') {
      if (!secrets.appToken?.startsWith('xapp-'))
        throw badRequest('Socket Mode needs an app-level token (xapp-…) with connections:write');
      // Fails here, with Slack's reason, rather than later in the background.
      const { data } = await callApi<{ ok: boolean; error?: string }>(
        app,
        `${slackApiUrl()}/apps.connections.open`,
        { method: 'POST', headers: { authorization: `Bearer ${secrets.appToken}` }, body: {} },
      );
      if (!data.ok) throw badRequest(`Slack didn't accept the app-level token: ${data.error}`);
    }
    const config = { delivery: input.delivery, clientId: input.clientId };
    if (found) {
      await app.db
        .update(integrationApps)
        .set({
          config,
          secrets: sealAppSecrets(app, found.row.id, secrets),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(integrationApps.id, found.row.id));
      // Connected workspaces follow the app's delivery (and reconnect with the new token).
      const rows = await app.db
        .select()
        .from(integrations)
        .where(eq(integrations.appId, found.row.id));
      for (const row of rows) {
        await app.db
          .update(integrations)
          .set({
            config: { ...row.config, delivery: input.delivery },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(integrations.id, row.id));
      }
    } else {
      const id = randomUUID();
      await app.db.insert(integrationApps).values({
        id,
        provider: 'slack',
        name: 'Slack',
        config,
        secrets: sealAppSecrets(app, id, secrets),
      });
    }
    return { ok: true };
  });

  app.post('/integrations/slack/install', async (req) => {
    const ws = requireAdmin(req);
    const found = await slackApp(app);
    if (!found) throw badRequest('An instance admin needs to set up the Slack app first');
    const state = await createToken(app.db, requireUser(req).id, 'integration_setup', 30, {
      step: 'slack-install',
      appId: found.row.id,
      workspaceId: ws.id,
    });
    const { clientId } = found.row.config as { clientId: string };
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', redirectUrl(app));
    url.searchParams.set('state', state);
    return { url: url.toString() };
  });
}

interface OAuthAccess {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
}

/** What Slack puts on its OAuth redirect: a code, or an error when the person cancelled. */
const callbackQuerySchema = z.object({
  code: z.string().max(500).optional(),
  state: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
});

/** Where Slack sends the browser back: /api/integrations/slack/callback */
export async function slackCallbackRoutes(app: FastifyInstance) {
  const fail = (message: string, slug?: string) =>
    `${slug ? `/${slug}/settings/integrations` : '/'}?error=${encodeURIComponent(message)}`;

  app.get('/integrations/slack/callback', async (req, reply) => {
    const query = tryParse(callbackQuerySchema, req.query);
    let data: { appId: string; workspaceId: string };
    try {
      if (!req.user) throw badRequest('Sign in to Ordo first, then try again').as('sign_in_first');
      if (!query) throw badRequest('That link from Slack is malformed. Start again from Ordo.');
      const token = await consumeToken(app.db, 'integration_setup', query.state ?? '');
      if (token.userId !== req.user.id || token.data.step !== 'slack-install')
        throw badRequest('This link belongs to someone else').as('link_other_person');
      data = token.data as typeof data;
    } catch (err) {
      return reply.redirect(fail(err instanceof Error ? err.message : 'Slack setup failed'));
    }
    const ws = await authorizeWorkspace(
      app.db,
      req.user!,
      { id: data.workspaceId },
      authInfo(req),
    ).catch(() => null);
    const [target] = await app.db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, data.workspaceId));
    const slug = target?.slug;
    if (!ws?.access.isAdmin) return reply.redirect(fail('Only workspace admins can do this', slug));
    // Cancelled on Slack's consent screen.
    const { code, error } = query!;
    if (error || !code) return reply.redirect(fail(`Slack: ${error ?? 'no code'}`, slug));

    const found = await slackApp(app);
    if (!found || found.row.id !== data.appId)
      return reply.redirect(fail('The Slack app changed; try again', slug));
    const { clientId, delivery } = found.row.config as {
      clientId: string;
      delivery: 'events' | 'socket';
    };
    const exchange = new URL(`${slackApiUrl()}/oauth.v2.access`);
    exchange.searchParams.set('code', code);
    exchange.searchParams.set('redirect_uri', redirectUrl(app));
    const { data: access } = await callApi<OAuthAccess>(app, exchange.toString(), {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${found.secrets.clientSecret}`).toString('base64')}`,
      },
    }).catch((err) => ({ data: { ok: false, error: (err as Error).message } as OAuthAccess }));
    if (!access.ok || !access.access_token || !access.team)
      return reply.redirect(fail(`Slack: ${access.error ?? 'no token'}`, slug));
    const team = access.team;

    const [existing] = await app.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.provider, 'slack'),
          eq(integrations.appId, found.row.id),
          eq(integrations.externalId, team.id),
        ),
      );
    if (existing && existing.workspaceId !== ws.id)
      return reply.redirect(
        fail(`${team.name} is already connected to another Ordo workspace`, slug),
      );
    const installed = { team: team.name, teamId: team.id, botUserId: access.bot_user_id ?? null };
    if (existing) {
      // Installed again (say, after adding scopes): the new token replaces the old one.
      await app.db
        .update(integrations)
        .set({
          secrets: sealSecrets(app, existing.id, { botToken: access.access_token }),
          config: { ...existing.config, team: team.name },
          state: { ...existing.state, ...installed },
          status: 'active',
          lastError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(integrations.id, existing.id));
    } else {
      await runInWorkspace(
        app,
        { workspaceId: ws.id, actorId: req.user!.id, source: 'web', access: ws.access },
        async (ctx) => {
          const row = await createIntegration(app, ctx, {
            provider: slackProvider,
            name: `Slack · ${team.name}`,
            appId: found.row.id,
            externalId: team.id,
            config: { mode: 'app', delivery, channels: [], team: team.name },
            secrets: { botToken: access.access_token! },
          });
          await ctx.tx
            .update(integrations)
            .set({ state: installed })
            .where(eq(integrations.id, row.id));
        },
      );
    }
    return reply.redirect(`/${slug}/settings/integrations`);
  });
}
