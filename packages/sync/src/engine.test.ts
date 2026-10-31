import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { type Delta, Engine } from './engine.ts';
import { IdbStore } from './idb.ts';
import { type Locks, lead } from './leader.ts';
import { dbName, MemoryStore, type SyncStore } from './store.ts';
import { comment, FakeServer, issue } from './testing.ts';

const setup = (
  server = new FakeServer(),
  store: SyncStore = new MemoryStore(),
  pageLimit?: number,
) => {
  const deltas: Delta[] = [];
  const errors: unknown[] = [];
  const engine = new Engine({
    userId: 'me',
    transport: server.transport(pageLimit),
    store,
    pageSize: 2,
    onDelta: (d) => deltas.push(d),
    onError: (e) => errors.push(e),
  });
  return { server, store, engine, deltas, errors };
};
const ids = (engine: Engine) => [...engine.getState().issues.keys()].sort();

describe('engine', () => {
  it('loads everything the first time, a page at a time', async () => {
    const server = new FakeServer();
    for (const id of ['a', 'b', 'c', 'd', 'e']) server.put(issue(id));
    const { engine, store, errors } = setup(server);
    await engine.open();
    expect(engine.getState().ready).toBe(false);
    await engine.sync();
    expect(errors).toEqual([]);
    expect(engine.getState()).toMatchObject({ ready: true, online: true, syncing: false });
    expect(ids(engine)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(server.calls.filter((c) => c === 'issues')).toHaveLength(3);
    expect((await store.read()).meta).toMatchObject({ seq: 5, epoch: 1, workspaceId: 'ws-1' });
  });

  it('shows the saved copy at once, offline too', async () => {
    const server = new FakeServer();
    server.put(issue('a'));
    const store = new MemoryStore();
    await setup(server, store).engine.sync();

    server.offline = true;
    const { engine } = setup(server, store);
    await engine.open();
    expect(engine.getState().ready).toBe(true);
    expect(ids(engine)).toEqual(['a']);
    await engine.sync();
    expect(engine.getState().online).toBe(false);
    server.offline = false;
    await engine.sync();
    expect(engine.getState().online).toBe(true);
  });

  it('follows the change log: updates, deletions, comments', async () => {
    const { server, engine } = setup();
    server.put(issue('a'));
    server.put(issue('b'));
    await engine.sync();
    await engine.commentsFor('a');

    server.put(issue('a', { title: 'Renamed' }));
    server.remove('b');
    server.put(issue('c'));
    server.putComment(comment('c1', 'a'));
    engine.notify({ seq: server.seq, epoch: 1 });
    await engine.sync();
    expect(ids(engine)).toEqual(['a', 'c']);
    expect(engine.issue('a')!.title).toBe('Renamed');
    expect(engine.issue('T-c')!.id).toBe('c');
    expect((await engine.commentsFor('a')).map((c) => c.id)).toEqual(['c1']);
    expect(engine.cursor).toEqual({ seq: server.seq, epoch: 1 });
  });

  it('pages through a long log', async () => {
    const server = new FakeServer();
    const { engine } = setup(server, new MemoryStore(), 2);
    await engine.sync();
    const before = server.calls.length;
    for (const id of ['a', 'b', 'c', 'd', 'e']) server.put(issue(id));
    await engine.sync();
    expect(ids(engine)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(server.calls.slice(before)).toEqual(['changes:0', 'changes:2', 'changes:4']);
  });

  it('drops issues of teams that went out of sight', async () => {
    const { server, engine } = setup();
    server.put(issue('a', { teamId: 'team-1' }));
    server.put(issue('b', { teamId: 'team-2' }));
    await engine.sync();
    server.changeTeams(['team-1']);
    await engine.sync();
    expect(ids(engine)).toEqual(['a']);
    expect(engine.getState().bootstrap!.teams).toHaveLength(1);
  });

  it('loads the existing issues of a team that came into sight', async () => {
    const server = new FakeServer();
    server.teams = ['team-1'];
    server.put(issue('a', { teamId: 'team-1' }));
    server.put(issue('b', { teamId: 'team-2' }));
    const { engine, store, errors } = setup(server);
    await engine.sync();
    expect(ids(engine)).toEqual(['a']);

    // Nothing in the log touches b: only a full load finds it.
    server.changeTeams(['team-1', 'team-2']);
    server.put(issue('c', { teamId: 'team-2' }));
    await engine.sync();
    expect(errors).toEqual([]);
    expect(ids(engine)).toEqual(['a', 'b', 'c']);
    expect(engine.getState().bootstrap!.teams).toHaveLength(2);
    expect(engine.cursor).toEqual({ seq: server.seq, epoch: 1 });
    expect((await store.read()).issues.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('follows the log when the teams in sight stay the same', async () => {
    const { server, engine } = setup();
    server.put(issue('a'));
    await engine.sync();
    const loads = server.calls.filter((c) => c === 'issues').length;
    server.changeTeams(['team-1', 'team-2']);
    await engine.sync();
    expect(server.calls.filter((c) => c === 'issues')).toHaveLength(loads);
    expect(ids(engine)).toEqual(['a']);
  });

  it('starts over when the server starts a new epoch', async () => {
    const { server, engine } = setup();
    server.put(issue('a'));
    await engine.sync();
    server.issues.clear();
    server.put(issue('z'));
    server.newEpoch();
    engine.notify({ epoch: server.epoch });
    await engine.sync();
    expect(ids(engine)).toEqual(['z']);
    expect(engine.cursor!.epoch).toBe(2);
  });

  it('runs one sync at a time; calls made before it reads share its round', async () => {
    const { server, engine } = setup();
    await engine.sync();
    const before = server.calls.length;
    server.put(issue('a'));
    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    expect(server.calls.slice(before)).toHaveLength(1);
    expect(ids(engine)).toEqual(['a']);
  });

  it('shares what it saves with other tabs, which only apply it', async () => {
    const leader = setup();
    const follower = setup(leader.server, leader.store);
    follower.engine.leader = false;
    await follower.engine.open();
    leader.server.put(issue('a'));
    await leader.engine.sync();
    for (const d of leader.deltas) follower.engine.receive(d);
    await new Promise((r) => setTimeout(r, 0));
    expect(ids(follower.engine)).toEqual(['a']);
    leader.server.put(issue('b'));
    await leader.engine.sync();
    for (const d of leader.deltas.slice(-1)) follower.engine.receive(d);
    expect(ids(follower.engine)).toEqual(['a', 'b']);
    await follower.engine.sync();
    expect(leader.server.calls.filter((c) => c === 'snapshot')).toHaveLength(1);
  });

  it('keeps fetched comments for later, replacing what was kept', async () => {
    const { engine } = setup();
    await engine.saveComments('a', [comment('1', 'a'), comment('22', 'a')]);
    await engine.saveComments('a', [comment('22', 'a', 'edited')]);
    expect((await engine.commentsFor('a')).map((c) => c.body)).toEqual(['edited']);
  });

  it('keeps its copy in IndexedDB between visits', async () => {
    const server = new FakeServer();
    server.put(issue('a'));
    const name = dbName('me', `engine-${Date.now()}`);
    const first = setup(server, await IdbStore.open(name));
    await first.engine.sync();
    first.engine.close();
    const again = setup(server, await IdbStore.open(name));
    await again.engine.open();
    expect(ids(again.engine)).toEqual(['a']);
    again.engine.close();
  });
});

describe('outbox', () => {
  const ready = async () => {
    const t = setup();
    t.server.put(issue('a'));
    await t.engine.sync();
    return t;
  };

  it('shows a change at once and sends it', async () => {
    const { server, engine } = await ready();
    const sent = engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { title: 'Now' } });
    expect(engine.issue('a')!.title).toBe('Now');
    expect(engine.getState().waiting).toBe(1);
    expect(await sent).toMatchObject({ id: 'a', title: 'Now' });
    expect(engine.getState().waiting).toBe(0);
    expect(server.issues.get('a')!.title).toBe('Now');
  });

  it('keeps changes made offline, in order, and sends them when back', async () => {
    const { server, engine, store } = await ready();
    server.offline = true;
    expect(
      await engine.mutate({
        kind: 'issue.create',
        issue: { id: 'n1', teamId: 'team-1', title: 'Offline' },
      }),
    ).toBeUndefined();
    await engine.mutate({ kind: 'issue.update', ids: ['n1'], patch: { priority: 1 } });
    await engine.mutate({
      kind: 'comment.create',
      comment: { id: 'c1', issueId: 'n1', body: 'note', parentId: null },
    });
    expect(engine.getState()).toMatchObject({ online: false, waiting: 3 });
    expect(engine.issue('n1')).toMatchObject({
      title: 'Offline',
      priority: 1,
      identifier: 'TEAM-1-…',
    });
    expect((await engine.commentsFor('n1')).map((c) => c.body)).toEqual(['note']);
    expect(await store.outbox()).toHaveLength(3);

    server.offline = false;
    await engine.sync();
    expect(server.sent.map((o) => o.kind)).toEqual([
      'issue.create',
      'issue.update',
      'comment.create',
    ]);
    expect(engine.getState().waiting).toBe(0);
    expect(engine.issue('n1')!.number).toBeGreaterThan(0);
    expect(await store.outbox()).toEqual([]);
  });

  it('rebases incoming changes under what is waiting', async () => {
    const { server, engine } = await ready();
    server.offline = true;
    await engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { priority: 3 } });
    // Someone else renames it meanwhile; the change arrives before this one is sent.
    server.put(issue('a', { title: 'Renamed elsewhere' }));
    server.offline = false;
    const changes = await server.transport().changes(engine.cursor!.seq, 1);
    engine.receive({ issues: changes.issues });
    expect(engine.issue('a')).toMatchObject({ title: 'Renamed elsewhere', priority: 3 });
  });

  it("shows what's waiting on top of an issue's page fetched from the server", async () => {
    const { server, engine } = await ready();
    server.offline = true;
    await engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { priority: 2 } });
    // A refetch that lands before the change is sent still shows it.
    const page = { ...server.issues.get('a')!, subIssues: [] };
    expect(engine.overlayIssue(page)).toMatchObject({ id: 'a', priority: 2, subIssues: [] });
    await engine.mutate({ kind: 'issue.trash', ids: ['a'] });
    expect(engine.overlayIssue(page).deletedAt).not.toBeNull();
    await engine.mutate({ kind: 'issue.restore', ids: ['a'] });
    expect(engine.overlayIssue(page).deletedAt).toBeNull();
    const other = issue('b');
    expect(engine.overlayIssue(other)).toBe(other);
  });

  it('undoes a trash made offline: the restore is sent after it', async () => {
    const { server, engine } = await ready();
    server.offline = true;
    await engine.mutate({ kind: 'issue.trash', ids: ['a'] });
    expect(engine.issue('a')).toBeUndefined();
    await engine.mutate({ kind: 'issue.restore', ids: ['a'] });
    expect(engine.issue('a')).toMatchObject({ id: 'a', deletedAt: null });

    server.offline = false;
    await engine.sync();
    expect(server.sent.map((o) => o.kind)).toEqual(['issue.trash', 'issue.restore']);
    expect(server.issues.has('a')).toBe(true);
    expect(engine.issue('a')).toBeDefined();
  });

  it('moves issues to another team, showing it before the server renumbers them', async () => {
    const { server, engine } = await ready();
    server.offline = true;
    expect(await engine.mutate({ kind: 'issue.move', ids: ['a'], teamId: 'team-2' })).toBe(
      undefined,
    );
    expect(engine.issue('a')).toMatchObject({ teamId: 'team-2', identifier: 'T-a' });
    server.offline = false;
    await engine.sync();
    expect(engine.issue('a')).toMatchObject({ teamId: 'team-2', identifier: 'TEAM-2-2' });
  });

  it('drops a refused change, and what depends on it, and keeps them to show', async () => {
    const { server, engine } = await ready();
    server.refuse = (op) => op.kind === 'issue.create';
    server.offline = true;
    await engine.mutate({
      kind: 'issue.create',
      issue: { id: 'bad', teamId: 'team-1', title: 'Nope' },
    });
    await engine.mutate({
      kind: 'comment.create',
      comment: { id: 'c9', issueId: 'bad', body: 'my long text', parentId: null },
    });
    await engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { title: 'Fine' } });
    server.offline = false;
    await engine.sync();
    const { failed, waiting } = engine.getState();
    expect(waiting).toBe(0);
    expect(failed.map((f) => f.op.kind)).toEqual(['issue.create', 'comment.create']);
    expect(failed[1]!.op).toMatchObject({ comment: { body: 'my long text' } });
    expect(engine.issue('bad')).toBeUndefined();
    expect(server.issues.get('a')!.title).toBe('Fine');
    await engine.dismiss(failed[0]!.key);
    expect(engine.getState().failed).toHaveLength(1);
  });

  it('rejects the change someone waits on when the server refuses it', async () => {
    const { server, engine } = await ready();
    server.refuse = () => true;
    await expect(engine.mutate({ kind: 'issue.trash', ids: ['a'] })).rejects.toThrow('refused');
    expect(engine.issue('a')).toBeDefined();
  });

  it('tries again after server errors, and stops while signed out', async () => {
    vi.useFakeTimers();
    try {
      const { server, engine } = await ready();
      server.flaky = 1;
      const sent = engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { priority: 2 } });
      expect(await sent).toBeUndefined();
      expect(engine.getState().waiting).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.getState().waiting).toBe(0);

      server.signedOut = true;
      await engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { priority: 3 } });
      expect(engine.getState()).toMatchObject({ signedOut: true, waiting: 1 });
      server.signedOut = false;
      await engine.sync();
      expect(engine.getState()).toMatchObject({ signedOut: false, waiting: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets one tab send what another queued', async () => {
    const leader = await ready();
    const follower = setup(leader.server, leader.store);
    follower.engine.leader = false;
    await follower.engine.open();
    expect(
      await follower.engine.mutate({
        kind: 'issue.update',
        ids: ['a'],
        patch: { title: 'From B' },
      }),
    ).toBeUndefined();
    expect(follower.engine.issue('a')!.title).toBe('From B');
    expect(leader.server.sent).toEqual([]);
    for (const d of follower.deltas) leader.engine.receive(d);
    await vi.waitFor(() => expect(leader.server.sent).toHaveLength(1));
    expect(leader.server.issues.get('a')!.title).toBe('From B');
  });

  it("takes a change it couldn't save off the screen, and sends the next ones", async () => {
    const store = new MemoryStore();
    const { server, engine } = setup(new FakeServer(), store);
    server.put(issue('a'));
    await engine.sync();
    const enqueue = store.enqueue.bind(store);
    store.enqueue = async () => {
      throw new Error('disk gone');
    };
    await expect(
      engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { title: 'Lost' } }),
    ).rejects.toThrow('disk gone');
    expect(engine.issue('a')!.title).toBe('Issue a');
    expect(engine.getState().waiting).toBe(0);

    store.enqueue = enqueue;
    expect(
      await engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { priority: 2 } }),
    ).toMatchObject({ priority: 2 });
    expect(server.sent).toHaveLength(1);
  });

  it("keeps its unsaved changes when another tab's outbox news arrives first", async () => {
    const store = new MemoryStore();
    const { server, engine } = setup(new FakeServer(), store);
    server.put(issue('a'));
    await engine.sync();
    // Another tab queues a change; this tab's own is still being saved when it hears of it.
    const other = setup(server, store);
    other.engine.leader = false;
    await other.engine.open();
    let saved!: () => void;
    const enqueue = store.enqueue.bind(store);
    store.enqueue = async (op) => {
      await new Promise<void>((r) => {
        saved = r;
      });
      return enqueue(op);
    };
    const mine = engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { title: 'Mine' } });
    store.enqueue = enqueue;
    await other.engine.mutate({ kind: 'issue.update', ids: ['a'], patch: { priority: 4 } });
    for (const d of other.deltas) engine.receive(d);
    await vi.waitFor(() => expect(server.sent).toHaveLength(1));
    expect(engine.issue('a')).toMatchObject({ title: 'Mine', priority: 4 });

    saved();
    expect(await mine).toMatchObject({ title: 'Mine', priority: 4 });
    expect(server.sent.map((o) => o.kind === 'issue.update' && o.patch)).toEqual([
      { priority: 4 },
      { title: 'Mine' },
    ]);
    expect(engine.getState().waiting).toBe(0);
    expect(await store.outbox()).toEqual([]);
  });
});

describe('leading', () => {
  /** Web Locks, roughly: one holder per name, the rest in line. */
  class FakeLocks implements Locks {
    private held = new Map<string, Promise<unknown>>();
    request(name: string, { signal }: { signal: AbortSignal }, fn: () => Promise<void> | void) {
      const before = this.held.get(name) ?? Promise.resolve();
      const mine = before.then(() => {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        return fn();
      });
      this.held.set(
        name,
        mine.catch(() => {}),
      );
      return mine;
    }
  }

  it('lets go of the lock when another tab upgrades the database', async () => {
    const server = new FakeServer();
    server.put(issue('a'));
    const name = dbName('me', `upgrade-${Date.now()}`);
    const locks = new FakeLocks();
    let release = () => {};
    const old = setup(
      server,
      await IdbStore.open(name, () => {
        release();
        old.engine.close();
      }),
    );
    await old.engine.open();
    release = lead(old.engine, locks, 'leader');
    await vi.waitFor(() => expect(old.engine.getState().ready).toBe(true));
    expect(old.engine.leader).toBe(true);

    // A newer version of the app opens the same database: the old tab steps aside.
    const upgraded = await openDB(name, 99);
    expect(old.engine.leader).toBe(false);
    upgraded.close();

    const next = setup(server, new MemoryStore());
    lead(next.engine, locks, 'leader');
    await vi.waitFor(() => expect(next.engine.leader).toBe(true));
    await vi.waitFor(() => expect(ids(next.engine)).toEqual(['a']));
  });
});
