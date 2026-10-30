import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Json } from './helpers.ts';

/**
 * A tiny Matrix homeserver for end-to-end encryption tests: accounts by token, device keys,
 * one-time keys, to-device messages, rooms and `/sync`. Just enough for two devices to set up
 * Olm sessions and exchange Megolm-encrypted messages; nothing is checked or signed.
 */

interface RoomEvent {
  event_id: string;
  type: string;
  sender: string;
  room_id: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}
interface Device {
  userId: string;
  deviceId: string;
  keys?: Record<string, unknown>;
  oneTimeKeys: Map<string, unknown>;
  fallbackKeys: Map<string, unknown>;
  toDevice: { type: string; sender: string; content: unknown }[];
  changed: Set<string>;
}

export async function startMockMatrix() {
  const byToken = new Map<string, Device>();
  const rooms = new Map<string, { members: Set<string>; encrypted: boolean }>();
  const log: RoomEvent[] = [];
  const keyUploads: { userId: string; deviceId: string; deviceKeys: boolean }[] = [];
  let n = 0;
  const devices = () => [...byToken.values()];
  const sharesRoom = (a: string, b: string) =>
    [...rooms.values()].some((r) => r.members.has(a) && r.members.has(b));

  function handle(
    device: Device,
    method: string,
    parts: string[],
    query: URLSearchParams,
    body: Json,
  ) {
    const route = parts.join('/');
    if (method === 'GET' && route === 'account/whoami')
      return { user_id: device.userId, device_id: device.deviceId };

    if (method === 'POST' && route === 'keys/upload') {
      if (body.device_keys) {
        device.keys = body.device_keys;
        for (const other of devices())
          if (other !== device && sharesRoom(other.userId, device.userId))
            other.changed.add(device.userId);
      }
      for (const [id, key] of Object.entries(body.one_time_keys ?? {}))
        device.oneTimeKeys.set(id, key);
      for (const [id, key] of Object.entries(body.fallback_keys ?? {}))
        device.fallbackKeys.set(id, key);
      keyUploads.push({
        userId: device.userId,
        deviceId: device.deviceId,
        deviceKeys: !!body.device_keys,
      });
      return { one_time_key_counts: { signed_curve25519: device.oneTimeKeys.size } };
    }
    if (method === 'POST' && route === 'keys/query') {
      const out: Record<string, Record<string, unknown>> = {};
      for (const user of Object.keys(body.device_keys ?? {})) {
        out[user] = {};
        for (const d of devices()) if (d.userId === user && d.keys) out[user]![d.deviceId] = d.keys;
      }
      return {
        device_keys: out,
        failures: {},
        master_keys: {},
        self_signing_keys: {},
        user_signing_keys: {},
      };
    }
    if (method === 'POST' && route === 'keys/claim') {
      const out: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const [user, wanted] of Object.entries(body.one_time_keys ?? {})) {
        for (const [deviceId, algorithm] of Object.entries(wanted as Record<string, string>)) {
          const d = devices().find((x) => x.userId === user && x.deviceId === deviceId);
          if (!d) continue;
          const pick = (keys: Map<string, unknown>, remove: boolean) => {
            const id = [...keys.keys()].find((k) => k.startsWith(`${algorithm}:`));
            if (!id) return null;
            const key = keys.get(id);
            if (remove) keys.delete(id);
            return { [id]: key };
          };
          const claimed = pick(d.oneTimeKeys, true) ?? pick(d.fallbackKeys, false);
          if (claimed) {
            out[user] ??= {};
            out[user][deviceId] = claimed;
          }
        }
      }
      return { one_time_keys: out, failures: {} };
    }
    if (method === 'PUT' && parts[0] === 'sendToDevice') {
      const type = parts[1]!;
      for (const [user, targets] of Object.entries(body.messages ?? {})) {
        for (const [deviceId, content] of Object.entries(targets as Record<string, unknown>)) {
          for (const d of devices())
            if (d.userId === user && (deviceId === '*' || d.deviceId === deviceId))
              d.toDevice.push({ type, sender: device.userId, content });
        }
      }
      return {};
    }
    if (method === 'GET' && route === 'sync') {
      const since = query.get('since');
      const from = since === null ? log.length : Number(since);
      const join: Record<string, { timeline: { events: RoomEvent[] } }> = {};
      if (since !== null) {
        for (const e of log.slice(from)) {
          if (!rooms.get(e.room_id)?.members.has(device.userId)) continue;
          join[e.room_id] ??= { timeline: { events: [] } };
          join[e.room_id]!.timeline.events.push(e);
        }
      }
      const toDevice = device.toDevice.splice(0);
      const changed = [...device.changed];
      device.changed.clear();
      return {
        next_batch: String(log.length),
        rooms: { join },
        to_device: { events: toDevice },
        device_lists: { changed, left: [] },
        device_one_time_keys_count: { signed_curve25519: device.oneTimeKeys.size },
        device_unused_fallback_key_types: device.fallbackKeys.size ? ['signed_curve25519'] : [],
      };
    }
    if (parts[0] === 'rooms') {
      const roomId = parts[1]!;
      const room = rooms.get(roomId);
      if (!room) return { status: 404, body: { errcode: 'M_NOT_FOUND' } };
      if (method === 'PUT' && parts[2] === 'send') {
        const event: RoomEvent = {
          event_id: `$e${++n}`,
          type: parts[3]!,
          sender: device.userId,
          room_id: roomId,
          origin_server_ts: Date.now(),
          content: body,
        };
        log.push(event);
        return { event_id: event.event_id };
      }
      if (method === 'GET' && parts[2] === 'state' && parts[3] === 'm.room.encryption')
        return room.encrypted
          ? { algorithm: 'm.megolm.v1.aes-sha2' }
          : { status: 404, body: { errcode: 'M_NOT_FOUND' } };
      if (method === 'GET' && parts[2] === 'members')
        return {
          chunk: [...room.members].map((u) => ({
            type: 'm.room.member',
            state_key: u,
            content: { membership: 'join' },
          })),
        };
      if (method === 'GET' && parts[2] === 'joined_members')
        return { joined: Object.fromEntries([...room.members].map((u) => [u, {}])) };
      if (method === 'GET' && parts[2] === 'event')
        return log.find((e) => e.event_id === parts[3]) ?? { status: 404, body: {} };
    }
    if (method === 'POST' && parts[0] === 'join') {
      rooms.get(parts[1]!)?.members.add(device.userId);
      return { room_id: parts[1] };
    }
    if (method === 'GET' && parts[0] === 'profile')
      return { displayname: parts[1]!.slice(1).split(':')[0] };
    return { status: 404, body: { errcode: 'M_UNRECOGNIZED' } };
  }

  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'http://x');
    const prefix = '/_matrix/client/v3/';
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const device = byToken.get(token);
    let out: unknown;
    if (!url.pathname.startsWith(prefix) || !device)
      out = { status: 401, body: { errcode: 'M_UNKNOWN_TOKEN' } };
    else {
      const parts = url.pathname
        .slice(prefix.length)
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
      out = handle(device, req.method!, parts, url.searchParams, raw ? JSON.parse(raw) : {});
    }
    const { status, body } =
      out && typeof out === 'object' && 'status' in out && 'body' in out
        ? (out as { status: number; body: unknown })
        : { status: 200, body: out };
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    events: log,
    keyUploads,
    addDevice(token: string, userId: string, deviceId: string) {
      byToken.set(token, {
        userId,
        deviceId,
        oneTimeKeys: new Map(),
        fallbackKeys: new Map(),
        toDevice: [],
        changed: new Set(),
      });
    },
    addRoom(roomId: string, members: string[], encrypted: boolean) {
      rooms.set(roomId, { members: new Set(members), encrypted });
    },
    deviceKeys: (userId: string) => devices().find((d) => d.userId === userId)?.keys,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
