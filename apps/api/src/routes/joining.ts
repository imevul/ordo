import type { JoinableWorkspace } from '@ordo/shared';
import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { users, workspaceDomains, workspaceMembers, workspaces } from '../db/schema.ts';
import { requireUser } from '../lib/auth.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import { signedFileUrl } from '../services/files.ts';
import { joinWorkspace, workspaceSettings } from '../services/workspaces.ts';

/**
 * Workspaces someone may join without an invite: auto-join is on, and their *verified* email
 * address is at a domain the workspace has verified.
 */
async function joinable(app: FastifyInstance, userId: string) {
  const [user] = await app.db.select().from(users).where(eq(users.id, userId));
  if (!user?.emailVerifiedAt) return [];
  const domain = user.email.split('@')[1]!.toLowerCase();
  const rows = await app.db
    .select({ ws: workspaces })
    .from(workspaceDomains)
    .innerJoin(workspaces, eq(workspaces.id, workspaceDomains.workspaceId))
    .where(
      and(
        eq(workspaceDomains.domain, domain),
        isNotNull(workspaceDomains.verifiedAt),
        sql`not exists (select 1 from workspace_members m where m.workspace_id = "workspaces"."id" and m.user_id = ${userId})`,
      ),
    );
  return rows.map((r) => r.ws).filter((w) => workspaceSettings(w).domainAutoJoin);
}

export async function joiningRoutes(app: FastifyInstance) {
  app.get('/workspaces/joinable', async (req): Promise<JoinableWorkspace[]> => {
    const list = await joinable(app, requireUser(req).id);
    return Promise.all(
      list.map(async (w) => {
        const [{ n }] = (await app.db
          .select({ n: count() })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, w.id))) as [{ n: number }];
        return {
          id: w.id,
          name: w.name,
          slug: w.slug,
          logoUrl: signedFileUrl(app, w.logoFileId),
          memberCount: n,
        };
      }),
    );
  });

  app.post('/workspaces/:id/join', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const ws = (await joinable(app, user.id)).find((w) => w.id === id);
    if (!ws) {
      const [exists] = await app.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, id));
      throw exists
        ? forbidden('You need an invite to join this workspace').as('invite_needed')
        : notFound('Workspace');
    }
    const role = workspaceSettings(ws).autoJoinRole;
    await app.db.transaction(async (tx) => {
      await joinWorkspace(tx, ws.id, user.id, role);
      await audit(
        tx,
        {
          action: 'member.joined',
          workspaceId: ws.id,
          actorId: user.id,
          data: { via: 'domain', role },
        },
        requestMeta(req),
      );
    });
    app.realtime.publish([
      { kind: 'member', action: 'created', id: user.id, workspaceId: ws.id, actorId: user.id },
    ]);
    return { workspaceSlug: ws.slug };
  });
}
