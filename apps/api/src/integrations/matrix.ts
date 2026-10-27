import { randomUUID } from 'node:crypto';
import {
  type ChatIncoming,
  chatFeed,
  parseChannels,
  runChatCommand,
  syncThreadReply,
  unfurl,
} from '../services/chat.ts';
import { sleep } from '../services/connectors.ts';
import { callApi, trimUrl } from './http.ts';
import type {
  ChatMessage,
  IntegrationContext,
  IntegrationProvider,
  IntegrationRow,
} from './types.ts';

/**
 * Matrix: a bot account's access token on any homeserver. Ordo long-polls `/sync` (no
 * appservice, nothing to expose, so it works behind NAT), joins rooms it's invited to and answers
 * `!ordo …` (or anything, in a direct chat). Encrypted rooms aren't supported.
 */

interface MatrixConfig {
  homeserverUrl: string;
}

const cfg = (row: IntegrationRow) => row.config as unknown as MatrixConfig;

const api = <T>(
  ictx: IntegrationContext,
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
) =>
  callApi<T>(ictx.app, `${cfg(ictx.integration).homeserverUrl}/_matrix/client/v3${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${ictx.secrets.accessToken}` },
  }).then((r) => r.data);

const html = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function matrixContent(m: ChatMessage) {
  const plain = [m.headline, m.title && `${m.title}${m.url ? ` ${m.url}` : ''}`, m.body, m.context]
    .filter(Boolean)
    .join('\n');
  const rich = [
    `<strong>${html(m.headline)}</strong>`,
    m.title && (m.url ? `<a href="${html(m.url)}">${html(m.title)}</a>` : html(m.title)),
    m.body && `<blockquote>${html(m.body).replace(/\n/g, '<br>')}</blockquote>`,
    m.context && `<em>${html(m.context)}</em>`,
  ]
    .filter(Boolean)
    .join('<br>');
  return {
    msgtype: 'm.notice',
    body: plain,
    format: 'org.matrix.custom.html',
    formatted_body: rich,
  };
}

const send = (ictx: IntegrationContext, room: string, content: Record<string, unknown>) =>
  api<{ event_id: string }>(
    ictx,
    `/rooms/${encodeURIComponent(room)}/send/m.room.message/${randomUUID()}`,
    { method: 'PUT', body: content },
  );

/** In a thread, with a reply to its first message for clients that don't show threads. */
const inThread = (root: string) => ({
  'm.relates_to': {
    rel_type: 'm.thread',
    event_id: root,
    is_falling_back: true,
    'm.in_reply_to': { event_id: root },
  },
});

/** Replies quote their parent in a fallback ("> <@a:b> text" lines, then a blank line). */
const stripFallback = (body: string) => body.replace(/^(> .*\n)+\n/, '');

interface MatrixEvent {
  event_id: string;
  sender: string;
  type: string;
  content: {
    msgtype?: string;
    body?: string;
    'm.relates_to'?: {
      rel_type?: string;
      event_id?: string;
      'm.in_reply_to'?: { event_id: string };
    };
  };
}

// Whether a room is a one-to-one chat, per process: membership rarely changes.
const directRooms = new Map<string, boolean>();

async function isDirect(ictx: IntegrationContext, room: string) {
  if (!directRooms.has(room)) {
    const { joined } = await api<{ joined: Record<string, unknown> }>(
      ictx,
      `/rooms/${encodeURIComponent(room)}/joined_members`,
    );
    directRooms.set(room, Object.keys(joined).length === 2);
  }
  return directRooms.get(room)!;
}

async function handleMessage(ictx: IntegrationContext, room: string, e: MatrixEvent) {
  const self = ictx.integration.state.userId as string | undefined;
  if (e.type !== 'm.room.message' || e.sender === self || e.content.msgtype !== 'm.text') return;
  const body = stripFallback(e.content.body ?? '');
  const reply = (answer: ChatMessage) =>
    send(ictx, room, {
      ...matrixContent(answer),
      'm.relates_to': { 'm.in_reply_to': { event_id: e.event_id } },
    });

  let text: string | null = null;
  if (/^\s*!ordo\b/i.test(body)) text = body.replace(/^\s*!ordo\b/i, '');
  else if (self && body.trimStart().startsWith(self))
    text = body
      .trimStart()
      .slice(self.length)
      .replace(/^[:,]?/, '');
  else if (await isDirect(ictx, room)) text = body;

  if (text === null) {
    const relation = e.content['m.relates_to'];
    if (
      relation?.rel_type === 'm.thread' &&
      relation.event_id &&
      (await syncThreadReply(ictx, {
        channel: room,
        parent: relation.event_id,
        messageRef: e.event_id,
        user: { id: e.sender },
        displayName: async () =>
          (
            await api<{ displayname?: string }>(
              ictx,
              `/profile/${encodeURIComponent(e.sender)}/displayname`,
            )
          ).displayname,
        text: body,
      }))
    )
      return;
    for (const preview of await unfurl(ictx, e.sender, body)) await reply(preview.message);
    return;
  }
  const incoming: ChatIncoming = {
    channel: room,
    user: { id: e.sender, name: e.sender },
    text: text.trim(),
    direct: await isDirect(ictx, room),
  };
  const parentId = e.content['m.relates_to']?.['m.in_reply_to']?.event_id;
  if (parentId) {
    const parent = await api<MatrixEvent>(
      ictx,
      `/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(parentId)}`,
    ).catch(() => null);
    if (parent?.content.body) {
      incoming.quoted = {
        id: parentId,
        text: stripFallback(parent.content.body),
        url: `https://matrix.to/#/${encodeURIComponent(room)}/${encodeURIComponent(parentId)}`,
        author: parent.sender,
      };
    }
  }
  await reply(await runChatCommand(ictx, incoming));
}

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEvent[] } }>;
    invite?: Record<string, unknown>;
  };
}

export const matrixProvider: IntegrationProvider = {
  key: 'matrix',
  name: 'Matrix',
  description:
    'Post issue activity to rooms, message people their notifications and create issues from messages.',
  category: 'chat',

  configure({ config, secrets }) {
    let homeserverUrl: string;
    try {
      homeserverUrl = trimUrl(new URL(String(config.homeserverUrl ?? '')).toString());
    } catch {
      throw new Error('The homeserver URL is not valid, e.g. https://matrix.example.org');
    }
    if (!secrets.accessToken) throw new Error("The bot account's access token is required");
    return {
      config: { homeserverUrl, channels: parseChannels(config.channels) },
      secrets: { accessToken: String(secrets.accessToken) },
    };
  },

  async install(ictx) {
    const { user_id } = await api<{ user_id: string }>(ictx, '/account/whoami');
    await ictx.saveState({ userId: user_id });
    for (const channel of (ictx.integration.config.channels ?? []) as { id: string }[]) {
      await api(ictx, `/join/${encodeURIComponent(channel.id)}`, { method: 'POST', body: {} });
    }
  },

  deliveryId: (req) => JSON.parse(req.body).event?.event_id ?? null,

  async handleInbound(ictx, req) {
    const { room, event } = JSON.parse(req.body) as { room: string; event: MatrixEvent };
    await handleMessage(ictx, room, event);
  },

  onDomainEvent: chatFeed,

  wantsConnection: () => true,

  async connect(ictx, io) {
    // Start from where the last connection stopped, or from now (no backlog of old messages).
    let since = ictx.integration.state.since as string | undefined;
    if (since === undefined) {
      const first = await api<SyncResponse>(
        ictx,
        `/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }))}`,
      );
      since = first.next_batch;
    }
    let batch: string = since;
    await io.connected();
    while (!io.signal.aborted) {
      const res: SyncResponse | null = await api<SyncResponse>(
        ictx,
        `/sync?timeout=25000&since=${encodeURIComponent(batch)}`,
        { timeoutMs: 40_000, signal: io.signal },
      ).catch((err) => {
        if (io.signal.aborted) return null;
        throw err;
      });
      if (!res) break;
      for (const room of Object.keys(res.rooms?.invite ?? {})) {
        await api(ictx, `/join/${encodeURIComponent(room)}`, { method: 'POST', body: {} }).catch(
          (err) => ictx.log.warn({ err, room }, 'could not join room'),
        );
      }
      for (const [room, joined] of Object.entries(res.rooms?.join ?? {})) {
        for (const event of joined.timeline?.events ?? []) {
          if (event.type !== 'm.room.message') continue;
          await io.deliver({ headers: {}, query: {}, body: JSON.stringify({ room, event }) });
        }
      }
      if (res.next_batch === batch) {
        // Nothing new and the server didn't hold the request open: don't spin.
        await sleep(1_000, io.signal);
        continue;
      }
      batch = res.next_batch;
      await ictx.saveState({ since: batch });
    }
  },

  chat: {
    async post(ictx, channel, message, thread) {
      const content = { ...matrixContent(message), ...(thread && inThread(thread.root)) };
      return (await send(ictx, channel, content)).event_id;
    },
    async direct(ictx, to, message) {
      let room = to.dmChannel;
      if (!room) {
        ({ room_id: room } = await api<{ room_id: string }>(ictx, '/createRoom', {
          method: 'POST',
          body: { is_direct: true, invite: [to.externalId], preset: 'trusted_private_chat' },
        }));
      }
      await send(ictx, room, matrixContent(message));
      return room;
    },
    linkHint: (row) =>
      `!ordo link CODE in a direct chat with ${(row.state.userId as string) ?? 'the bot'}`,
  },
};
