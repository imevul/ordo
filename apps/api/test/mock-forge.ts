import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ForgeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

type Handler = (req: ForgeRequest) => { status?: number; body?: unknown } | undefined;

/** A stand-in for GitHub, GitLab or Forgejo APIs: answers from registered handlers, logs every call. */
export async function startMockForge() {
  const routes = new Map<string, Handler>();
  const log: ForgeRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'http://x');
    const entry: ForgeRequest = {
      method: req.method!,
      path: url.pathname + url.search,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : null,
    };
    log.push(entry);
    const handler = routes.get(`${req.method} ${url.pathname}`);
    const out =
      handler?.(entry) ??
      (handler ? { status: 200, body: {} } : { status: 404, body: { message: 'Not Found' } });
    res
      .writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      .end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    log,
    on(method: string, path: string, handler: Handler | unknown) {
      routes.set(
        `${method} ${path}`,
        typeof handler === 'function' ? (handler as Handler) : () => ({ body: handler }),
      );
    },
    calls: (method: string, path: string) =>
      log.filter((r) => r.method === method && r.path.split('?')[0] === path),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
