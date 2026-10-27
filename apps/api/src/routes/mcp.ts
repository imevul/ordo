import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser, requireWorkspace } from '../lib/auth.ts';
import { HttpError, unauthorized } from '../lib/errors.ts';
import { requestMeta, runInWorkspace } from '../lib/mutate.ts';
import { callMcpTool, isMcpTool, type McpCaller, mcpToolList } from '../services/mcp.ts';
import { resourceMetadataUrl, SCOPE } from '../services/oauth.ts';

/**
 * Remote MCP server (Streamable HTTP) for one workspace: POST /api/w/:ws/mcp.
 *
 * Stateless and JSON-only: every POST carries one JSON-RPC message and gets one JSON response.
 * It serves both eras of the protocol: 2026-07-28 clients send their version in each request's
 * `_meta` (mirrored in headers), older clients open with `initialize`. Auth is an OAuth access
 * token issued for this endpoint (services/oauth.ts) or a personal API key, resolved by the
 * workspace hook like any REST call, so the agent has exactly the user's access and the
 * workspace's SSO policy applies.
 */

const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED = [MODERN, ...LEGACY];
const META = 'io.modelcontextprotocol/';

// JSON-RPC and MCP error codes. Application errors use the HTTP status as their code, which is
// outside the range JSON-RPC reserves.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

type Id = string | number;
interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public status = 400,
    public data?: unknown,
  ) {
    super(message);
  }
}

const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number';
const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Mcp-Name may carry a value that isn't header-safe as `=?base64?…?=`. */
function decodeHeader(v: string | undefined) {
  const m = v && /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : v;
}

export async function mcpRoutes(app: FastifyInstance) {
  const serverInfo = { name: 'ordo', title: 'Ordo', version: app.env.version };

  // Clients read JSON-RPC errors, including for auth failures in the workspace hook.
  app.setErrorHandler((err: Error, req, reply) => {
    const id = isId((req.body as Message | undefined)?.id) ? (req.body as Message).id : undefined;
    let status = (err as { statusCode?: number }).statusCode ?? 500;
    let code = status;
    let message = err.message;
    if (err instanceof RpcError) {
      status = err.status;
      code = err.code;
    } else if ((err as { code?: string }).code?.startsWith('FST_ERR_CTP')) {
      code = PARSE_ERROR;
      message = 'Expected a JSON-RPC message as application/json';
    } else if (status >= 500) {
      req.log.error({ err }, 'mcp request failed');
      code = INTERNAL_ERROR;
      message = 'Internal server error';
    }
    if (status === 401) {
      // Where an OAuth client finds out how to sign in (RFC 9728 §5.1).
      const { ws } = req.params as { ws: string };
      const invalid = req.headers.authorization ? ', error="invalid_token"' : '';
      reply.header(
        'www-authenticate',
        `Bearer realm="Ordo", resource_metadata="${resourceMetadataUrl(app, ws)}", scope="${SCOPE}"${invalid}`,
      );
      message = 'Sign in with OAuth, or send a personal API key as Authorization: Bearer ordo_…';
    }
    const data =
      err instanceof RpcError
        ? err.data
        : err instanceof HttpError
          ? { error: err.code, details: err.details }
          : undefined;
    return reply.status(status).send({ jsonrpc: '2.0', id, error: { code, message, data } });
  });

  // No server-initiated streams and no sessions, so only POST is served.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  app.post(
    '/mcp',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute', keyGenerator: rateKey } } },
    async (req, reply) => {
      if (req.authMethod !== 'api_key' && req.authMethod !== 'oauth')
        throw unauthorized('Sign in with OAuth or use a personal API key as a Bearer token');
      checkOrigin(req);
      const msg = req.body as Message;
      if (Array.isArray(msg)) throw new RpcError(INVALID_REQUEST, 'Batches are not supported');
      if (
        !msg ||
        typeof msg !== 'object' ||
        msg.jsonrpc !== '2.0' ||
        typeof msg.method !== 'string'
      )
        throw new RpcError(INVALID_REQUEST, 'Expected a JSON-RPC 2.0 request');
      // Notifications (initialized, cancelled) need no answer.
      if (!('id' in msg)) return reply.status(202).send();
      if (!isId(msg.id))
        throw new RpcError(INVALID_REQUEST, 'Request ids must be strings or numbers');
      if (msg.params !== undefined && (typeof msg.params !== 'object' || msg.params === null))
        throw new RpcError(INVALID_PARAMS, 'params must be an object');

      const modern = negotiate(req, msg);
      const result = await dispatch(req, msg, modern);
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: modern
          ? { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: serverInfo } }
          : result,
      };
    },
  );

  /**
   * Works out which era the request belongs to and checks it. Modern requests carry their
   * version in `_meta` and mirror it, the method and the tool name in headers.
   */
  function negotiate(req: FastifyRequest, msg: Message): boolean {
    const meta = msg.params?._meta;
    const version = meta?.[`${META}protocolVersion`];
    const headerVersion = header(req, 'mcp-protocol-version');
    if (version === undefined) {
      if (msg.method === 'initialize') return false;
      if (headerVersion === MODERN)
        throw new RpcError(INVALID_PARAMS, `Missing _meta["${META}protocolVersion"]`);
      if (headerVersion && !LEGACY.includes(headerVersion))
        throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', 400, {
          supported: SUPPORTED,
          requested: headerVersion,
        });
      return false;
    }
    if (version !== MODERN)
      throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', 400, {
        supported: SUPPORTED,
        requested: version,
      });
    if (meta?.[`${META}clientCapabilities`] === undefined)
      throw new RpcError(INVALID_PARAMS, `Missing _meta["${META}clientCapabilities"]`);
    const mismatch = (what: string) => new RpcError(HEADER_MISMATCH, `Header mismatch: ${what}`);
    if (headerVersion !== version) throw mismatch('MCP-Protocol-Version');
    if (header(req, 'mcp-method') !== msg.method) throw mismatch('Mcp-Method');
    if (msg.method === 'tools/call' && decodeHeader(header(req, 'mcp-name')) !== msg.params?.name)
      throw mismatch('Mcp-Name');
    return true;
  }

  async function dispatch(req: FastifyRequest, msg: Message, modern: boolean) {
    const ws = requireWorkspace(req);
    const user = requireUser(req);
    const instructions =
      `Ordo issue tracker, workspace "${ws.name}". You act as ${user.name} (@${user.username}) ` +
      'with their permissions. Refer to teams by key, issues by identifier (ENG-42), people by ' +
      'username or "me", statuses and labels by name. Call list_teams first to learn team keys ' +
      'and statuses.';
    const capabilities = { tools: {} };
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        const protocolVersion =
          typeof asked === 'string' && LEGACY.includes(asked) ? asked : LEGACY[0]!;
        return { protocolVersion, capabilities, serverInfo, instructions };
      }
      case 'server/discover':
        return { supportedVersions: SUPPORTED, capabilities, instructions };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: mcpToolList() };
      case 'tools/call': {
        const name = msg.params?.name;
        if (!isMcpTool(name))
          throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(name)}`, 200);
        const caller: McpCaller = {
          app,
          access: ws.access,
          workspace: ws,
          run: (fn) =>
            runInWorkspace(
              app,
              {
                workspaceId: ws.id,
                actorId: user.id,
                access: ws.access,
                source: 'mcp',
                meta: requestMeta(req),
              },
              fn,
            ),
        };
        try {
          const out = await callMcpTool(caller, name, msg.params?.arguments);
          return { content: [{ type: 'text', text: JSON.stringify(out) }] };
        } catch (err) {
          // Tool failures go back to the model, which can correct itself.
          if (!(err instanceof HttpError)) throw err;
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${msg.method}`, modern ? 404 : 200);
    }
  }
}

/** Requests from a browser must come from Ordo itself (DNS rebinding protection, per the spec). */
function checkOrigin(req: FastifyRequest) {
  const origin = header(req, 'origin');
  if (!origin || origin === 'null') return;
  const forwarded = header(req, 'x-forwarded-host');
  let ok = false;
  try {
    ok =
      new URL(origin).host === new URL(`${req.protocol}://${forwarded ?? req.headers.host}`).host;
  } catch {}
  if (!ok) throw new RpcError(INVALID_REQUEST, 'Origin not allowed', 403);
}

const rateKey = (req: FastifyRequest) => req.user?.id ?? req.ip;
