import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { type Delta, Engine } from './engine.ts';
import { dbName, IdbStore, MemoryStore, type SyncStore } from './store.ts';
import { comment, FakeServer, issue } from './testing.ts';

const setup = (
  server = new FakeServer(),
  store: SyncStore = new MemoryStore(),
  pageLimit?: number,
) => {
  const deltas: Delta[] = [];
  const errors: unknown[] = [];
  const engine = new Engine({
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

  it('runs one sync at a time, and once more for calls made meanwhile', async () => {
    const { server, engine } = setup();
    await engine.sync();
    const before = server.calls.length;
    server.put(issue('a'));
    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    expect(server.calls.slice(before)).toHaveLength(2);
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
