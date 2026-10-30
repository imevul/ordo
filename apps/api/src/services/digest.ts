import {
  DEFAULT_PREFERENCES,
  type EmailDigest,
  type Locale,
  type NotificationType,
  type UserPreferences,
} from '@ordo/shared';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { issues, notifications, teams, users, workflowStates, workspaces } from '../db/schema.ts';
import { localeOf, serverT } from '../i18n/index.ts';
import { type DigestItem, digestEmail } from './mail-templates.ts';
import { queueEmail } from './mailer.ts';

/** Merges stored preferences over the defaults (stored values may be partial or from older versions). */
export function resolvePreferences(
  stored: Partial<UserPreferences> | null | undefined,
): UserPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    notifications: {
      ...DEFAULT_PREFERENCES.notifications,
      ...stored?.notifications,
      email: { ...DEFAULT_PREFERENCES.notifications.email, ...stored?.notifications?.email },
    },
  };
}

// Give people a moment to see a notification in the app before emailing it.
const GRACE_MS = 90_000;
const WAIT_MS: Record<EmailDigest, number> = {
  off: 0,
  instant: GRACE_MS,
  hourly: 3_600_000,
  daily: 86_400_000,
};

/** One notification as a line in its recipient's language: "Ada assigned you". */
export function describeNotification(
  locale: Locale,
  n: { type: NotificationType; actor: string | null; state?: string | null },
) {
  const t = serverT(locale);
  return t(`notification.${n.type}`, {
    actor: n.actor ?? t('notification.someone'),
    state: n.state ?? '',
  });
}

/**
 * Emails pending notifications. Each user's unread, un-emailed notifications are batched per
 * workspace once the oldest is older than their digest interval; types they opted out of — and
 * everything, when the digest is off — are marked as handled without sending.
 */
export async function sendNotificationEmails(app: FastifyInstance) {
  if (!app.mailer.enabled) return;
  const cutoff = new Date(Date.now() - GRACE_MS).toISOString();
  const pending = await app.db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      workspaceId: notifications.workspaceId,
      type: notifications.type,
      actorName: sql<
        string | null
      >`(select name from users a where a.id = ${notifications.actorId})`,
      issueId: notifications.issueId,
      createdAt: notifications.createdAt,
      email: users.email,
      preferences: users.preferences,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        isNull(notifications.emailedAt),
        isNull(notifications.readAt),
        lt(notifications.createdAt, cutoff),
        isNull(users.disabledAt),
        eq(users.kind, 'human'),
      ),
    )
    // Oldest first, so a digest lists its items in order and the limit leaves the newest for later.
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(2000);
  if (pending.length === 0) return;

  const issueIds = [...new Set(pending.map((p) => p.issueId).filter((x): x is string => !!x))];
  const issueRows = issueIds.length
    ? await app.db
        .select({
          id: issues.id,
          title: issues.title,
          number: issues.number,
          key: teams.key,
          slug: workspaces.slug,
          state: workflowStates.name,
        })
        .from(issues)
        .innerJoin(teams, eq(teams.id, issues.teamId))
        .innerJoin(workspaces, eq(workspaces.id, issues.workspaceId))
        .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
        .where(inArray(issues.id, issueIds))
    : [];
  const issueById = new Map(issueRows.map((i) => [i.id, i]));
  const workspaceRows = await app.db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces);
  const workspaceById = new Map(workspaceRows.map((w) => [w.id, w]));

  const groups = new Map<string, typeof pending>();
  for (const n of pending) {
    const key = `${n.userId}:${n.workspaceId}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }

  const now = Date.now();
  for (const items of groups.values()) {
    const first = items[0]!;
    const prefs = resolvePreferences(first.preferences);
    const digest = prefs.notifications.emailDigest;
    const wanted = items.filter((n) => digest !== 'off' && prefs.notifications.email[n.type]);
    const oldest = Math.min(...wanted.map((n) => new Date(n.createdAt).getTime()));
    const due = wanted.length > 0 && now - oldest >= WAIT_MS[digest];
    // Opted-out notifications are settled right away so they don't pile up.
    const settle = due ? items : items.filter((n) => !wanted.includes(n));
    if (settle.length === 0) continue;

    // Marking and queueing share a transaction, so a failed or retried run neither sends a
    // notification twice nor drops it. Only rows still un-emailed are claimed, so an overlapping
    // run can't send the same ones either.
    await app.db.transaction(async (tx) => {
      const claimed = await tx
        .update(notifications)
        .set({ emailedAt: new Date().toISOString() })
        .where(
          and(
            inArray(
              notifications.id,
              settle.map((n) => n.id),
            ),
            isNull(notifications.emailedAt),
          ),
        )
        .returning({ id: notifications.id });
      if (!due) return;
      const claimedIds = new Set(claimed.map((c) => c.id));
      const ws = workspaceById.get(first.workspaceId);
      const locale = localeOf(first.preferences);
      const lines: DigestItem[] = wanted.flatMap((n) => {
        const issue = n.issueId ? issueById.get(n.issueId) : undefined;
        if (!claimedIds.has(n.id) || !issue || !ws) return [];
        const identifier = `${issue.key}-${issue.number}`;
        return [
          {
            identifier,
            title: issue.title,
            line: describeNotification(locale, {
              type: n.type,
              actor: n.actorName,
              state: issue.state,
            }),
            url: `${app.env.publicUrl}/${ws.slug}/issue/${identifier}`,
          },
        ];
      });
      if (lines.length && ws) {
        await queueEmail(
          tx,
          first.email,
          digestEmail(locale, {
            workspace: ws.name,
            items: lines,
            settingsUrl: `${app.env.publicUrl}/${ws.slug}/settings/notifications`,
          }),
        );
      }
    });
  }
}
