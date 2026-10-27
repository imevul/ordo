import type { Bootstrap, Comment, Issue } from '@ordo/shared';
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb';
import type { PendingOp } from './outbox.ts';
import { DB_PREFIX, type Meta, type StoreWrite, type SyncStore } from './store.ts';

/** The browser's store: IndexedDB, one database per person and workspace (`dbName`). */

interface Schema extends DBSchema {
  meta: { key: string; value: Meta };
  bootstrap: { key: string; value: Bootstrap };
  issues: { key: string; value: Issue };
  comments: { key: string; value: Comment; indexes: { issueId: string } };
  /** Changes waiting to be sent (outbox.ts). */
  outbox: { key: number; value: PendingOp };
}

export class IdbStore implements SyncStore {
  private constructor(private db: IDBPDatabase<Schema>) {}

  static async open(name: string) {
    const db = await openDB<Schema>(name, 2, {
      upgrade(db, from) {
        if (from < 1) {
          db.createObjectStore('meta');
          db.createObjectStore('bootstrap');
          db.createObjectStore('issues', { keyPath: 'id' });
          db.createObjectStore('comments', { keyPath: 'id' }).createIndex('issueId', 'issueId');
        }
        // Version 1's outbox was never written to; it now keeps its key on each entry.
        if (db.objectStoreNames.contains('outbox')) db.deleteObjectStore('outbox');
        db.createObjectStore('outbox', { keyPath: 'key', autoIncrement: true });
      },
      // Another tab is upgrading (or deleting) the database: let it.
      blocking() {
        db.close();
      },
    });
    return new IdbStore(db);
  }

  async read() {
    const tx = this.db.transaction(['meta', 'bootstrap', 'issues']);
    const [meta, bootstrap, issues] = await Promise.all([
      tx.objectStore('meta').get('meta'),
      tx.objectStore('bootstrap').get('bootstrap'),
      tx.objectStore('issues').getAll(),
    ]);
    return { meta: meta ?? null, bootstrap: bootstrap ?? null, issues };
  }

  commentsFor(issueId: string) {
    return this.db.getAllFromIndex('comments', 'issueId', issueId);
  }

  async write(w: StoreWrite) {
    const tx = this.db.transaction(['meta', 'bootstrap', 'issues', 'comments'], 'readwrite');
    const issues = tx.objectStore('issues');
    const comments = tx.objectStore('comments');
    const ops: Promise<unknown>[] = [];
    if (w.replaceAll) ops.push(issues.clear(), comments.clear());
    for (const issue of w.issues ?? []) ops.push(issues.put(issue));
    for (const id of w.deletedIssueIds ?? []) ops.push(issues.delete(id));
    for (const c of w.comments ?? []) ops.push(comments.put(c));
    for (const id of w.deletedCommentIds ?? []) ops.push(comments.delete(id));
    if (w.bootstrap) ops.push(tx.objectStore('bootstrap').put(w.bootstrap, 'bootstrap'));
    if (w.meta) ops.push(tx.objectStore('meta').put(w.meta, 'meta'));
    await Promise.all([...ops, tx.done]);
  }

  async outbox() {
    return this.db.getAll('outbox');
  }

  async enqueue(op: Omit<PendingOp, 'key'>) {
    const key = await this.db.add('outbox', op as PendingOp);
    return { ...op, key } as PendingOp;
  }

  async updateOp(op: PendingOp) {
    await this.db.put('outbox', op);
  }

  async removeOp(key: number) {
    await this.db.delete('outbox', key);
  }

  async clear() {
    const tx = this.db.transaction(
      ['meta', 'bootstrap', 'issues', 'comments', 'outbox'],
      'readwrite',
    );
    await Promise.all([...tx.objectStoreNames].map((n) => tx.objectStore(n).clear()));
    await tx.done;
  }

  close() {
    this.db.close();
  }
}

/**
 * Deletes local copies: all of them (signing out), or one person's. IndexedDB is plain text on
 * disk, so nothing should outlive the session that needed it.
 */
export async function deleteLocalCopies(userId?: string) {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return;
  const prefix = userId ? `${DB_PREFIX}${userId}:` : DB_PREFIX;
  const all = await indexedDB.databases();
  await Promise.all(all.filter((d) => d.name?.startsWith(prefix)).map((d) => deleteDB(d.name!)));
}
