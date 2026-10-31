import { createCalendarFeedSchema } from '@ordo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { calendarFeeds } from '../db/schema.ts';
import { requireAccess, requireUser } from '../lib/auth.ts';
import { sha256 } from '../lib/crypto.ts';
import { forbidden, notFound, one, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { auditCtx } from '../services/audit.ts';
import {
  calendarFeedUrl,
  calendarForToken,
  deleteFeedsFor,
  newCalendarToken,
  toCalendarFeed,
  visibleView,
} from '../services/calendar.ts';

/** GET /api/calendar/<token>.ics — polled by calendar apps, so no session: the token is the key. */
export async function calendarFeedRoutes(app: FastifyInstance) {
  app.get(
    '/calendar/:file',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { file } = req.params as { file: string };
      if (!file.endsWith('.ics')) throw notFound('Calendar');
      const body = await calendarForToken(app, file.slice(0, -4));
      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('content-disposition', 'inline; filename="ordo.ics"')
        .header('cache-control', 'private, no-cache')
        .header('referrer-policy', 'no-referrer')
        .send(body);
    },
  );
}

/** The caller's own feeds in this workspace: list, create (or replace), revoke. */
export async function calendarRoutes(app: FastifyInstance) {
  app.get('/calendar-feeds', async (req) => {
    const access = requireAccess(req);
    const rows = await app.db
      .select()
      .from(calendarFeeds)
      .where(
        and(
          eq(calendarFeeds.userId, access.userId),
          eq(calendarFeeds.workspaceId, access.workspaceId),
        ),
      )
      .orderBy(asc(calendarFeeds.createdAt));
    return rows.map(toCalendarFeed);
  });

  // Tokens are stored hashed, so a lost URL can't be shown again: creating replaces it.
  app.post('/calendar-feeds', async (req) => {
    if (requireUser(req).kind !== 'human')
      throw forbidden('Only people can subscribe to calendars');
    const { viewId } = parse(createCalendarFeedSchema, req.body);
    return mutate(app, req, async (ctx) => {
      if (viewId) await visibleView(ctx.tx, ctx.access, viewId);
      const replaced = await deleteFeedsFor(ctx.tx, ctx.userId, ctx.workspaceId, viewId);
      const token = newCalendarToken();
      const row = one(
        await ctx.tx
          .insert(calendarFeeds)
          .values({
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            viewId,
            tokenHash: sha256(token),
            prefix: token.slice(0, 13),
          })
          .returning(),
      );
      for (const old of replaced)
        await auditCtx(ctx, {
          action: 'calendar_feed.revoked',
          targetType: 'calendar_feed',
          targetId: old.id,
          data: { viewId, via: 'replaced' },
        });
      await auditCtx(ctx, {
        action: 'calendar_feed.created',
        targetType: 'calendar_feed',
        targetId: row.id,
        data: { viewId },
      });
      // The URL is returned exactly once.
      return { feed: toCalendarFeed(row), url: calendarFeedUrl(app, token) };
    });
  });

  app.delete('/calendar-feeds/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [removed] = await ctx.tx
        .delete(calendarFeeds)
        .where(
          and(
            eq(calendarFeeds.id, id),
            eq(calendarFeeds.userId, ctx.userId),
            eq(calendarFeeds.workspaceId, ctx.workspaceId),
          ),
        )
        .returning();
      if (!removed) throw notFound('Calendar feed');
      await auditCtx(ctx, {
        action: 'calendar_feed.revoked',
        targetType: 'calendar_feed',
        targetId: id,
        data: { viewId: removed.viewId },
      });
      return { ok: true };
    });
  });
}
