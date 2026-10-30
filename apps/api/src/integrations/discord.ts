import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { type DiscordConfig, discordSettingsSchema } from '@ordo/shared';
import {
  type ChatIncoming,
  chatFeed,
  runChatCommand,
  syncThreadReply,
  unfurl,
} from '../services/chat.ts';
import { ApiCallError, callApi } from './http.ts';
import { runSocket } from './socket.ts';
import {
  type ChatMessage,
  configOf,
  type IntegrationContext,
  type IntegrationProvider,
} from './types.ts';

/**
 * Discord: a bot token and application id plus either the interactions endpoint (Discord posts
 * slash commands to Ordo, signed with the app's public key) or the gateway (Ordo holds a socket
 * open; works behind NAT, and also sees `!ordo` messages, replies and issue links).
 * Ordo registers `/ordo` and a "Create Ordo issue" message command on install.
 */

const cfg = configOf<DiscordConfig>();
// Overridable for tests (a mock Discord) and nothing else.
const apiUrl = () => process.env.ORDO_DISCORD_API_URL ?? 'https://discord.com/api/v10';

const api = <T>(
  ictx: IntegrationContext,
  path: string,
  opts: { method?: string; body?: unknown } = {},
) =>
  callApi<T>(ictx.app, `${apiUrl()}${path}`, {
    ...opts,
    headers: { authorization: `Bot ${ictx.secrets.botToken}` },
  });

const CREATE_FROM_MESSAGE = 'Create Ordo issue';
const COMMANDS = [
  {
    name: 'ordo',
    type: 1,
    description: 'Ordo: link your account, create issues',
    options: [
      {
        type: 3,
        name: 'command',
        description: 'link CODE · new [TEAM] title · unlink · help',
        required: false,
      },
    ],
  },
  { name: CREATE_FROM_MESSAGE, type: 3 },
];

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (privileged: enable it for the bot).
const INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

const hexColor = (hex?: string) => (hex ? Number.parseInt(hex.slice(1), 16) : undefined);

export function discordMessage(m: ChatMessage) {
  const embed =
    m.title || m.body
      ? {
          title: m.title?.slice(0, 256),
          url: m.url,
          description: m.body?.slice(0, 4000),
          color: hexColor(m.color),
          footer: m.context ? { text: m.context.slice(0, 2000) } : undefined,
        }
      : null;
  return {
    content: m.headline.slice(0, 2000),
    embeds: embed ? [embed] : [],
    allowed_mentions: { parse: [] },
  };
}

const permalink = (guildId: string | undefined, channelId: string, messageId: string) =>
  `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${messageId}`;

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: DiscordUser;
  referenced_message?: DiscordMessage | null;
}

const displayName = (u: DiscordUser) => u.global_name || u.username;

/** A slash command or message command: answered by editing the deferred response. */
interface DiscordInteraction {
  id: string;
  type: number;
  token: string;
  channel_id: string;
  guild_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data: {
    type: number;
    name: string;
    target_id?: string;
    options?: { name: string; value: string }[];
    resolved?: { messages?: Record<string, DiscordMessage> };
  };
}

async function handleInteraction(ictx: IntegrationContext, i: DiscordInteraction) {
  if (i.type !== 2) return;
  const user = (i.member?.user ?? i.user)!;
  const incoming: ChatIncoming = {
    channel: i.channel_id,
    user: { id: user.id, name: user.username },
    text: '',
    direct: !i.guild_id,
  };
  if (i.data.type === 3) {
    const target = i.data.resolved?.messages?.[i.data.target_id ?? ''];
    if (!target) return;
    incoming.text = 'new';
    incoming.quoted = {
      id: target.id,
      text: target.content,
      url: permalink(i.guild_id, target.channel_id, target.id),
      author: displayName(target.author),
    };
  } else {
    incoming.text = String(i.data.options?.find((o) => o.name === 'command')?.value ?? '');
  }
  const answer = await runChatCommand(ictx, incoming);
  // Interaction webhooks are authorised by their token, not the bot's.
  await callApi(
    ictx.app,
    `${apiUrl()}/webhooks/${cfg(ictx.integration).applicationId}/${i.token}/messages/@original`,
    { method: 'PATCH', body: discordMessage(answer) },
  );
}

/** Gateway messages: `!ordo …`, mentions and DMs are commands; issue links get previews. */
async function handleMessage(ictx: IntegrationContext, m: DiscordMessage) {
  if (m.author.bot) return;
  const botId = ictx.integration.state.botUserId as string | undefined;
  const direct = !m.guild_id;
  const mention = botId ? new RegExp(`^\\s*<@!?${botId}>`) : null;
  let text: string | null = null;
  if (/^\s*!ordo\b/i.test(m.content)) text = m.content.replace(/^\s*!ordo\b/i, '');
  else if (mention?.test(m.content)) text = m.content.replace(mention, '');
  else if (direct) text = m.content;
  const reply = (answer: ChatMessage | ReturnType<typeof discordMessage>) =>
    api(ictx, `/channels/${m.channel_id}/messages`, {
      method: 'POST',
      body: {
        ...('headline' in answer ? discordMessage(answer) : answer),
        message_reference: { message_id: m.id, fail_if_not_exists: false },
      },
    });
  if (text !== null) {
    const ref = m.referenced_message;
    const answer = await runChatCommand(ictx, {
      channel: m.channel_id,
      user: { id: m.author.id, name: m.author.username },
      text: text.trim(),
      direct,
      ...(ref && {
        quoted: {
          id: ref.id,
          text: ref.content,
          url: permalink(m.guild_id, ref.channel_id, ref.id),
          author: displayName(ref.author),
        },
      }),
    });
    await reply(answer);
    return;
  }
  // In a thread Ordo started, a message is a comment (a thread's id is its first message's).
  if (
    m.guild_id &&
    (await syncThreadReply(ictx, {
      parent: m.channel_id,
      messageRef: m.id,
      user: { id: m.author.id, name: displayName(m.author) },
      text: m.content,
    }))
  )
    return;
  const previews = await unfurl(ictx, m.author.id, m.content);
  if (previews.length) {
    await reply({
      content: '',
      embeds: previews.map((p) => discordMessage(p.message).embeds[0]!),
      allowed_mentions: { parse: [] },
    });
  }
}

function publicKey(hex: string) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
    format: 'jwk',
  });
}

export const discordProvider: IntegrationProvider = {
  key: 'discord',
  name: 'Discord',
  description:
    'Post issue activity to channels, DM people their notifications, create issues from messages and preview links.',
  category: 'chat',

  settings: discordSettingsSchema,

  async install(ictx) {
    const { data: me } = await api<DiscordUser>(ictx, '/users/@me');
    await api(ictx, `/applications/${cfg(ictx.integration).applicationId}/commands`, {
      method: 'PUT',
      body: COMMANDS,
    });
    await ictx.saveState({ botUserId: me.id, botName: me.username });
  },

  verify(req, _row, secrets) {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    if (!secrets.publicKey || !signature || !timestamp) return false;
    try {
      return verifySignature(
        null,
        Buffer.from(timestamp + req.body),
        publicKey(secrets.publicKey),
        Buffer.from(signature, 'hex'),
      );
    } catch {
      return false;
    }
  },

  ackInbound(req) {
    const i = JSON.parse(req.body);
    if (i.type === 1) return { body: { type: 1 }, process: false };
    // Deferred, private: the answer replaces "thinking…" once the job has run.
    if (i.type === 2) return { body: { type: 5, data: { flags: 64 } } };
    return { body: { type: 1 }, process: false };
  },

  deliveryId(req) {
    const p = JSON.parse(req.body);
    return p.t ? `${p.t}:${p.d?.id}` : (p.id ?? null);
  },

  async handleInbound(ictx, req) {
    const p = JSON.parse(req.body);
    if (p.t === 'MESSAGE_CREATE') await handleMessage(ictx, p.d);
    else if (p.t === 'INTERACTION_CREATE') await handleInteraction(ictx, p.d);
    else if (!p.t) await handleInteraction(ictx, p);
  },

  onDomainEvent: chatFeed,

  wantsConnection: (row) => cfg(row).delivery === 'gateway',

  async connect(ictx, io) {
    const { data } = await api<{ url: string }>(ictx, '/gateway/bot');
    let seq: number | null = null;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await runSocket(`${data.url}/?v=10&encoding=json`, io.signal, async (raw, send, close) => {
        const msg = raw as { op: number; d: unknown; s: number | null; t: string | null };
        if (msg.s !== null && msg.s !== undefined) seq = msg.s;
        if (msg.op === 10) {
          const { heartbeat_interval } = msg.d as { heartbeat_interval: number };
          heartbeat = setInterval(() => send({ op: 1, d: seq }), heartbeat_interval);
          send({
            op: 2,
            d: {
              token: ictx.secrets.botToken,
              intents: INTENTS,
              properties: { os: 'linux', browser: 'ordo', device: 'ordo' },
            },
          });
        } else if (msg.op === 1) {
          send({ op: 1, d: seq });
        } else if (msg.op === 7 || msg.op === 9) {
          close();
        } else if (msg.op === 0) {
          if (msg.t === 'READY') {
            await ictx.saveState({ botUserId: (msg.d as { user: DiscordUser }).user.id });
            await io.connected();
          } else if (msg.t === 'INTERACTION_CREATE') {
            // Must be acknowledged within three seconds, before the job runs.
            const i = msg.d as DiscordInteraction;
            if (i.type === 2) {
              await callApi(ictx.app, `${apiUrl()}/interactions/${i.id}/${i.token}/callback`, {
                method: 'POST',
                body: { type: 5, data: { flags: 64 } },
              });
            }
            await io.deliver({
              headers: {},
              query: {},
              body: JSON.stringify({ t: msg.t, d: msg.d }),
            });
          } else if (msg.t === 'MESSAGE_CREATE') {
            await io.deliver({
              headers: {},
              query: {},
              body: JSON.stringify({ t: msg.t, d: msg.d }),
            });
          }
        }
      });
    } finally {
      clearInterval(heartbeat);
    }
  },

  chat: {
    async post(ictx, channel, message, thread) {
      const send = (to: string) =>
        api<{ id: string }>(ictx, `/channels/${to}/messages`, {
          method: 'POST',
          body: discordMessage(message),
        });
      if (!thread) return (await send(channel)).data.id;
      // A thread started from a message has that message's id. Open it the first time.
      try {
        return (await send(thread.root)).data.id;
      } catch (err) {
        if (!(err instanceof ApiCallError) || err.status !== 404) throw err;
        await api(ictx, `/channels/${channel}/messages/${thread.root}/threads`, {
          method: 'POST',
          body: { name: thread.name, auto_archive_duration: 10080 },
        });
        return (await send(thread.root)).data.id;
      }
    },
    async direct(ictx, to, message) {
      let channel = to.dmChannel;
      if (!channel) {
        const { data } = await api<{ id: string }>(ictx, '/users/@me/channels', {
          method: 'POST',
          body: { recipient_id: to.externalId },
        });
        channel = data.id;
      }
      await api(ictx, `/channels/${channel}/messages`, {
        method: 'POST',
        body: discordMessage(message),
      });
      return channel;
    },
    linkHint: () => '/ordo command: link CODE',
  },
};
