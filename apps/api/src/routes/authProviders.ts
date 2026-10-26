import {
  type AuthProvider,
  createAuthProviderSchema,
  updateAuthProviderSchema,
} from '@ordo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authProviders } from '../db/schema.ts';
import { requireAdmin } from '../lib/auth.ts';
import { badRequest, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { auditCtx } from '../services/audit.ts';
import { secretAad } from '../services/sso.ts';

const toProvider = (p: typeof authProviders.$inferSelect): AuthProvider => ({
  id: p.id,
  name: p.name,
  issuer: p.issuer,
  clientId: p.clientId,
  scopes: p.scopes,
  enabled: p.enabled,
  defaultRole: p.defaultRole,
  groupClaim: p.groupClaim,
  groupRoles: p.groupRoles,
  createdAt: p.createdAt,
});

/** Workspace admins manage their workspace's identity providers. Client secrets are write-only. */
export async function authProviderRoutes(app: FastifyInstance) {
  app.get('/auth-providers', async (req) => {
    const ws = requireAdmin(req);
    const rows = await app.db
      .select()
      .from(authProviders)
      .where(eq(authProviders.workspaceId, ws.id))
      .orderBy(asc(authProviders.name));
    return {
      providers: rows.map(toProvider),
      redirectUri: `${app.env.publicUrl}/api/auth/oidc/callback`,
    };
  });

  app.post('/auth-providers', async (req) => {
    const ws = requireAdmin(req);
    if (!app.keyring.available)
      throw badRequest('Set ORDO_SECRET_KEY before adding sign-in providers');
    const input = parse(createAuthProviderSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .insert(authProviders)
        .values({
          ...input,
          issuer: input.issuer.trim(),
          workspaceId: ws.id,
          clientSecret: 'pending',
        })
        .returning();
      // The secret is bound to the row id, so encrypt once the id exists.
      const [saved] = await ctx.tx
        .update(authProviders)
        .set({ clientSecret: app.keyring.encrypt(input.clientSecret, secretAad(row!.id)) })
        .where(eq(authProviders.id, row!.id))
        .returning();
      await auditCtx(ctx, {
        action: 'sso.provider_created',
        targetType: 'auth_provider',
        targetId: row!.id,
        data: { name: input.name, issuer: input.issuer },
      });
      return toProvider(saved!);
    });
  });

  app.patch('/auth-providers/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const input = parse(updateAuthProviderSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const { clientSecret, ...rest } = input;
      const [row] = await ctx.tx
        .update(authProviders)
        .set({
          ...rest,
          issuer: rest.issuer?.trim(),
          clientSecret: clientSecret ? app.keyring.encrypt(clientSecret, secretAad(id)) : undefined,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(authProviders.id, id), eq(authProviders.workspaceId, ws.id)))
        .returning();
      if (!row) throw notFound('Sign-in provider');
      await auditCtx(ctx, {
        action: 'sso.provider_updated',
        targetType: 'auth_provider',
        targetId: id,
        data: { ...rest, clientSecret: clientSecret ? 'changed' : undefined },
      });
      return toProvider(row);
    });
  });

  app.delete('/auth-providers/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .delete(authProviders)
        .where(and(eq(authProviders.id, id), eq(authProviders.workspaceId, ws.id)))
        .returning();
      if (row)
        await auditCtx(ctx, {
          action: 'sso.provider_deleted',
          targetType: 'auth_provider',
          targetId: id,
          data: { name: row.name },
        });
      return { ok: true };
    });
  });
}
