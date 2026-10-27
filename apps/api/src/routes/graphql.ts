import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser, requireWorkspace } from '../lib/auth.ts';
import { HttpError } from '../lib/errors.ts';
import { buildGraphqlSchema, formatError, runGraphql } from '../services/graphql/index.ts';

/**
 * GraphQL for one workspace: POST /api/w/:ws/graphql with `{ query, variables?, operationName? }`.
 * Same auth and access as the REST API (session or API key); the schema is in
 * services/graphql/schema.ts.
 */
export async function graphqlRoutes(app: FastifyInstance) {
  const schema = buildGraphqlSchema();

  // Auth and request errors in GraphQL's shape, so clients have one format to read.
  app.setErrorHandler((err: Error, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'graphql request failed');
    const code =
      status === 401
        ? 'UNAUTHENTICATED'
        : err instanceof HttpError
          ? err.code.toUpperCase()
          : 'BAD_REQUEST';
    return reply.status(status).send({
      errors: [
        { message: status >= 500 ? 'Internal server error' : err.message, extensions: { code } },
      ],
    });
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(405)
      .header('allow', 'POST')
      .send({
        errors: [
          {
            message: 'Send queries as POST with a JSON body',
            extensions: { code: 'METHOD_NOT_ALLOWED' },
          },
        ],
      });
  app.get('/graphql', notAllowed);

  app.post(
    '/graphql',
    {
      bodyLimit: 256 * 1024,
      config: {
        rateLimit: {
          max: 600,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.query !== 'string')
        throw new HttpError(400, 'Send {"query": "…"} as JSON', 'bad_request');
      const variables =
        body.variables && typeof body.variables === 'object'
          ? (body.variables as Record<string, unknown>)
          : null;
      const ws = requireWorkspace(req);
      const { status, body: result } = await runGraphql(
        schema,
        {
          query: body.query,
          variables,
          operationName: typeof body.operationName === 'string' ? body.operationName : null,
        },
        { app, req, access: ws.access, ws, user: requireUser(req) },
      );
      return reply.status(status).send({
        ...(result.data !== undefined && { data: result.data }),
        ...(result.errors?.length && {
          errors: result.errors.map((e) =>
            formatError(e, (err) => req.log.error({ err }, 'graphql resolver failed')),
          ),
        }),
      });
    },
  );
}
