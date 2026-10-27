import { describe, expect, it } from 'vitest';
import { FallbackStore } from './fallback.ts';
import { MemoryStore } from './store.ts';
import { issue } from './testing.ts';

/** A disk that fills up after `room` writes. */
class SmallDisk extends MemoryStore {
  constructor(private room: number) {
    super();
  }
  override async write(w: Parameters<MemoryStore['write']>[0]) {
    if (this.room-- <= 0) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    return super.write(w);
  }
  override async enqueue(op: Parameters<MemoryStore['enqueue']>[0]) {
    if (this.room-- <= 0) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    return super.enqueue(op);
  }
}

const op = {
  op: { kind: 'issue.trash' as const, ids: ['a'] },
  userId: 'me',
  queuedAt: '',
  attempts: 0,
  error: null,
};

describe('FallbackStore', () => {
  it('moves to memory when the disk is full, says so once, and keeps keys apart', async () => {
    let told = 0;
    const store = new FallbackStore(new SmallDisk(2), () => told++);
    await store.write({ issues: [issue('a')] });
    const first = await store.enqueue(op);
    expect(told).toBe(0);
    const second = await store.enqueue(op);
    await store.write({ issues: [issue('b')] });
    expect(told).toBe(1);
    expect(second.key).toBeGreaterThan(first.key);
    expect((await store.read()).issues.map((i) => i.id)).toEqual(['b']);
  });

  it('passes other errors on', async () => {
    const disk = new MemoryStore();
    disk.write = async () => {
      throw new Error('broken');
    };
    const store = new FallbackStore(disk, () => {});
    await expect(store.write({})).rejects.toThrow('broken');
  });
});
