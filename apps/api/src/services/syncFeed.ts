import type { SyncChanges } from '@ordo/shared';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { syncChanges, syncCursors } from '../db/schema.ts';
import { HttpError } from '../lib/errors.ts';
import type { Access } from './access.ts';
import { commentsByIds } from './comments.ts';
import { issuesByIds } from './issues.ts';

/** Reading the change log (sync.ts writes it): where a workspace is, and what changed since. */

/** The workspace's place in its log (a workspace that never changed is at 0, epoch 1). */
export async function syncCursor(db: DbOrTx, workspaceId: string) {
  const [row] = await db.select().from(syncCursors).where(eq(syncCursors.workspaceId, workspaceId));
  return row ?? { workspaceId, seq: 0, epoch: 1, minSeq: 0 };
}

/** Kinds sync clients keep themselves; the rest live in the bootstrap or in other caches. */
const BOOTSTRAP_KINDS = new Set([
  'team',
  'state',
  'member',
  'workspace',
  'label',
  'template',
  'project',
  'projectUpdate',
  'cycle',
  'initiative',
  'customer',
  'view',
  'favorite',
]);

/**
 * What changed after `since`, as `access` may see it. A change is the reader's to see when it's
 * theirs or about teams they can read (or the whole workspace); issues and comments are loaded as
 * they are now, and anything that can't be loaded any more counts as deleted. Throws `resync`
 * when the client is in another epoch or further behind than the log goes.
 */
export async function changesSince(
  db: DbOrTx,
  access: Access,
  q: { since: number; epoch: number; limit: number },
): Promise<SyncChanges> {
  const cursor = await syncCursor(db, access.workspaceId);
  if (q.epoch !== cursor.epoch || q.since < cursor.minSeq || q.since > cursor.seq)
    throw new HttpError(410, 'Load the workspace again', 'resync').as('resync');
  const rows = await db
    .select()
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, access.workspaceId), gt(syncChanges.seq, q.since)))
    .orderBy(asc(syncChanges.seq))
    .limit(q.limit);
  const readable = new Set(access.teamIds);
  const visible = rows.filter(
    (r) =>
      (!r.userId || r.userId === access.userId) &&
      (r.teamIds.length === 0 || access.system || r.teamIds.some((t) => readable.has(t))),
  );
  const ids = (kind: string) => [
    ...new Set(visible.filter((r) => r.kind === kind).map((r) => r.entityId)),
  ];
  const issueIds = ids('issue');
  const commentIds = ids('comment');
  const [issueRows, commentRows] = await Promise.all([
    issuesByIds(db, access, issueIds),
    commentsByIds(db, access, commentIds),
  ]);
  const foundIssues = new Set(issueRows.map((i) => i.id));
  const foundComments = new Set(commentRows.map((c) => c.id));
  const other = new Set(
    visible.filter((r) => r.kind !== 'issue' && r.kind !== 'comment').map((r) => r.kind),
  );
  return {
    // Everything read counts, seen or not: the next read starts after it.
    seq: rows.at(-1)?.seq ?? Math.max(q.since, cursor.seq),
    epoch: cursor.epoch,
    more: rows.length === q.limit,
    issues: issueRows,
    deletedIssueIds: issueIds.filter((id) => !foundIssues.has(id)),
    comments: commentRows,
    deletedCommentIds: commentIds.filter((id) => !foundComments.has(id)),
    bootstrapChanged: [...other].some((k) => BOOTSTRAP_KINDS.has(k)),
    kinds: [...other].filter((k) => !BOOTSTRAP_KINDS.has(k)),
  };
}
