import type { UserPreferences } from '@ordo/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  instanceKeys,
  issues,
  notifications,
  pushSubscriptions,
  teams,
  users,
  workflowStates,
  workspaces,
} from '../db/schema.ts';
import { localeOf } from '../i18n/index.ts';
import { enqueue } from '../lib/jobs/index.ts';
import { safeFetch } from '../lib/safeFetch.ts';
import {
  encryptPayload,
  generateVapidKeys,
  type VapidKeys,
  vapidAuthorization,
} from '../lib/webpush.ts';
import { describeNotification } from './digest.ts';

let cached: VapidKeys | null = null;

/** The instance's VAPID key pair, made (and stored encrypted) the first time it's needed. */
export async function vapidKeys(app: FastifyInstance): Promise<VapidKeys> {
  if (cached) return cached;
  const aad = 'instance_keys:vapid:value';
  const read = async () => {
    const [row] = await app.db.select().from(instanceKeys).where(eq(instanceKeys.key, 'vapid'));
    return row ? (JSON.parse(app.keyring.decrypt(row.value, aad)) as VapidKeys) : null;
  };
  let keys = await read();
  if (!keys) {
    const fresh = generateVapidKeys();
    // Two servers racing: the first insert wins and both read it back.
    await app.db
      .insert(instanceKeys)
      .values({ key: 'vapid', value: app.keyring.encrypt(JSON.stringify(fresh), aad) })
      .onConflictDoNothing();
    keys = (await read())!;
  }
  cached = keys;
  return keys;
}

/** Called with fresh notifications (in their transaction): a push job for people who subscribed. */
export async function queuePush(tx: DbOrTx, rows: { id: string; userId: string }[]) {
  if (!rows.length) return;
  const subscribed = await tx
    .selectDistinct({ userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, [...new Set(rows.map((r) => r.userId))]));
  const who = new Set(subscribed.map((s) => s.userId));
  for (const n of rows.filter((r) => who.has(r.userId)))
    await enqueue(tx, 'push.notify', { notificationId: n.id }, { dedupeKey: `push:${n.id}` });
}

/**
 * Pushes one notification to every device its person subscribed. Gone subscriptions (404/410)
 * are dropped; other failures are logged and not retried, so nobody gets the same push twice.
 */
export async function runPush(
  app: FastifyInstance,
  { notificationId }: { notificationId: string },
) {
  const [row] = await app.db
    .select({
      n: notifications,
      slug: workspaces.slug,
      number: issues.number,
      title: issues.title,
      teamKey: teams.key,
      actor: users.name,
      state: workflowStates.name,
      preferences: sql<Partial<UserPreferences> | null>`(select preferences from users r where r.id = ${notifications.userId})`,
    })
    .from(notifications)
    .innerJoin(workspaces, eq(workspaces.id, notifications.workspaceId))
    .leftJoin(issues, eq(issues.id, notifications.issueId))
    .leftJoin(teams, eq(teams.id, issues.teamId))
    .leftJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .where(eq(notifications.id, notificationId));
  if (!row || row.n.readAt) return;
  const identifier = row.teamKey ? `${row.teamKey}-${row.number}` : null;
  const payload = Buffer.from(
    JSON.stringify({
      title: identifier ? `${identifier} ${row.title}` : 'Ordo',
      body: describeNotification(localeOf(row.preferences), {
        type: row.n.type,
        actor: row.actor,
        state: row.state,
      }),
      url: identifier ? `/${row.slug}/issue/${identifier}` : `/${row.slug}/inbox`,
      tag: row.n.issueId ?? row.n.id,
    }),
  );
  const keys = await vapidKeys(app);
  const subject = app.env.publicUrl.startsWith('https:')
    ? app.env.publicUrl
    : 'mailto:push@ordo.invalid';
  const subs = await app.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, row.n.userId));
  for (const sub of subs) {
    try {
      const res = await safeFetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuthorization(sub.endpoint, keys, subject),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(24 * 3600),
          Urgency:
            row.n.type === 'issue_mention' || row.n.type === 'issue_sla_breached'
              ? 'high'
              : 'normal',
        },
        body: encryptPayload(payload, sub),
        allowPrivate: app.settings.get('allowPrivateNetworkTargets'),
        maxRedirects: 0,
      });
      if (res.status === 404 || res.status === 410)
        await app.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
      else if (res.ok)
        await app.db
          .update(pushSubscriptions)
          .set({ lastUsedAt: sql`now()` })
          .where(eq(pushSubscriptions.id, sub.id));
      else app.log.warn({ status: res.status, endpoint: sub.endpoint }, 'push rejected');
    } catch (err) {
      app.log.warn({ err, endpoint: sub.endpoint }, 'push failed');
    }
  }
}

/** Removes one of the caller's subscriptions. */
export async function unsubscribePush(db: DbOrTx, userId: string, endpoint: string) {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}
