import { aiDraftSchema } from '@ordo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireWorkspace } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { draftIssue, summarizeIssue, triageIssue, workspaceModel } from '../services/ai/assist.ts';
import type { McpReader } from '../services/mcp.ts';

/**
 * AI assistance (services/ai). Nothing here changes data: answers are suggestions the web app
 * shows, and people apply them through the usual endpoints.
 */
export async function aiRoutes(app: FastifyInstance) {
  // Each request costs the instance money or GPU time.
  const limited = {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip,
      },
    },
  };

  const prepare = async (req: FastifyRequest) => {
    const ws = requireWorkspace(req);
    const model = await workspaceModel(app, ws.id);
    const reader: McpReader = { app, access: ws.access, workspace: ws };
    return { model, reader };
  };

  app.post<{ Params: { id: string } }>('/ai/issues/:id/summary', limited, async (req) => {
    const { model, reader } = await prepare(req);
    return summarizeIssue(model, reader, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/ai/issues/:id/triage', limited, async (req) => {
    const { model, reader } = await prepare(req);
    return triageIssue(model, reader, req.params.id);
  });

  app.post('/ai/draft', limited, async (req) => {
    const input = parse(aiDraftSchema, req.body);
    const { model, reader } = await prepare(req);
    return draftIssue(model, reader, input);
  });
}
