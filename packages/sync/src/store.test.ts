import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { deleteLocalCopies, IdbStore } from './idb.ts';
import { dbName, MemoryStore, type SyncStore } from './store.ts';
import { comment, issue } from './testing.ts';

const meta = { workspaceId: 'ws', seq: 3, epoch: 1, savedAt: '2026-01-01T00:00:00.000Z' };
let n = 0;

describe.each([
  ['memory', async () => new MemoryStore() as SyncStore],
  ['indexeddb', async () => (await IdbStore.open(dbName('me', `store-${++n}`))) as SyncStore],
])('%s store', (_name, make) => {
  it('starts empty, then reads back what was written', async () => {
    const store = await make();
    expect(await store.read()).toEqual({ meta: null, bootstrap: null, issues: [] });
    await store.write({ meta, issues: [issue('a'), issue('b')], comments: [comment('1', 'a')] });
    await store.write({ deletedIssueIds: ['b'], issues: [issue('a', { title: 'x' })] });
    const read = await store.read();
    expect(read.meta).toEqual(meta);
    expect(read.issues.map((i) => i.title)).toEqual(['x']);
    expect(await store.commentsFor('a')).toHaveLength(1);
    expect(await store.commentsFor('b')).toEqual([]);
    store.close();
  });

  it('replaces everything in a full load', async () => {
    const store = await make();
    await store.write({ issues: [issue('a')], comments: [comment('1', 'a')] });
    await store.write({ replaceAll: true, issues: [issue('b')] });
    expect((await store.read()).issues.map((i) => i.id)).toEqual(['b']);
    expect(await store.commentsFor('a')).toEqual([]);
    await store.clear();
    expect(await store.read()).toEqual({ meta: null, bootstrap: null, issues: [] });
    store.close();
  });
});

describe('signing out', () => {
  it("deletes one person's copies, or all of them", async () => {
    for (const name of [dbName('ann', 'w1'), dbName('ann', 'w2'), dbName('bob', 'w1')]) {
      const store = await IdbStore.open(name);
      await store.write({ meta });
      store.close();
    }
    const names = async () =>
      (await indexedDB.databases())
        .map((d) => d.name)
        .filter((x) => x?.startsWith('ordo:ann') || x?.startsWith('ordo:bob'));
    await deleteLocalCopies('ann');
    expect(await names()).toEqual([dbName('bob', 'w1')]);
    await deleteLocalCopies();
    expect(await names()).toEqual([]);
  });
});
