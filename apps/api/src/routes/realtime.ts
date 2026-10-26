import type { FastifyInstance } from 'fastify';
import { authorizeWorkspace } from '../lib/auth.ts';

/** GET /api/ws?workspace=<slug> — a WebSocket that streams RealtimeEvents for one workspace. */
export async function realtimeRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const { workspace } = req.query as { workspace?: string };
    if (!req.user || !workspace) {
      socket.close(4401, 'unauthorized');
      return;
    }
    let ws: Awaited<ReturnType<typeof authorizeWorkspace>>;
    try {
      ws = await authorizeWorkspace(app.db, req.user, workspace);
    } catch {
      socket.close(4404, 'workspace not found');
      return;
    }
    const user = req.user;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const client = {
      userId: user.id,
      workspaceId: ws.id,
      access: ws.access,
      send: (d: string) => socket.send(d),
      // Debounced: a burst of membership events triggers one recheck. Losing access to the
      // workspace (removed, account disabled) closes the socket.
      refresh: () => {
        clearTimeout(pending);
        pending = setTimeout(async () => {
          try {
            client.access = (await authorizeWorkspace(app.db, user, { id: ws.id })).access;
          } catch {
            socket.close(4403, 'access revoked');
          }
        }, 100);
      },
    };
    const remove = app.realtime.add(client);
    const ping = setInterval(() => socket.ping(), 25_000);
    socket.on('close', () => {
      clearInterval(ping);
      clearTimeout(pending);
      remove();
    });
    socket.send(JSON.stringify({ kind: 'hello', workspaceId: ws.id }));
  });
}
