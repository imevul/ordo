import { type Notification, snoozeSchema } from '@ordo/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { issues, notifications, teams } from '../db/schema.ts';
import { requireUser, requireWorkspace } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { teamScope } from '../services/access.ts';
import { emit } from '../services/context.ts';

export async function notificationRoutes(app: FastifyInstance) {
  /** The inbox, newest first; `?snoozed=1` lists the snoozed ones instead. */
  app.get('/notifications', async (req): Promise<Notification[]> => {
    const user = requireUser(req);
    const ws = requireWorkspace(req);
    const snoozed = (req.query as { snoozed?: string }).snoozed === '1';
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
      .where(
        and(
          eq(notifications.workspaceId, ws.id),
          eq(notifications.userId, user.id),
          snoozed
            ? sql`${notifications.snoozedUntil} > now()`
            : or(isNull(notifications.snoozedUntil), sql`${notifications.snoozedUntil} <= now()`),
          // Hide notifications about issues in teams the user can no longer see.
          ws.access.isAdmin
            ? undefined
            : or(isNull(notifications.issueId), teamScope(ws.access, issues.teamId)),
        ),
      )
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

  /** Marks the given notifications (or all, when `ids` is omitted) as read or unread. */
  app.post('/notifications/read', async (req) => {
    const { ids, unread } = (req.body ?? {}) as { ids?: string[]; unread?: boolean };
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

  app.post('/notifications/delete', async (req) => {
    const { ids, read } = (req.body ?? {}) as { ids?: string[]; read?: boolean };
    return mutate(app, req, async (ctx) => {
      const scope = and(
        eq(notifications.workspaceId, ctx.workspaceId),
        eq(notifications.userId, ctx.userId),
      );
      if (ids?.length)
        await ctx.tx.delete(notifications).where(and(scope, inArray(notifications.id, ids)));
      else if (read)
        await ctx.tx.delete(notifications).where(and(scope, isNotNull(notifications.readAt)));
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
