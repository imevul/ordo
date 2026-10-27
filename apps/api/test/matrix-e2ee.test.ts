import * as sdk from '@matrix-org/matrix-sdk-crypto-wasm';
import type { Integration } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matrixCryptoStores } from '../src/db/schema.ts';
import { forgetMatrixCrypto } from '../src/integrations/matrix-crypto.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { startMockMatrix } from './mock-matrix.ts';

let app: FastifyInstance;
let hs: Awaited<ReturnType<typeof startMockMatrix>>;
let owner: Client;
let matrix: Integration;
const slug = `e2ee-${Date.now()}`;
const ws = `/api/w/${slug}`;
const room = '!secret:hs.test';
const BOT = '@ordo:hs.test';
const ALICE = '@alice:hs.test';

async function until<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  ms = 15_000,
) {
  const end = Date.now() + ms;
  for (;;) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface AliceSync {
  next_batch: string;
  to_device: { events: unknown[] };
  device_lists: { changed: string[] };
  device_one_time_keys_count: Record<string, number>;
  rooms: { join: Record<string, { timeline: { events: { sender: string; type: string }[] } }> };
}

/** Alice's client: her own crypto machine, talking to the same homeserver. */
const alice = {
  machine: null as unknown as sdk.OlmMachine,
  since: undefined as string | undefined,
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${hs.url}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  },
  async send(r: sdk.OutgoingRequest) {
    const body = JSON.parse(r.body);
    const path = {
      [sdk.RequestType.KeysUpload]: () => ['POST', '/keys/upload'],
      [sdk.RequestType.KeysQuery]: () => ['POST', '/keys/query'],
      [sdk.RequestType.KeysClaim]: () => ['POST', '/keys/claim'],
      [sdk.RequestType.ToDevice]: () => {
        const t = r as sdk.ToDeviceRequest;
        return ['PUT', `/sendToDevice/${t.event_type}/${t.txn_id}`];
      },
    }[r.type as number];
    if (!path) return;
    const [method, url] = path();
    await this.machine.markRequestAsSent(
      r.id!,
      r.type as sdk.RequestType,
      JSON.stringify(await this.call(method!, url!, body)),
    );
  },
  async flush() {
    for (let i = 0; i < 5; i++) {
      const requests = await this.machine.outgoingRequests();
      if (!requests.length) return;
      for (const r of requests) await this.send(r);
    }
  },
  /** Syncs and returns the plaintext of the bot's new messages in the room. */
  async read() {
    const res = (await this.call(
      'GET',
      `/sync${this.since === undefined ? '' : `?since=${this.since}`}`,
    )) as AliceSync;
    this.since = res.next_batch;
    await this.machine.receiveSyncChanges(
      JSON.stringify(res.to_device.events),
      new sdk.DeviceLists(
        res.device_lists.changed.map((u: string) => new sdk.UserId(u)),
        [],
      ),
      new Map(Object.entries(res.device_one_time_keys_count)),
      new Set(),
    );
    await this.flush();
    const out: string[] = [];
    for (const e of res.rooms.join[room]?.timeline.events ?? []) {
      if (e.sender !== BOT || e.type !== 'm.room.encrypted') continue;
      const plain = await this.machine.decryptRoomEvent(
        JSON.stringify(e),
        new sdk.RoomId(room),
        new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted),
      );
      out.push(JSON.parse(plain.event).content.body);
    }
    return out;
  },
  async say(text: string) {
    const users = () => [new sdk.UserId(ALICE), new sdk.UserId(BOT)];
    await this.machine.updateTrackedUsers(users());
    await this.flush();
    const claim = await this.machine.getMissingSessions(users());
    if (claim) await this.send(claim);
    for (const r of await this.machine.shareRoomKey(
      new sdk.RoomId(room),
      users(),
      new sdk.EncryptionSettings(),
    ))
      await this.send(r);
    const content = await this.machine.encryptRoomEvent(
      new sdk.RoomId(room),
      'm.room.message',
      JSON.stringify({ msgtype: 'm.text', body: text }),
    );
    await this.call(
      'PUT',
      `/rooms/${encodeURIComponent(room)}/send/m.room.encrypted/${Math.random()}`,
      JSON.parse(content),
    );
  },
};

beforeAll(async () => {
  hs = await startMockMatrix();
  hs.addDevice('bot-token', BOT, 'BOTDEVICE');
  hs.addDevice('alice-token', ALICE, 'ALICEDEVICE');
  hs.addRoom(room, [BOT, ALICE], true);
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  owner = (await signup(app, 'Erin Encrypted')).client;
  await owner.post('/api/workspaces', { name: 'E2EE', slug, teamName: 'Alpha', teamKey: 'ALP' });
  await sdk.initAsync();
  alice.machine = await sdk.OlmMachine.initialize(
    new sdk.UserId(ALICE),
    new sdk.DeviceId('ALICEDEVICE'),
  );
  await alice.flush();
  await alice.read();
});
afterAll(async () => {
  await app.close();
  await hs.close();
});

describe('Matrix end-to-end encryption', () => {
  it('sets up its device and keeps its keys, encrypted', async () => {
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'matrix',
      config: {
        homeserverUrl: hs.url,
        encryption: true,
        channels: [{ id: room, events: ['issue.created'] }],
      },
      secrets: { accessToken: 'bot-token' },
    });
    expect(res.statusCode).toBe(200);
    matrix = res.data;
    expect(matrix.status).toBe('active');
    expect(hs.deviceKeys(BOT)).toMatchObject({ user_id: BOT, device_id: 'BOTDEVICE' });
    const [store] = await app.db
      .select()
      .from(matrixCryptoStores)
      .where(eq(matrixCryptoStores.integrationId, matrix.id));
    expect(store!.version).toBeGreaterThan(0);
    // Sealed with the instance key: no key material in the clear.
    expect(store!.data).not.toContain('curve25519');
  });

  it('reads encrypted commands and answers encrypted', async () => {
    await app.connectors.tick();
    expect(app.connectors.active).toContain(matrix.id);
    await alice.say('!ordo help');
    const replies = await until(async () => {
      const got = await alice.read();
      return got.length ? got : false;
    });
    expect(replies.join()).toContain('new [TEAM] title');
    // Nothing went out in the clear.
    expect(
      hs.events.filter((e) => e.sender === BOT).every((e) => e.type === 'm.room.encrypted'),
    ).toBe(true);
  });

  it('posts the room feed encrypted', async () => {
    const issue = (
      await owner.post(`${ws}/issues`, {
        teamId: (await owner.get(`${ws}/bootstrap`)).data.teams[0].id,
        title: 'Sealed issue',
      })
    ).data;
    const posts = await until(async () => {
      const got = await alice.read();
      return got.some((b) => b.includes(`created ${issue.identifier}`)) ? got : false;
    });
    expect(posts.join()).toContain('Sealed issue');
  });

  it('keeps the same device after a restart', async () => {
    const uploads = hs.keyUploads.filter((u) => u.userId === BOT && u.deviceKeys).length;
    forgetMatrixCrypto();
    await alice.say('!ordo help');
    const replies = await until(async () => {
      const got = await alice.read();
      return got.length ? got : false;
    });
    expect(replies.join()).toContain('new [TEAM] title');
    expect(hs.keyUploads.filter((u) => u.userId === BOT && u.deviceKeys)).toHaveLength(uploads);
  });
});
