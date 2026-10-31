import { insightsTimelineQuerySchema, insightsVelocityQuerySchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { insightsTimeline, insightsVelocity } from '../services/insights.ts';

export async function insightsRoutes(app: FastifyInstance) {
  app.get('/insights/timeline', async (req) =>
    insightsTimeline(app.db, requireAccess(req), parse(insightsTimelineQuerySchema, req.query)),
  );

  app.get('/insights/velocity', async (req) =>
    insightsVelocity(app.db, requireAccess(req), parse(insightsVelocityQuerySchema, req.query)),
  );
}
