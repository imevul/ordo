import type { PendingOp } from './outbox.ts';
import { MemoryStore, type StoreWrite, type SyncStore } from './store.ts';

const quota = (err: unknown) =>
  (err as { name?: string })?.name === 'QuotaExceededError' ||
  (err as { inner?: { name?: string } })?.inner?.name === 'QuotaExceededError';

/**
 * A store on disk until the disk is full; then memory, for the rest of the session, after
 * telling someone (`onFull`). Changes still go out; they just won't outlast the session.
 */
export class FallbackStore implements SyncStore {
  private memory: MemoryStore | null = null;
  private lastKey = 0;

  constructor(
    private disk: SyncStore,
    private onFull: () => void,
  ) {}

  private async run<T>(fn: (store: SyncStore) => Promise<T>): Promise<T> {
    if (this.memory) return fn(this.memory);
    try {
      return await fn(this.disk);
    } catch (err) {
      if (!quota(err)) throw err;
      // Keys carry on from the disk's, so queued changes keep telling each other apart.
      this.memory = new MemoryStore(this.lastKey + 1);
      this.onFull();
      return fn(this.memory);
    }
  }

  read() {
    return this.run((s) => s.read());
  }
  commentsFor(issueId: string) {
    return this.run((s) => s.commentsFor(issueId));
  }
  write(w: StoreWrite) {
    return this.run((s) => s.write(w));
  }
  async outbox() {
    const ops = await this.run((s) => s.outbox());
    for (const op of ops) this.lastKey = Math.max(this.lastKey, op.key);
    return ops;
  }
  async enqueue(op: Omit<PendingOp, 'key'>) {
    const entry = await this.run((s) => s.enqueue(op));
    this.lastKey = Math.max(this.lastKey, entry.key);
    return entry;
  }
  updateOp(op: PendingOp) {
    return this.run((s) => s.updateOp(op));
  }
  removeOp(key: number) {
    return this.run((s) => s.removeOp(key));
  }
  clear() {
    return this.run((s) => s.clear());
  }
  close() {
    this.disk.close();
  }
}
