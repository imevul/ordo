import type { Bootstrap, Comment, Issue } from '@ordo/shared';
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb';

/**
 * Where a sync client keeps its copy: IndexedDB in browsers (`IdbStore`), memory where that isn't
 * available or allowed (`MemoryStore`). One store per person and workspace.
 */

export interface Meta {
  workspaceId: string;
  seq: number;
  epoch: number;
  savedAt: string;
}

/** Everything one sync step changes, written in one transaction. */
export interface StoreWrite {
  meta?: Meta;
  bootstrap?: Bootstrap;
  /** Replaces every issue and comment (a full load); otherwise they're upserted. */
  replaceAll?: boolean;
  issues?: Issue[];
  deletedIssueIds?: string[];
  comments?: Comment[];
  deletedCommentIds?: string[];
}

export interface SyncStore {
  read(): Promise<{ meta: Meta | null; bootstrap: Bootstrap | null; issues: Issue[] }>;
  commentsFor(issueId: string): Promise<Comment[]>;
  write(w: StoreWrite): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export const DB_PREFIX = 'ordo:';
/** The database for one person's copy of one workspace. */
export const dbName = (userId: string, workspace: string) => `${DB_PREFIX}${userId}:${workspace}`;

interface Schema extends DBSchema {
  meta: { key: string; value: Meta };
  bootstrap: { key: string; value: Bootstrap };
  issues: { key: string; value: Issue };
  comments: { key: string; value: Comment; indexes: { issueId: string } };
  /** Offline changes waiting to be sent (see the outbox). */
  outbox: { key: number; value: unknown };
}

export class IdbStore implements SyncStore {
  private constructor(private db: IDBPDatabase<Schema>) {}

  static async open(name: string) {
    const db = await openDB<Schema>(name, 1, {
      upgrade(db) {
        db.createObjectStore('meta');
        db.createObjectStore('bootstrap');
        db.createObjectStore('issues', { keyPath: 'id' });
        db.createObjectStore('comments', { keyPath: 'id' }).createIndex('issueId', 'issueId');
        db.createObjectStore('outbox', { autoIncrement: true });
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

export class MemoryStore implements SyncStore {
  private meta: Meta | null = null;
  private bootstrap: Bootstrap | null = null;
  private issues = new Map<string, Issue>();
  private comments = new Map<string, Comment>();

  async read() {
    return { meta: this.meta, bootstrap: this.bootstrap, issues: [...this.issues.values()] };
  }

  async commentsFor(issueId: string) {
    return [...this.comments.values()].filter((c) => c.issueId === issueId);
  }

  async write(w: StoreWrite) {
    if (w.replaceAll) {
      this.issues.clear();
      this.comments.clear();
    }
    for (const issue of w.issues ?? []) this.issues.set(issue.id, issue);
    for (const id of w.deletedIssueIds ?? []) this.issues.delete(id);
    for (const c of w.comments ?? []) this.comments.set(c.id, c);
    for (const id of w.deletedCommentIds ?? []) this.comments.delete(id);
    if (w.bootstrap) this.bootstrap = w.bootstrap;
    if (w.meta) this.meta = w.meta;
  }

  async clear() {
    this.meta = null;
    this.bootstrap = null;
    this.issues.clear();
    this.comments.clear();
  }

  close() {}
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
