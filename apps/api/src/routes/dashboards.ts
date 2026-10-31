import {
  agentActivityQuerySchema,
  createDashboardSchema,
  updateDashboardSchema,
} from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { forbidden, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { can } from '../services/access.ts';
import {
  agentActivity,
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  toDashboard,
  updateDashboard,
} from '../services/dashboards.ts';

export async function dashboardRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/dashboards', async (req) => listDashboards(db, requireAccess(req)));

  app.get('/dashboards/:id', async (req) => {
    const { id } = req.params as { id: string };
    return toDashboard(await getDashboard(db, requireAccess(req), id));
  });

  app.post('/dashboards', async (req) => {
    if (!can(requireAccess(req), 'views.create'))
      throw forbidden('Guests cannot create dashboards').as('guests_dashboards');
    const input = parse(createDashboardSchema, req.body);
    return mutate(app, req, (ctx) => createDashboard(ctx, input));
  });

  app.patch('/dashboards/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateDashboardSchema, req.body);
    return mutate(app, req, (ctx) => updateDashboard(ctx, id, input));
  });

  app.delete('/dashboards/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await deleteDashboard(ctx, id);
      return { ok: true };
    });
  });

  app.get('/agent-activity', async (req) =>
    agentActivity(db, requireAccess(req), parse(agentActivityQuerySchema, req.query)),
  );
}
