import {
  agentRunOutputSchema,
  agentRunsQuerySchema,
  agentUsageQuerySchema,
  createAgentSchema,
  createApiKeySchema,
  reportAgentRunSchema,
  updateAgentSchema,
} from '@ordo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAccess, requireAdmin, requireUser } from '../lib/auth.ts';
import { forbidden, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  appendRunOutput,
  approvePlan,
  cancelRun,
  claimRun,
  countActiveRuns,
  createAgent,
  createAgentKey,
  describeAgent,
  dismissRun,
  getRunDetail,
  getRunOutput,
  heartbeat,
  listAgents,
  listAgentUsage,
  listPauses,
  listRuns,
  listWorkspaceRuns,
  reportRun,
  requestRun,
  restartRun,
  revokeAgentKey,
  runAnyway,
  unpauseAgent,
  updateAgent,
  waitForRuns,
} from '../services/agents.ts';

/** Optional body: instructions from the runner's own configuration, added to the agent's. */
const claimBody = z.object({ instructions: z.string().max(20_000).optional() });

const claimQuery = z.object({
  /** Seconds to wait for work before answering 204. */
  wait: z.coerce.number().int().min(0).max(60).default(0),
  runner: z.string().trim().max(200).optional(),
});

/** Runner endpoints answer only an agent's own API key. */
function requireAgent(req: FastifyRequest) {
  if (requireUser(req).kind !== 'agent') throw forbidden('Only an agent’s API key can do this');
  return requireAccess(req);
}

export async function agentRoutes(app: FastifyInstance) {
  const { db } = app;

  // ─── managing agents (admins) ─────────────────────────────────────────

  app.get('/agents', async (req) => {
    const ws = requireAdmin(req);
    return listAgents(db, ws.id);
  });

  app.post('/agents', async (req) => {
    requireAdmin(req);
    const input = parse(createAgentSchema, req.body);
    return mutate(app, req, (ctx) => createAgent(ctx, input));
  });

  app.patch('/agents/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const input = parse(updateAgentSchema, req.body);
    return mutate(app, req, (ctx) => updateAgent(ctx, id, input));
  });

  app.post('/agents/:id/keys', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const { name } = parse(createApiKeySchema, req.body);
    // The plaintext token is returned exactly once.
    return mutate(app, req, (ctx) => createAgentKey(ctx, id, name));
  });

  // "Resume now" on an agent paused by a usage limit; its runs that failed on it restart.
  app.post('/agents/:id/unpause', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => unpauseAgent(ctx, id));
  });

  app.delete('/agents/:id/keys/:keyId', async (req) => {
    requireAdmin(req);
    const { id, keyId } = req.params as { id: string; keyId: string };
    await mutate(app, req, (ctx) => revokeAgentKey(ctx, id, keyId));
    return { ok: true };
  });

  // ─── runs on an issue (anyone who can see it) ─────────────────────────

  app.get('/issues/:id/agent-runs', async (req) => {
    const { id } = req.params as { id: string };
    return listRuns(db, requireAccess(req), id);
  });

  app.post('/issues/:id/agent-runs', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => requestRun(ctx, id));
  });

  // Every run in the workspace the caller can see: the Agent runs page.
  app.get('/agent-runs', async (req) =>
    listWorkspaceRuns(db, requireAccess(req), parse(agentRunsQuerySchema, req.query)),
  );

  app.get('/agent-runs/active-count', async (req) => ({
    count: await countActiveRuns(db, requireAccess(req)),
  }));

  // One run with its prompt, timeline and restarts: the run's page.
  app.get('/agent-runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getRunDetail(db, requireAccess(req), id);
  });

  // The tail of what the run printed: anyone who can see its issue, like the rest of the run.
  app.get('/agent-runs/:id/output', async (req) => {
    const { id } = req.params as { id: string };
    return getRunOutput(db, requireAccess(req), id);
  });

  app.post('/agent-runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => cancelRun(ctx, id));
  });

  // A failed (or cancelled) run again: the same agent, issue and reason, as a new run.
  app.post('/agent-runs/:id/restart', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => restartRun(ctx, id));
  });

  // A queued run that waits for its issue's blockers goes ahead anyway.
  app.post('/agent-runs/:id/run-anyway', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => runAnyway(ctx, id));
  });

  app.post('/agent-runs/:id/dismiss', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => dismissRun(ctx, id));
  });

  // Approve: the plan the run is waiting on is fine; the run resumes to carry it out.
  app.post('/agent-runs/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => approvePlan(ctx, id));
  });

  // Agents whose claims are on hold (e.g. after a usage limit), for the Agent runs page.
  app.get('/agent-pauses', async (req) => listPauses(db, requireAccess(req).workspaceId));

  // Each agent's tokens and cost in a month, on issues the caller can see, with its budget.
  app.get('/agent-usage', async (req) =>
    listAgentUsage(db, requireAccess(req), parse(agentUsageQuerySchema, req.query).month),
  );

  // ─── the runner protocol (agent keys) ─────────────────────────────────

  app.get('/agent/me', async (req) => describeAgent(db, requireAgent(req)));

  /**
   * The next run, leased to the caller, or 204 when there's none within `wait` seconds. Waiting
   * listens for run events, so a newly assigned issue is handed out at once.
   */
  app.post('/agent/claim', async (req, reply) => {
    const access = requireAgent(req);
    const { wait, runner } = parse(claimQuery, req.query);
    const { instructions } = parse(claimBody, req.body ?? {});
    const deadline = Date.now() + wait * 1000;
    const gone = new AbortController();
    reply.raw.on('close', () => gone.abort());
    for (;;) {
      const context = await claimRun(app, access, runner ?? null, instructions);
      if (context) return context;
      const left = deadline - Date.now();
      if (left <= 0 || gone.signal.aborted) return reply.status(204).send();
      await waitForRuns(app, access, left, gone.signal);
    }
  });

  app.post('/agent/runs/:id/heartbeat', async (req) => {
    requireAgent(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, (ctx) => heartbeat(ctx, id));
  });

  /**
   * Live output: lines the command printed since the last call. The runner batches them every few
   * seconds; more often than twice a second per run is refused (429), and it's safe to drop some.
   */
  app.post(
    '/agent/runs/:id/output',
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) =>
            `${req.user?.id ?? req.ip}:${(req.params as { id?: string }).id}`,
        },
      },
    },
    async (req) => {
      requireAgent(req);
      const { id } = req.params as { id: string };
      const { lines } = parse(agentRunOutputSchema, req.body);
      return mutate(app, req, (ctx) => appendRunOutput(ctx, id, lines));
    },
  );

  app.patch('/agent/runs/:id', async (req) => {
    requireAgent(req);
    const { id } = req.params as { id: string };
    const input = parse(reportAgentRunSchema, req.body);
    return mutate(app, req, (ctx) => reportRun(ctx, id, input));
  });
}
