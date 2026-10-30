import { createHash, randomUUID } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import type * as Sdk from '@matrix-org/matrix-sdk-crypto-wasm';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { matrixCryptoStores } from '../db/schema.ts';
import { matrixCryptoStoreAad } from '../services/secretKey.ts';
import type { IntegrationContext } from './types.ts';

/**
 * End-to-end encryption for the Matrix bot, with matrix.org's Rust crypto (the same as Element's)
 * compiled to WebAssembly. Its store is IndexedDB; on Node that's `fake-indexeddb`, in memory,
 * and after every change the store is snapshotted, encrypted with the instance key, into
 * `matrix_crypto_stores`, so the bot keeps its device (and can read old messages) across restarts.
 *
 * One crypto operation at a time per integration: an in-process queue plus a lease, so servers
 * take turns. A server keeps its machine in memory and reloads it only when the stored version
 * moved on (another server changed it).
 *
 * The library and its 8 MB of WebAssembly load the first time an encrypted room needs them.
 */

type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
export interface MatrixEventJson {
  event_id: string;
  sender: string;
  type: string;
  room_id?: string;
  origin_server_ts?: number;
  content: Record<string, unknown>;
}
export interface CryptoSync {
  to_device?: { events?: unknown[] };
  device_lists?: { changed?: string[]; left?: string[] };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
}

let sdk: typeof Sdk | null = null;
async function load() {
  if (!sdk) {
    // The Rust store finds IndexedDB on the global object.
    await import('fake-indexeddb/auto');
    const lib = await import('@matrix-org/matrix-sdk-crypto-wasm');
    await lib.initAsync();
    sdk = lib;
  }
  return sdk;
}

// ─── the store snapshot ───────────────────────────────────────────────────

// The few IndexedDB types used here (the API isn't compiled with the DOM library).
type IdbKey = unknown;
interface IdbRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: (() => void) | null;
}
interface IdbCursor {
  primaryKey: IdbKey;
  value: unknown;
  continue(): void;
}
interface IdbObjectStore {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexNames: Iterable<string>;
  index(name: string): { keyPath: string | string[]; unique: boolean; multiEntry: boolean };
  openCursor(): IdbRequest<IdbCursor | null>;
  put(value: unknown, key?: IdbKey): unknown;
  createIndex(
    name: string,
    keyPath: string | string[],
    opts: { unique: boolean; multiEntry: boolean },
  ): unknown;
}
interface IdbTransaction {
  objectStore(name: string): IdbObjectStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  error: unknown;
}
interface IdbDatabase {
  name: string;
  version: number;
  objectStoreNames: Iterable<string>;
  transaction(store: string, mode: 'readonly' | 'readwrite'): IdbTransaction;
  createObjectStore(
    name: string,
    opts: { keyPath?: string | string[]; autoIncrement?: boolean },
  ): IdbObjectStore;
  close(): void;
}
interface IdbFactory {
  open(name: string, version?: number): IdbOpenRequest;
  deleteDatabase(name: string): IdbRequest<unknown>;
  databases(): Promise<{ name?: string }[]>;
}
const indexedDB = () => (globalThis as unknown as { indexedDB: IdbFactory }).indexedDB;

const storeName = (integrationId: string) => `ordo-matrix-${integrationId}`;

interface DumpedStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  records: [IdbKey, unknown][];
}
interface DumpedDb {
  name: string;
  version: number;
  stores: DumpedStore[];
}

const done = <T>(req: IdbRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function openDb(name: string, version?: number, upgrade?: (db: IdbDatabase) => void) {
  const req = indexedDB().open(name, version);
  if (upgrade) req.onupgradeneeded = () => upgrade(req.result);
  return done(req);
}

async function databasesOf(integrationId: string) {
  const prefix = storeName(integrationId);
  return (await indexedDB().databases()).filter((d) => d.name?.startsWith(prefix));
}

/** Every database of an integration's store, with its schema and records. */
async function dump(integrationId: string): Promise<DumpedDb[]> {
  const out: DumpedDb[] = [];
  for (const info of await databasesOf(integrationId)) {
    const db = await openDb(info.name!);
    const stores: DumpedStore[] = [];
    for (const name of db.objectStoreNames) {
      const store = db.transaction(name, 'readonly').objectStore(name);
      const records: [IdbKey, unknown][] = [];
      await new Promise<void>((resolve, reject) => {
        const cursor = store.openCursor();
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return resolve();
          records.push([c.primaryKey, c.value]);
          c.continue();
        };
      });
      stores.push({
        name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((n) => {
          const index = store.index(n);
          return {
            name: n,
            keyPath: index.keyPath,
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        }),
        records,
      });
    }
    out.push({ name: db.name, version: db.version, stores });
    db.close();
  }
  return out;
}

/** Replaces an integration's databases with a snapshot (or with nothing, for a new device). */
async function restore(integrationId: string, dbs: DumpedDb[]) {
  for (const info of await databasesOf(integrationId))
    await done(indexedDB().deleteDatabase(info.name!));
  for (const saved of dbs) {
    const db = await openDb(saved.name, saved.version, (fresh) => {
      for (const s of saved.stores) {
        const store = fresh.createObjectStore(s.name, {
          keyPath: s.keyPath ?? undefined,
          autoIncrement: s.autoIncrement,
        });
        for (const i of s.indexes)
          store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    });
    for (const s of saved.stores) {
      if (!s.records.length) continue;
      const tx = db.transaction(s.name, 'readwrite');
      const store = tx.objectStore(s.name);
      for (const [key, value] of s.records) store.put(value, s.keyPath === null ? key : undefined);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    db.close();
  }
}

// ─── one machine per integration ──────────────────────────────────────────

interface Loaded {
  machine: Sdk.OlmMachine;
  version: number;
  hash: string;
}
const loaded = new Map<string, Loaded>();
const queues = new Map<string, Promise<unknown>>();

/** Forgets in-memory machines (one integration's, or all, as a restart would). */
export function forgetMatrixCrypto(integrationId?: string) {
  for (const [id, l] of loaded) {
    if (integrationId && id !== integrationId) continue;
    l.machine.close();
    loaded.delete(id);
  }
}

async function acquire(app: FastifyInstance, key: string) {
  for (let i = 0; ; i++) {
    if ((await app.leases.acquire(key, 120)) !== null) return;
    if (i > 300) throw new Error('Matrix encryption is busy on another server');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Runs `fn` with the integration's crypto machine, then sends whatever the machine wants sent
 * (keys, to-device messages) and saves the store if it changed.
 */
export function withMatrixCrypto<T>(
  ictx: IntegrationContext,
  call: Call,
  fn: (session: CryptoSession) => Promise<T>,
): Promise<T> {
  const id = ictx.integration.id;
  const run = (queues.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(() => locked(ictx, call, fn));
  queues.set(
    id,
    run.catch(() => {}),
  );
  return run;
}

async function locked<T>(
  ictx: IntegrationContext,
  call: Call,
  fn: (session: CryptoSession) => Promise<T>,
): Promise<T> {
  const { app, integration } = ictx;
  const lib = await load();
  const key = `matrix-crypto:${integration.id}`;
  await acquire(app, key);
  try {
    const [row] = await app.db
      .select()
      .from(matrixCryptoStores)
      .where(eq(matrixCryptoStores.integrationId, integration.id));
    let current = loaded.get(integration.id);
    if (!current || current.version !== (row?.version ?? 0)) {
      current?.machine.close();
      loaded.delete(integration.id);
      const snapshot = row
        ? (deserialize(
            Buffer.from(
              app.keyring.decrypt(row.data, matrixCryptoStoreAad(integration.id)),
              'base64',
            ),
          ) as DumpedDb[])
        : [];
      await restore(integration.id, snapshot);
      const { userId, deviceId } = integration.state as { userId?: string; deviceId?: string };
      if (!userId || !deviceId)
        throw new Error('The access token has no device; log the bot in to get one');
      const machine = await lib.OlmMachine.initialize(
        new lib.UserId(userId),
        new lib.DeviceId(deviceId),
        storeName(integration.id),
      );
      current = { machine, version: row?.version ?? 0, hash: '' };
      loaded.set(integration.id, current);
    }
    const session = new CryptoSession(lib, current.machine, call);
    const result = await fn(session);
    await session.flush();

    const bytes = serialize(await dump(integration.id));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== current.hash) {
      const data = app.keyring.encrypt(
        bytes.toString('base64'),
        matrixCryptoStoreAad(integration.id),
      );
      await app.db
        .insert(matrixCryptoStores)
        .values({ integrationId: integration.id, version: current.version + 1, data })
        .onConflictDoUpdate({
          target: matrixCryptoStores.integrationId,
          set: { version: current.version + 1, data, updatedAt: new Date().toISOString() },
        });
      current.version += 1;
      current.hash = hash;
    }
    return result;
  } catch (err) {
    // Start the next operation from the last saved state, not a half-finished one.
    loaded.get(integration.id)?.machine.close();
    loaded.delete(integration.id);
    throw err;
  } finally {
    await app.leases.release(key);
  }
}

// ─── what the bot does with it ────────────────────────────────────────────

export class CryptoSession {
  constructor(
    private lib: typeof Sdk,
    private machine: Sdk.OlmMachine,
    private call: Call,
  ) {}

  /** Sends what the machine has queued (key uploads and queries, to-device messages). */
  async flush() {
    for (let round = 0; round < 10; round++) {
      const requests = await this.machine.outgoingRequests();
      if (!requests.length) return;
      for (const r of requests) {
        const response = await this.send(r);
        if (response !== undefined)
          await this.machine.markRequestAsSent(
            r.id!,
            r.type as Sdk.RequestType,
            JSON.stringify(response),
          );
      }
    }
  }

  private async send(r: Sdk.OutgoingRequest): Promise<unknown> {
    const { RequestType } = this.lib;
    const body = JSON.parse(r.body);
    switch (r.type) {
      case RequestType.KeysUpload:
        return this.call('/keys/upload', { method: 'POST', body }).catch((err: Error) => {
          // The token's device already has keys from another client (say, Element).
          throw new Error(
            `Couldn't upload this device's encryption keys (${err.message}). Give the bot an access token from a fresh login, not one from a client that already set up encryption.`,
          );
        });
      case RequestType.KeysQuery:
        return this.call('/keys/query', { method: 'POST', body });
      case RequestType.KeysClaim:
        return this.call('/keys/claim', { method: 'POST', body });
      case RequestType.SignatureUpload:
        return this.call('/keys/signatures/upload', { method: 'POST', body });
      case RequestType.ToDevice: {
        const t = r as Sdk.ToDeviceRequest;
        return this.call(
          `/sendToDevice/${encodeURIComponent(t.event_type)}/${encodeURIComponent(t.txn_id)}`,
          { method: 'PUT', body },
        );
      }
      case RequestType.RoomMessage: {
        const m = r as Sdk.RoomMessageRequest;
        return this.call(
          `/rooms/${encodeURIComponent(m.room_id)}/send/${encodeURIComponent(m.event_type)}/${encodeURIComponent(m.txn_id)}`,
          { method: 'PUT', body },
        );
      }
      default:
        // Key backups aren't used: the store itself is kept.
        return undefined;
    }
  }

  /** Hands the machine a sync response's to-device messages, device changes and key counts. */
  async receiveSync(sync: CryptoSync) {
    const { lib } = this;
    const lists = new lib.DeviceLists(
      (sync.device_lists?.changed ?? []).map((u) => new lib.UserId(u)),
      (sync.device_lists?.left ?? []).map((u) => new lib.UserId(u)),
    );
    await this.machine.receiveSyncChanges(
      JSON.stringify(sync.to_device?.events ?? []),
      lists,
      new Map(Object.entries(sync.device_one_time_keys_count ?? {})),
      new Set(sync.device_unused_fallback_key_types ?? []),
    );
  }

  /** The plaintext event inside an `m.room.encrypted` one; null when it can't be decrypted. */
  async decrypt(room: string, event: MatrixEventJson): Promise<MatrixEventJson | null> {
    const { lib } = this;
    try {
      const decrypted = await this.machine.decryptRoomEvent(
        JSON.stringify({ ...event, room_id: room }),
        new lib.RoomId(room),
        // A bot reads everyone in its rooms; verification is for people.
        new lib.DecryptionSettings(lib.TrustRequirement.Untrusted),
      );
      const plain = JSON.parse(decrypted.event) as MatrixEventJson;
      // Relations (threads, replies) stay outside the encryption.
      const relates = event.content['m.relates_to'];
      if (relates && !plain.content['m.relates_to'])
        plain.content = { ...plain.content, 'm.relates_to': relates };
      return { ...plain, event_id: event.event_id, sender: event.sender };
    } catch {
      return null;
    }
  }

  /** Encrypts a message for everyone in the room, sharing the room key with their devices first. */
  async encrypt(room: string, members: string[], type: string, content: Record<string, unknown>) {
    const { lib } = this;
    const users = () => members.map((m) => new lib.UserId(m));
    await this.machine.updateTrackedUsers(users());
    await this.flush();
    const claim = await this.machine.getMissingSessions(users());
    if (claim) {
      const response = await this.send(claim);
      await this.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(response));
    }
    for (const request of await this.machine.shareRoomKey(
      new lib.RoomId(room),
      users(),
      new lib.EncryptionSettings(),
    )) {
      const response = await this.send(request);
      await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
    }
    return JSON.parse(
      await this.machine.encryptRoomEvent(new lib.RoomId(room), type, JSON.stringify(content)),
    ) as Record<string, unknown>;
  }
}

export const newTxnId = () => randomUUID();
