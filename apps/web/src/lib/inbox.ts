import type { Notification } from '@ordo/shared';

/**
 * The inbox list with the notifications the reader opened put back where the server dropped them.
 * Under the unread filter, opening an item marks it read and the refetch leaves it out, which
 * would close it under the reader; `kept` holds those until the view changes. Fresh server rows
 * win; kept ones go back in the server's order: newest first, or soonest to wake when snoozed,
 * then by id, descending.
 */
export function withKept(
  list: Notification[],
  kept: Record<string, Notification>,
  snoozed: boolean,
): Notification[] {
  const shown = new Set(list.map((n) => n.id));
  const missing = Object.values(kept).filter((n) => !shown.has(n.id));
  if (!missing.length) return list;
  const key = (n: Notification) => (snoozed ? (n.snoozedUntil ?? '') : n.createdAt);
  const before = (a: Notification, b: Notification) =>
    key(a) === key(b) ? a.id > b.id : snoozed ? key(a) < key(b) : key(a) > key(b);
  const out = [...list];
  for (const n of missing) {
    const at = out.findIndex((m) => before(n, m));
    out.splice(at === -1 ? out.length : at, 0, n);
  }
  return out;
}
