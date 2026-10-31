import {
  createTimeEntrySchema,
  startTimerSchema,
  timeReportQuerySchema,
  updateTimeEntrySchema,
} from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  deleteTimeEntry,
  issueTime,
  logTime,
  runningTimer,
  startTimer,
  stopTimer,
  timeReport,
  timeReportCsv,
  updateTimeEntry,
} from '../services/timeEntries.ts';

/** Time tracking (when the workspace has it on): entries on issues, the caller's timer, reports. */
export async function timeEntryRoutes(app: FastifyInstance) {
  app.get('/issues/:id/time-entries', async (req) => {
    const { id } = req.params as { id: string };
    return issueTime(app.db, requireAccess(req), id);
  });

  app.post('/issues/:id/time-entries', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createTimeEntrySchema, req.body);
    return mutate(app, req, (ctx) => logTime(ctx, id, input));
  });

  app.post('/issues/:id/timer', async (req) => {
    const { id } = req.params as { id: string };
    const { note } = parse(startTimerSchema, req.body ?? {});
    return mutate(app, req, (ctx) => startTimer(ctx, id, note));
  });

  app.get('/timer', async (req) => runningTimer(app.db, requireAccess(req)));

  app.post('/timer/stop', async (req) => mutate(app, req, (ctx) => stopTimer(ctx)));

  app.patch('/time-entries/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateTimeEntrySchema, req.body);
    return mutate(app, req, (ctx) => updateTimeEntry(ctx, id, input));
  });

  app.delete('/time-entries/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteTimeEntry(ctx, id));
    return { ok: true };
  });

  app.get('/time-entries/report', async (req, reply) => {
    const { format, ...q } = parse(timeReportQuerySchema, req.query);
    const report = await timeReport(app.db, requireAccess(req), q);
    if (format !== 'csv') return report;
    const name = `time-${q.from ?? 'start'}-to-${q.to ?? 'now'}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(await timeReportCsv(app.db, report));
  });
}
