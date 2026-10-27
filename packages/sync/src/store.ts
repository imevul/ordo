import type { Bootstrap, Comment, Issue } from '@ordo/shared';
import type { PendingOp } from './outbox.ts';

/**
 * Where a sync client keeps its copy: IndexedDB in browsers (`IdbStore`, idb.ts), memory where
 * that isn't available or allowed (`MemoryStore`). One store per person and workspace.
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
  /** Changes waiting to be sent, oldest first; they survive full loads and new epochs. */
  outbox(): Promise<PendingOp[]>;
  enqueue(op: Omit<PendingOp, 'key'>): Promise<PendingOp>;
  updateOp(op: PendingOp): Promise<void>;
  removeOp(key: number): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export const DB_PREFIX = 'ordo:';
/** The database for one person's copy of one workspace. */
export const dbName = (userId: string, workspace: string) => `${DB_PREFIX}${userId}:${workspace}`;

export class MemoryStore implements SyncStore {
  private meta: Meta | null = null;
  private bootstrap: Bootstrap | null = null;
  private issues = new Map<string, Issue>();
  private comments = new Map<string, Comment>();
  private ops: PendingOp[] = [];
  private nextKey = 1;

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

  async outbox() {
    return [...this.ops];
  }

  async enqueue(op: Omit<PendingOp, 'key'>) {
    const entry = { ...op, key: this.nextKey++ };
    this.ops.push(entry);
    return entry;
  }

  async updateOp(op: PendingOp) {
    this.ops = this.ops.map((o) => (o.key === op.key ? op : o));
  }

  async removeOp(key: number) {
    this.ops = this.ops.filter((o) => o.key !== key);
  }

  async clear() {
    this.meta = null;
    this.bootstrap = null;
    this.issues.clear();
    this.comments.clear();
    this.ops = [];
  }

  close() {}
}
