import type { FastifyInstance } from 'fastify';
import { resolveWorkspace } from '../lib/auth.ts';

/** GET /api/ws?workspace=<slug> — a WebSocket that streams RealtimeEvents for one workspace. */
export async function realtimeRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const { workspace } = req.query as { workspace?: string };
    if (!req.user || !workspace) {
      socket.close(4401, 'unauthorized');
      return;
    }
    let ws: Awaited<ReturnType<typeof resolveWorkspace>>;
    try {
      ws = await resolveWorkspace(app.db, req.user.id, workspace);
    } catch {
      socket.close(4404, 'workspace not found');
      return;
    }
    const remove = app.realtime.add({
      userId: req.user.id,
      workspaceId: ws.id,
      send: (d) => socket.send(d),
    });
    const ping = setInterval(() => socket.ping(), 25_000);
    socket.on('close', () => {
      clearInterval(ping);
      remove();
    });
    socket.send(JSON.stringify({ kind: 'hello', workspaceId: ws.id }));
  });
}
