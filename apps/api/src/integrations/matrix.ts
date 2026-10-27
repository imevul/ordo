import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { matrixCryptoStores } from '../db/schema.ts';
import {
  type ChatIncoming,
  chatFeed,
  parseChannels,
  runChatCommand,
  syncThreadReply,
  unfurl,
} from '../services/chat.ts';
import { sleep } from '../services/connectors.ts';
import { ApiCallError, callApi, trimUrl } from './http.ts';
import {
  type CryptoSync,
  forgetMatrixCrypto,
  type MatrixEventJson,
  withMatrixCrypto,
} from './matrix-crypto.ts';
import type {
  ChatMessage,
  IntegrationContext,
  IntegrationProvider,
  IntegrationRow,
} from './types.ts';

/**
 * Matrix: a bot account's access token on any homeserver. Ordo long-polls `/sync` (no
 * appservice, nothing to expose, so it works behind NAT), joins rooms it's invited to and answers
 * `!ordo …` (or anything, in a direct chat). With `encryption` on, the token's device takes part
 * in end-to-end encrypted rooms (matrix-crypto.ts): messages there are decrypted as they sync and
 * encrypted as they're sent.
 */

interface MatrixConfig {
  homeserverUrl: string;
  encryption?: boolean;
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

const caller =
  (ictx: IntegrationContext) =>
  <T>(path: string, opts?: { method?: string; body?: unknown }) =>
    api<T>(ictx, path, opts);

const e2ee = (row: IntegrationRow) => cfg(row).encryption === true;

// Rooms never stop being encrypted; ones that aren't are checked again after a while.
const encryptedRooms = new Map<string, number | true>();

async function isEncrypted(ictx: IntegrationContext, room: string) {
  const key = `${ictx.integration.id}:${room}`;
  const known = encryptedRooms.get(key);
  if (known === true || (known && known > Date.now())) return known === true;
  const encrypted = await api(ictx, `/rooms/${encodeURIComponent(room)}/state/m.room.encryption/`)
    .then(() => true)
    .catch((err) => {
      if (err instanceof ApiCallError && err.status === 404) return false;
      throw err;
    });
  encryptedRooms.set(key, encrypted || Date.now() + 5 * 60_000);
  return encrypted;
}

/** Everyone a message in the room should be readable by: joined and invited members. */
async function roomMembers(ictx: IntegrationContext, room: string) {
  const { chunk } = await api<{
    chunk: { state_key: string; content: { membership?: string } }[];
  }>(ictx, `/rooms/${encodeURIComponent(room)}/members?not_membership=leave`);
  return chunk
    .filter((m) => m.content.membership === 'join' || m.content.membership === 'invite')
    .map((m) => m.state_key);
}

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

async function send(ictx: IntegrationContext, room: string, content: Record<string, unknown>) {
  let type = 'm.room.message';
  let body = content;
  if (e2ee(ictx.integration) && (await isEncrypted(ictx, room))) {
    const members = await roomMembers(ictx, room);
    body = await withMatrixCrypto(ictx, caller(ictx), (s) =>
      s.encrypt(room, members, 'm.room.message', content),
    );
    // Relations stay readable to the server, so threads and replies still group.
    if (content['m.relates_to'] && !body['m.relates_to'])
      body = { ...body, 'm.relates_to': content['m.relates_to'] };
    type = 'm.room.encrypted';
  }
  return api<{ event_id: string }>(
    ictx,
    `/rooms/${encodeURIComponent(room)}/send/${type}/${randomUUID()}`,
    { method: 'PUT', body },
  );
}

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
    let parent = await api<MatrixEvent>(
      ictx,
      `/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(parentId)}`,
    ).catch(() => null);
    if (parent?.type === 'm.room.encrypted' && e2ee(ictx.integration)) {
      const encrypted = parent as unknown as MatrixEventJson;
      parent = (await withMatrixCrypto(ictx, caller(ictx), (s) =>
        s.decrypt(room, encrypted),
      )) as unknown as MatrixEvent | null;
    }
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

interface SyncResponse extends CryptoSync {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEvent[] } }>;
    invite?: Record<string, unknown>;
  };
}

/** Whether a sync has anything for the crypto machine. */
const forCrypto = (res: SyncResponse) =>
  !!res.to_device?.events?.length ||
  !!res.device_lists?.changed?.length ||
  !!res.device_lists?.left?.length ||
  (res.device_one_time_keys_count?.signed_curve25519 ?? 50) < 50 ||
  Object.values(res.rooms?.join ?? {}).some((r) =>
    r.timeline?.events?.some((e) => e.type === 'm.room.encrypted'),
  );

export const matrixProvider: IntegrationProvider = {
  key: 'matrix',
  name: 'Matrix',
  description:
    'Post issue activity to rooms, message people their notifications and create issues from messages.',
  category: 'chat',

  configure({ config, secrets }) {
    let homeserverUrl: string;
    const encryption = config.encryption === true;
    try {
      homeserverUrl = trimUrl(new URL(String(config.homeserverUrl ?? '')).toString());
    } catch {
      throw new Error('The homeserver URL is not valid, e.g. https://matrix.example.org');
    }
    if (!secrets.accessToken) throw new Error("The bot account's access token is required");
    return {
      config: { homeserverUrl, encryption, channels: parseChannels(config.channels) },
      secrets: { accessToken: String(secrets.accessToken) },
    };
  },

  async install(ictx) {
    const { user_id, device_id } = await api<{ user_id: string; device_id?: string }>(
      ictx,
      '/account/whoami',
    );
    // Another device (a new token) means other keys: the old store is no use to it.
    if (ictx.integration.state.deviceId && ictx.integration.state.deviceId !== device_id) {
      await ictx.app.db
        .delete(matrixCryptoStores)
        .where(eq(matrixCryptoStores.integrationId, ictx.integration.id));
      forgetMatrixCrypto(ictx.integration.id);
    }
    await ictx.saveState({ userId: user_id, deviceId: device_id ?? null });
    if (e2ee(ictx.integration)) {
      if (!device_id)
        throw new Error('Encryption needs an access token from a login (one with a device)');
      // Uploads the device's keys now, so a token that can't do encryption fails here.
      const state = { ...ictx.integration.state, userId: user_id, deviceId: device_id };
      await withMatrixCrypto(
        { ...ictx, integration: { ...ictx.integration, state } },
        caller(ictx),
        async () => {},
      );
    }
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
      // Room keys sent to the bot before it first connected arrive here.
      if (e2ee(ictx.integration) && forCrypto(first))
        await withMatrixCrypto(ictx, caller(ictx), (s) => s.receiveSync(first));
    }
    let batch: string = since;
    const encrypted = e2ee(ictx.integration);
    if (encrypted) await withMatrixCrypto(ictx, caller(ictx), async () => {});
    // Messages whose room key hasn't arrived yet: tried again on the next few syncs.
    let waiting: { room: string; event: MatrixEventJson; tries: number }[] = [];
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
      const plain: { room: string; event: MatrixEvent }[] = [];
      const sealed: typeof waiting = [];
      for (const [room, joined] of Object.entries(res.rooms?.join ?? {})) {
        for (const event of joined.timeline?.events ?? []) {
          if (event.type === 'm.room.message') plain.push({ room, event });
          else if (event.type === 'm.room.encrypted' && encrypted)
            sealed.push({ room, event: event as unknown as MatrixEventJson, tries: 0 });
          else if (event.type === 'm.room.encryption')
            encryptedRooms.set(`${ictx.integration.id}:${room}`, true);
        }
      }
      if (encrypted && (forCrypto(res) || waiting.length)) {
        const queue = [...waiting, ...sealed];
        const opened = await withMatrixCrypto(ictx, caller(ictx), async (s) => {
          await s.receiveSync(res);
          const out: (MatrixEventJson | null)[] = [];
          for (const q of queue) out.push(await s.decrypt(q.room, q.event));
          return out;
        });
        waiting = [];
        queue.forEach((q, i) => {
          const event = opened[i];
          if (event?.type === 'm.room.message')
            plain.push({ room: q.room, event: event as unknown as MatrixEvent });
          else if (!event && q.tries < 5) waiting.push({ ...q, tries: q.tries + 1 });
        });
      }
      for (const { room, event } of plain) {
        await io.deliver({ headers: {}, query: {}, body: JSON.stringify({ room, event }) });
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
          body: {
            is_direct: true,
            invite: [to.externalId],
            preset: 'trusted_private_chat',
            ...(e2ee(ictx.integration) && {
              initial_state: [
                {
                  type: 'm.room.encryption',
                  state_key: '',
                  content: { algorithm: 'm.megolm.v1.aes-sha2' },
                },
              ],
            }),
          },
        }));
      }
      await send(ictx, room, matrixContent(message));
      return room;
    },
    linkHint: (row) =>
      `!ordo link CODE in a direct chat with ${(row.state.userId as string) ?? 'the bot'}`,
  },
};
