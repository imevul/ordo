import type { Notification } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import { withKept } from './inbox.ts';

const n = (id: string, createdAt: string, extra: Partial<Notification> = {}) =>
  ({ id, createdAt, readAt: null, snoozedUntil: null, ...extra }) as Notification;
const ids = (list: Notification[]) => list.map((x) => x.id);

describe('withKept', () => {
  const a = n('a', '2026-10-31T12:00:00Z');
  const b = n('b', '2026-10-31T11:00:00Z');
  const c = n('c', '2026-10-31T10:00:00Z');

  it('returns the list as is when nothing is missing', () => {
    const list = [a, b];
    expect(withKept(list, {}, false)).toBe(list);
    expect(withKept(list, { a: { ...a, readAt: 'x' } }, false)).toBe(list);
  });

  it('puts a dropped notification back in its place, newest first', () => {
    const readB = { ...b, readAt: '2026-10-31T13:00:00Z' };
    const out = withKept([a, c], { b: readB }, false);
    expect(ids(out)).toEqual(['a', 'b', 'c']);
    expect(out[1]).toBe(readB);
    expect(ids(withKept([b, c], { a }, false))).toEqual(['a', 'b', 'c']);
    expect(ids(withKept([a, b], { c }, false))).toEqual(['a', 'b', 'c']);
    expect(ids(withKept([], { c, a }, false))).toEqual(['a', 'c']);
  });

  it('breaks ties by id, descending, like the server', () => {
    const at = '2026-10-31T12:00:00Z';
    const [x, y, z] = [n('x', at), n('y', at), n('z', at)];
    expect(ids(withKept([z, x], { y }, false))).toEqual(['z', 'y', 'x']);
  });

  it('orders snoozed ones by when they wake', () => {
    const s1 = n('s1', '2026-10-31T09:00:00Z', { snoozedUntil: '2026-11-01T09:00:00Z' });
    const s2 = n('s2', '2026-10-31T12:00:00Z', { snoozedUntil: '2026-11-02T09:00:00Z' });
    const s3 = n('s3', '2026-10-31T10:00:00Z', { snoozedUntil: '2026-11-03T09:00:00Z' });
    expect(ids(withKept([s1, s3], { s2 }, true))).toEqual(['s1', 's2', 's3']);
  });
});
