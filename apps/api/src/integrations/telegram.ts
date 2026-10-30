import { randomBytes } from 'node:crypto';
import { escapeHtml as html } from '../lib/html.ts';
import {
  type ChatIncoming,
  chatFeed,
  parseChannels,
  runChatCommand,
  syncThreadReply,
  unfurl,
} from '../services/chat.ts';
import { sleep } from '../services/connectors.ts';
import { callApi, safeEqual } from './http.ts';
import type {
  ChatMessage,
  IntegrationContext,
  IntegrationProvider,
  IntegrationRow,
} from './types.ts';

/**
 * Telegram: a bot token from @BotFather. Updates arrive by webhook (Telegram must reach Ordo) or
 * long polling (works behind NAT). Commands: /link, /new (reply to a message to file it),
 * /unlink, /help; in groups they may carry the bot's name (/new@ordo_bot). Seeing issue links in
 * groups needs privacy mode off.
 */

interface TelegramConfig {
  delivery: 'webhook' | 'longpoll';
}

const cfg = (row: IntegrationRow) => row.config as unknown as TelegramConfig;
// Overridable for tests (a mock Telegram) and nothing else.
const apiUrl = () => process.env.ORDO_TELEGRAM_API_URL ?? 'https://api.telegram.org';

async function tg<T = unknown>(
  ictx: IntegrationContext,
  method: string,
  body: Record<string, unknown> = {},
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const { data } = await callApi<{ ok: boolean; result: T; description?: string }>(
    ictx.app,
    `${apiUrl()}/bot${ictx.secrets.botToken}/${method}`,
    { method: 'POST', body, ...opts },
  ).catch((err: Error) => {
    // Never let the token (part of the URL) end up in an error message.
    throw new Error(err.message.replaceAll(ictx.secrets.botToken!, '…'));
  });
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? 'failed'}`);
  return data.result;
}

export function telegramText(m: ChatMessage) {
  const parts = [`<b>${html(m.headline)}</b>`];
  if (m.title) parts.push(m.url ? `<a href="${html(m.url)}">${html(m.title)}</a>` : html(m.title));
  if (m.body) parts.push(`<blockquote>${html(m.body)}</blockquote>`);
  if (m.context) parts.push(`<i>${html(m.context)}</i>`);
  return {
    text: parts.join('\n').slice(0, 4000),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
}

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
}

const COMMANDS = new Set(['link', 'unlink', 'new', 'create', 'issue', 'help', 'start', 'ordo']);

/** "/new@ordo_bot Fix it" → "new Fix it"; null when the message isn't for the bot. */
export function telegramCommand(text: string, botUsername: string | undefined, direct: boolean) {
  const m = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (m) {
    const [, verb, target, rest = ''] = m;
    if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
    if (!COMMANDS.has(verb!.toLowerCase())) return direct ? 'help' : null;
    if (verb === 'ordo') return rest;
    // /start CODE comes from a t.me/<bot>?start=CODE link.
    return verb === 'start' ? (rest ? `link ${rest}` : 'help') : `${verb} ${rest}`;
  }
  return direct ? text : null;
}

async function handleMessage(ictx: IntegrationContext, m: TgMessage) {
  if (!m.from || m.from.is_bot) return;
  const text = m.text ?? '';
  const direct = m.chat.type === 'private';
  const reply = (answer: ChatMessage) =>
    tg(ictx, 'sendMessage', {
      chat_id: m.chat.id,
      reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
      ...telegramText(answer),
    });
  const command = telegramCommand(text, ictx.integration.state.botUsername as string, direct);
  if (command !== null) {
    const ref = m.reply_to_message;
    const incoming: ChatIncoming = {
      channel: String(m.chat.id),
      user: { id: String(m.from.id), name: m.from.username ?? m.from.first_name },
      text: command,
      direct,
      ...(ref && {
        quoted: {
          id: `${m.chat.id}:${ref.message_id}`,
          text: ref.text ?? ref.caption ?? '',
          // Only public chats have links to messages.
          url: m.chat.username ? `https://t.me/${m.chat.username}/${ref.message_id}` : null,
          author: ref.from?.username ?? ref.from?.first_name,
        },
      }),
    };
    await reply(await runChatCommand(ictx, incoming));
    return;
  }
  // Replying to an issue's message (or to a reply to it) in a group is a comment.
  if (
    m.reply_to_message &&
    !direct &&
    (await syncThreadReply(ictx, {
      channel: String(m.chat.id),
      parent: String(m.reply_to_message.message_id),
      messageRef: String(m.message_id),
      user: {
        id: String(m.from.id),
        name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username,
      },
      text,
    }))
  )
    return;
  for (const preview of await unfurl(ictx, String(m.from.id), text)) await reply(preview.message);
}

export const telegramProvider: IntegrationProvider = {
  key: 'telegram',
  name: 'Telegram',
  description:
    'Post issue activity to groups, message people their notifications and create issues from messages.',
  category: 'chat',

  configure({ config, secrets }) {
    if (!/^\d+:[\w-]{20,}$/.test(String(secrets.botToken ?? '')))
      throw new Error('The bot token looks like 123456:ABC… (from @BotFather)');
    return {
      config: {
        delivery: config.delivery === 'longpoll' ? 'longpoll' : 'webhook',
        channels: parseChannels(config.channels),
      },
      secrets: {
        botToken: String(secrets.botToken),
        webhookSecret: String(secrets.webhookSecret || randomBytes(24).toString('hex')),
      },
    };
  },

  async install(ictx) {
    const me = await tg<{ id: number; username: string }>(ictx, 'getMe');
    await ictx.saveState({ botId: me.id, botUsername: me.username });
    if (cfg(ictx.integration).delivery === 'webhook') {
      await tg(ictx, 'setWebhook', {
        url: `${ictx.app.env.publicUrl}/api/hooks/telegram/${ictx.integration.inboundToken}`,
        secret_token: ictx.secrets.webhookSecret,
        allowed_updates: ['message'],
      });
    } else {
      // getUpdates refuses to work while a webhook is set.
      await tg(ictx, 'deleteWebhook');
    }
  },

  async uninstall(ictx) {
    if (cfg(ictx.integration).delivery === 'webhook') await tg(ictx, 'deleteWebhook');
  },

  verify: (req, _row, secrets) =>
    safeEqual(req.headers['x-telegram-bot-api-secret-token'], secrets.webhookSecret),

  deliveryId: (req) => String(JSON.parse(req.body).update_id ?? '') || null,

  async handleInbound(ictx, req) {
    const update = JSON.parse(req.body) as { message?: TgMessage };
    if (update.message) await handleMessage(ictx, update.message);
  },

  onDomainEvent: chatFeed,

  wantsConnection: (row) => cfg(row).delivery === 'longpoll',

  async connect(ictx, io) {
    let offset: number | undefined;
    let announced = false;
    while (!io.signal.aborted) {
      const updates = await tg<{ update_id: number }[]>(
        ictx,
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message'] },
        { timeoutMs: 40_000, signal: io.signal },
      ).catch((err) => {
        if (io.signal.aborted) return [];
        throw err;
      });
      if (!announced) {
        announced = true;
        await io.connected();
      }
      for (const u of updates) {
        await io.deliver({ headers: {}, query: {}, body: JSON.stringify(u) });
        offset = u.update_id + 1;
      }
      // Without a long-polling server (tests), don't spin.
      if (!updates.length) await sleep(250, io.signal);
    }
  },

  chat: {
    async post(ictx, channel, message, thread) {
      const sent = await tg<{ message_id: number }>(ictx, 'sendMessage', {
        chat_id: channel,
        // Telegram's threads are reply chains.
        ...(thread && {
          reply_parameters: { message_id: Number(thread.root), allow_sending_without_reply: true },
        }),
        ...telegramText(message),
      });
      return sent?.message_id === undefined ? undefined : String(sent.message_id);
    },
    async direct(ictx, to, message) {
      // A private chat's id is the user's id.
      await tg(ictx, 'sendMessage', { chat_id: to.externalId, ...telegramText(message) });
      return undefined;
    },
    linkHint: (row) =>
      `/link CODE in a private chat with ${row.state.botUsername ? `@${row.state.botUsername}` : 'the bot'}`,
  },
};
