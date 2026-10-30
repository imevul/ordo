import { type SlackConfig, slackSettingsSchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { integrationApps, integrations } from '../db/schema.ts';
import {
  type ChatIncoming,
  chatFeed,
  runChatCommand,
  syncThreadReply,
  unfurl,
} from '../services/chat.ts';
import { allSecrets, queueInbound, readAppSecrets } from '../services/integrations.ts';
import { callApi, hmacHex, safeEqual } from './http.ts';
import { runSocket } from './socket.ts';
import {
  type ChatMessage,
  configOf,
  type InboundRequest,
  type IntegrationContext,
  type IntegrationProvider,
} from './types.ts';

/**
 * Slack: a bot token plus either the Events API (Slack posts to Ordo; needs the signing secret)
 * or Socket Mode (Ordo holds a socket open to Slack; needs an app-level token, works behind NAT).
 * The `/ordo` command, mentions and direct messages run chat commands; the "Create Ordo issue"
 * message shortcut files a message; issue links unfurl.
 *
 * Two ways in: pasting a bot token from a Slack app made by hand (`token` mode), or "Add to Slack"
 * with the instance's own Slack app (`app` mode, routes/slack.ts). App-mode integrations share
 * the app's signing secret, app-level token and URL (`/api/hooks/slack/app`), told apart by the
 * Slack team (workspace) id kept in `externalId`.
 */

/** The instance's Slack app (there's at most one) and its secrets. */
export async function slackApp(app: FastifyInstance) {
  const [row] = await app.db
    .select()
    .from(integrationApps)
    .where(eq(integrationApps.provider, 'slack'));
  return row ? { row, secrets: readAppSecrets(app, row) } : null;
}

/** Which Slack workspace a payload (event, command, interaction) comes from. */
function teamOf(req: InboundRequest): string | undefined {
  try {
    const p = parseInbound(req) as SlackInbound & { team_id?: string };
    return p.team_id ?? p.command?.team_id ?? p.interaction?.team?.id;
  } catch {
    return undefined;
  }
}

/** The app-mode integration for a Slack workspace, if one is connected. */
async function integrationForTeam(app: FastifyInstance, appId: string, teamId: string) {
  const [row] = await app.db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, 'slack'),
        eq(integrations.appId, appId),
        eq(integrations.externalId, teamId),
      ),
    );
  return row ?? null;
}

const signedBySlack = (req: InboundRequest, signingSecret: string | undefined) => {
  const ts = Number(req.headers['x-slack-request-timestamp']);
  // Old timestamps are replays.
  if (!signingSecret || !ts || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  return safeEqual(
    req.headers['x-slack-signature'],
    `v0=${hmacHex(signingSecret, `v0:${ts}:${req.body}`)}`,
  );
};

const cfg = configOf<SlackConfig>();
// Overridable for tests (a mock Slack) and nothing else.
export const slackApiUrl = () => process.env.ORDO_SLACK_API_URL ?? 'https://slack.com/api';

/** Slack answers 200 with `ok: false` for most errors. */
async function slack<T = Record<string, unknown>>(
  ictx: IntegrationContext,
  method: string,
  body: Record<string, unknown> = {},
  token = ictx.secrets.botToken,
) {
  const { data } = await callApi<{ ok: boolean; error?: string } & T>(
    ictx.app,
    `${slackApiUrl()}/${method}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, body },
  );
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? 'failed'}`);
  return data;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackBlocks(m: ChatMessage) {
  const lines = [esc(m.headline)];
  if (m.title) lines.push(m.url ? `*<${m.url}|${esc(m.title)}>*` : `*${esc(m.title)}*`);
  if (m.body) lines.push(...m.body.split('\n').map((l) => `> ${esc(l)}`));
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
  if (m.context)
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: esc(m.context) }] });
  return {
    text: [m.headline, m.title, m.url].filter(Boolean).join(' · '),
    blocks,
  };
}

const parseForm = (body: string) => Object.fromEntries(new URLSearchParams(body));

/** Slack's mrkdwn as Markdown, for comments: links, channel names, bold and strikethrough. */
export function slackToMarkdown(text: string) {
  return text
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1**$2**')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1~~$2~~')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

interface SlackEvent {
  type: string;
  user: string;
  channel: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  links?: { url: string }[];
  message_ts?: string;
  unfurl_id?: string;
  source?: string;
}

interface SlackInteraction {
  type: string;
  trigger_id?: string;
  response_url: string;
  user: { id: string; username?: string; name?: string };
  team?: { id: string };
  channel: { id: string };
  message: { ts: string; text?: string; user?: string };
}

interface SlackInbound {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
  command?: Record<string, string>;
  interaction?: SlackInteraction;
}

/** Events arrive as JSON; slash commands and interactions as forms. */
function parseInbound(req: InboundRequest): SlackInbound {
  if (req.body.trimStart().startsWith('{')) return JSON.parse(req.body);
  const form = parseForm(req.body);
  return form.payload ? { interaction: JSON.parse(form.payload) } : { command: form };
}

async function respond(ictx: IntegrationContext, responseUrl: string, m: ChatMessage) {
  // response_url is Slack's own host, handed to us in a signed request.
  await callApi(ictx.app, responseUrl, {
    method: 'POST',
    body: { response_type: 'ephemeral', replace_original: false, ...slackBlocks(m) },
  });
}

async function handleEvent(ictx: IntegrationContext, event: SlackEvent) {
  const botUserId = ictx.integration.state.botUserId as string | undefined;
  // A reply also sent to the channel is still a reply.
  const subtype = event.subtype === 'thread_broadcast' ? undefined : event.subtype;
  if (event.bot_id || subtype || (botUserId && event.user === botUserId)) return;
  const reply =
    event.type === 'message' &&
    event.channel_type !== 'im' &&
    event.thread_ts &&
    event.ts &&
    event.thread_ts !== event.ts;
  // Mentions in a thread are commands (app_mention), not comments.
  if (reply && !(botUserId && event.text?.includes(`<@${botUserId}>`))) {
    await syncThreadReply(ictx, {
      channel: event.channel,
      parent: event.thread_ts!,
      messageRef: event.ts!,
      user: { id: event.user },
      displayName: async () => {
        const info = await slack<{ user: { real_name?: string; name?: string } }>(
          ictx,
          'users.info',
          { user: event.user },
        );
        return info.user.real_name || info.user.name;
      },
      text: slackToMarkdown(event.text ?? ''),
    });
    return;
  }
  if (event.type === 'link_shared') {
    const previews = await unfurl(
      ictx,
      event.user,
      (event.links ?? []).map((l) => l.url).join(' '),
    );
    if (!previews.length) return;
    await slack(ictx, 'chat.unfurl', {
      ...(event.unfurl_id
        ? { unfurl_id: event.unfurl_id, source: event.source }
        : { channel: event.channel, ts: event.message_ts }),
      unfurls: Object.fromEntries(
        previews.map((p) => [p.url, { blocks: slackBlocks(p.message).blocks }]),
      ),
    });
    return;
  }
  const direct = event.type === 'message' && event.channel_type === 'im';
  if (event.type !== 'app_mention' && !direct) return;
  const text = String(event.text ?? '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim();
  const incoming: ChatIncoming = { channel: event.channel, user: { id: event.user }, text, direct };
  const answer = await runChatCommand(ictx, incoming);
  await slack(ictx, 'chat.postMessage', {
    channel: event.channel,
    ...(direct ? {} : { thread_ts: event.thread_ts ?? event.ts }),
    unfurl_links: false,
    ...slackBlocks(answer),
  });
}

async function handleCommand(ictx: IntegrationContext, form: Record<string, string>) {
  const incoming: ChatIncoming = {
    channel: form.channel_id!,
    user: { id: form.user_id!, name: form.user_name },
    text: form.text ?? '',
    direct: form.channel_name === 'directmessage',
  };
  await respond(ictx, form.response_url!, await runChatCommand(ictx, incoming));
}

/** The "Create Ordo issue" message shortcut. */
async function handleInteraction(ictx: IntegrationContext, p: SlackInteraction) {
  if (p.type !== 'message_action') return;
  const { message } = p;
  const { permalink } = await slack<{ permalink: string }>(ictx, 'chat.getPermalink', {
    channel: p.channel.id,
    message_ts: message.ts,
  }).catch(() => ({ permalink: null }));
  let author = message.user;
  if (message.user) {
    const info = await slack<{ user: { real_name?: string; name?: string } }>(ictx, 'users.info', {
      user: message.user,
    }).catch(() => null);
    author = info?.user.real_name || info?.user.name || author;
  }
  const answer = await runChatCommand(ictx, {
    channel: p.channel.id,
    user: { id: p.user.id, name: p.user.username ?? p.user.name },
    text: 'new',
    direct: false,
    quoted: {
      id: `${p.channel.id}:${message.ts}`,
      text: message.text ?? '',
      url: permalink,
      author,
    },
  });
  await respond(ictx, p.response_url, answer);
}

export const slackProvider: IntegrationProvider = {
  key: 'slack',
  name: 'Slack',
  description:
    'Post issue activity to channels, DM people their notifications, create issues from messages and unfurl links.',
  category: 'chat',

  settings: slackSettingsSchema,

  async install(ictx) {
    const auth = await slack<{ team: string; team_id: string; user_id: string }>(ictx, 'auth.test');
    await ictx.saveState({ team: auth.team, teamId: auth.team_id, botUserId: auth.user_id });
  },

  async uninstall(ictx) {
    // Gives the bot token back, so the app leaves the Slack workspace's list of installed apps.
    if (cfg(ictx.integration).mode === 'app') await slack(ictx, 'auth.revoke').catch(() => {});
  },

  async challenge(app, key, req) {
    if (key !== 'app' || parseInbound(req).type !== 'url_verification') return null;
    const found = await slackApp(app);
    if (!found || !signedBySlack(req, found.secrets.signingSecret)) return { status: 401 };
    return { body: { challenge: parseInbound(req).challenge } };
  },

  async resolveInbound(app, key, req) {
    if (key !== 'app') {
      return app.db
        .select()
        .from(integrations)
        .where(and(eq(integrations.provider, 'slack'), eq(integrations.inboundToken, key)));
    }
    const found = await slackApp(app);
    const team = teamOf(req);
    const row = found && team ? await integrationForTeam(app, found.row.id, team) : null;
    return row ? [row] : [];
  },

  verify: (req, _row, secrets) => signedBySlack(req, secrets.signingSecret),

  ackInbound(req) {
    const parsed = parseInbound(req);
    if (parsed.type === 'url_verification')
      return { body: { challenge: parsed.challenge }, process: false };
    // Slack wants a 200 within three seconds; answers follow through response_url or the API.
    return { status: 200, body: '' };
  },

  deliveryId(req) {
    const p = parseInbound(req);
    return p.event_id ?? p.command?.trigger_id ?? p.interaction?.trigger_id ?? null;
  },

  async handleInbound(ictx, req) {
    const p = parseInbound(req);
    if (p.type === 'event_callback' && p.event) await handleEvent(ictx, p.event);
    else if (p.command) await handleCommand(ictx, p.command);
    else if (p.interaction) await handleInteraction(ictx, p.interaction);
  },

  onDomainEvent: chatFeed,

  wantsConnection: (row) => cfg(row).delivery === 'socket',

  /**
   * Socket Mode: Slack pushes the same payloads over a socket; each is acked, then queued. An app
   * shares its sockets between the workspaces it's installed in and hands each event to any of
   * them, so in app mode deliveries go to the integration of the event's team.
   */
  async connect(ictx, io) {
    const appMode = cfg(ictx.integration).mode === 'app';
    const secrets = appMode ? await allSecrets(ictx.app, ictx.integration) : ictx.secrets;
    const { url } = await slack<{ url: string }>(
      ictx,
      'apps.connections.open',
      {},
      secrets.appToken,
    );
    const deliver = async (req: InboundRequest) => {
      const team = appMode ? teamOf(req) : undefined;
      if (!team || team === ictx.integration.externalId) return io.deliver(req);
      const target = await integrationForTeam(ictx.app, ictx.integration.appId!, team);
      if (target && target.status !== 'disabled')
        await queueInbound(ictx.app, slackProvider, target, req);
    };
    await runSocket(url, io.signal, async (raw, send, close) => {
      const env = raw as { envelope_id?: string; type: string; payload?: unknown };
      if (env.envelope_id) send({ envelope_id: env.envelope_id });
      if (env.type === 'hello') await io.connected();
      else if (env.type === 'disconnect') close();
      else if (env.type === 'events_api')
        await deliver({ headers: {}, query: {}, body: JSON.stringify(env.payload) });
      else if (env.type === 'slash_commands')
        await deliver({
          headers: {},
          query: {},
          body: new URLSearchParams(env.payload as Record<string, string>).toString(),
        });
      else if (env.type === 'interactive')
        await deliver({
          headers: {},
          query: {},
          body: new URLSearchParams({ payload: JSON.stringify(env.payload) }).toString(),
        });
    });
  },

  chat: {
    async post(ictx, channel, message, thread) {
      const { ts } = await slack<{ ts: string }>(ictx, 'chat.postMessage', {
        channel,
        ...(thread && { thread_ts: thread.root }),
        unfurl_links: false,
        ...slackBlocks(message),
      });
      return ts;
    },
    async direct(ictx, to, message) {
      // Posting to a user id lands in the app's direct messages with them.
      await slack(ictx, 'chat.postMessage', {
        channel: to.externalId,
        unfurl_links: false,
        ...slackBlocks(message),
      });
      return undefined;
    },
    linkHint: () => '/ordo link CODE',
  },
};
