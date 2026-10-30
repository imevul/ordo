import {
  type InboxFilter,
  inboxFilterSchema,
  type Notification,
  type NotificationType,
  notificationBulkSchema,
  snoozeSchema,
} from '@ordo/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { issues, notifications, teams, users } from '../db/schema.ts';
import { requireUser, requireWorkspace } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { teamScope } from '../services/access.ts';
import { emit } from '../services/context.ts';

const list = (v: unknown) =>
  typeof v === 'string' && v !== '' ? v.split(',').map((x) => x.trim()) : undefined;

/** `?types=a,b&unread=1…` as an `InboxFilter`. */
function filterFromQuery(q: Record<string, string | undefined>): InboxFilter {
  return parse(inboxFilterSchema, {
    types: list(q.types),
    teams: list(q.teams),
    actors: list(q.actors),
    from: q.from || undefined,
    priorities: list(q.priorities)?.map(Number),
    reasons: list(q.reasons),
    unread: q.unread === '1' || q.unread === 'true' ? true : undefined,
  });
}

/**
 * The caller's inbox (or Snoozed) narrowed by a filter, as conditions over `notifications` left-joined
 * with `issues` and the actor in `users`. Notifications about issues in teams the caller can no
 * longer see are always left out.
 */
function inboxWhere(req: FastifyRequest, snoozed: boolean, f: InboxFilter = {}): SQL | undefined {
  const user = requireUser(req);
  const ws = requireWorkspace(req);
  // Older notifications have no reason: they came from following the issue.
  const reason = sql`coalesce(${notifications.data}->>'reason', 'subscriber')`;
  return and(
    eq(notifications.workspaceId, ws.id),
    eq(notifications.userId, user.id),
    snoozed
      ? sql`${notifications.snoozedUntil} > now()`
      : or(isNull(notifications.snoozedUntil), sql`${notifications.snoozedUntil} <= now()`),
    ws.access.isAdmin
      ? undefined
      : or(isNull(notifications.issueId), teamScope(ws.access, issues.teamId)),
    f.types?.length ? inArray(notifications.type, f.types) : undefined,
    f.teams?.length ? inArray(issues.teamId, f.teams) : undefined,
    f.actors?.length ? inArray(notifications.actorId, f.actors) : undefined,
    f.from === 'bots'
      ? inArray(users.kind, ['bot', 'agent'])
      : f.from === 'people'
        ? or(isNull(users.id), eq(users.kind, 'human'))
        : undefined,
    f.priorities?.length ? inArray(issues.priority, f.priorities) : undefined,
    f.reasons?.length ? sql`${reason} in ${f.reasons}` : undefined,
    f.unread ? isNull(notifications.readAt) : undefined,
  );
}

export async function notificationRoutes(app: FastifyInstance) {
  /** Ids of the caller's notifications a bulk action covers: `ids`, or everything the filter matches. */
  const matching = (req: FastifyRequest, snoozed: boolean, f: InboxFilter | undefined) =>
    app.db
      .select({ id: notifications.id })
      .from(notifications)
      .leftJoin(issues, eq(issues.id, notifications.issueId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .where(inboxWhere(req, snoozed, f));

  /**
   * The inbox, newest first; `?snoozed=1` lists the snoozed ones instead. Narrowed by the
   * `InboxFilter` query parameters (`types`, `teams`, `actors`, `from`, `priorities`, `reasons`, `unread`).
   */
  app.get('/notifications', async (req): Promise<Notification[]> => {
    const query = req.query as Record<string, string | undefined>;
    const snoozed = query.snoozed === '1';
    const rows = await app.db
      .select({
        n: notifications,
        issue: {
          id: issues.id,
          number: issues.number,
          title: issues.title,
          stateId: issues.stateId,
          teamId: issues.teamId,
        },
        teamKey: teams.key,
      })
      .from(notifications)
      .leftJoin(issues, eq(issues.id, notifications.issueId))
      .leftJoin(teams, eq(teams.id, issues.teamId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .where(inboxWhere(req, snoozed, filterFromQuery(query)))
      .orderBy(
        snoozed
          ? asc(notifications.snoozedUntil)
          : desc(sql`coalesce(${notifications.wokeAt}, ${notifications.createdAt})`),
      )
      .limit(200);
    return rows.map(({ n, issue, teamKey }) => ({
      id: n.id,
      type: n.type,
      issueId: n.issueId,
      commentId: n.commentId,
      actorId: n.actorId,
      readAt: n.readAt,
      snoozedUntil: n.snoozedUntil,
      createdAt: n.wokeAt ?? n.createdAt,
      data: n.data,
      issue: issue?.id
        ? {
            id: issue.id,
            identifier: `${teamKey}-${issue.number}`,
            title: issue.title,
            stateId: issue.stateId,
            teamId: issue.teamId,
          }
        : null,
    }));
  });

  /** Unread notifications in the inbox (not Snoozed) per type, for the inbox's quick filters. */
  app.get('/notifications/counts', async (req) => {
    const rows = await app.db
      .select({ type: notifications.type, count: sql<number>`count(*)::int` })
      .from(notifications)
      .leftJoin(issues, eq(issues.id, notifications.issueId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .where(inboxWhere(req, false, { unread: true }))
      .groupBy(notifications.type);
    return Object.fromEntries(rows.map((r) => [r.type, r.count])) as Partial<
      Record<NotificationType, number>
    >;
  });

  /**
   * Marks notifications read (or unread): the given `ids`, or everything the `filter` matches in the
   * inbox (or in Snoozed, with `snoozed: true`) — with neither, every unread one.
   */
  app.post('/notifications/read', async (req) => {
    const { ids, filter, snoozed, unread } = parse(notificationBulkSchema, req.body ?? {});
    return mutate(app, req, async (ctx) => {
      const scope = and(
        eq(notifications.workspaceId, ctx.workspaceId),
        eq(notifications.userId, ctx.userId),
      );
      await ctx.tx
        .update(notifications)
        .set({ readAt: unread ? null : new Date().toISOString() })
        .where(
          ids?.length
            ? and(scope, inArray(notifications.id, ids))
            : filter
              ? and(scope, inArray(notifications.id, matching(req, !!snoozed, filter)))
              : and(scope, isNull(notifications.readAt)),
        );
      emit(ctx, {
        kind: 'notification',
        action: 'updated',
        id: ids?.[0] ?? 'all',
        userId: ctx.userId,
      });
      return { ok: true };
    });
  });

  /**
   * Snoozes notifications until a time (or wakes them, with `until: null`). They come back unread,
   * at the top of the inbox; meanwhile they aren't emailed.
   */
  app.post('/notifications/snooze', async (req) => {
    const { ids, until } = parse(snoozeSchema, req.body);
    return mutate(app, req, async (ctx) => {
      await ctx.tx
        .update(notifications)
        .set(
          until
            ? {
                snoozedUntil: until,
                readAt: null,
                emailedAt: sql`coalesce(${notifications.emailedAt}, now())`,
              }
            : { snoozedUntil: null, wokeAt: sql`now()` },
        )
        .where(
          and(
            eq(notifications.workspaceId, ctx.workspaceId),
            eq(notifications.userId, ctx.userId),
            inArray(notifications.id, ids),
          ),
        );
      emit(ctx, { kind: 'notification', action: 'updated', id: ids[0]!, userId: ctx.userId });
      return { ok: true };
    });
  });

  /** Deletes the given `ids`, or with `read: true` the read ones (of those the `filter` matches, if given). */
  app.post('/notifications/delete', async (req) => {
    const { ids, read, filter, snoozed } = parse(notificationBulkSchema, req.body ?? {});
    return mutate(app, req, async (ctx) => {
      const scope = and(
        eq(notifications.workspaceId, ctx.workspaceId),
        eq(notifications.userId, ctx.userId),
      );
      if (ids?.length)
        await ctx.tx.delete(notifications).where(and(scope, inArray(notifications.id, ids)));
      else if (read)
        await ctx.tx
          .delete(notifications)
          .where(
            and(
              scope,
              isNotNull(notifications.readAt),
              filter ? inArray(notifications.id, matching(req, !!snoozed, filter)) : undefined,
            ),
          );
      emit(ctx, {
        kind: 'notification',
        action: 'deleted',
        id: ids?.[0] ?? 'all',
        userId: ctx.userId,
      });
      return { ok: true };
    });
  });
}
