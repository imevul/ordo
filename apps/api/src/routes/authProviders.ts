import {
  type AuthProvider,
  createAuthProviderSchema,
  type SamlSettings,
  samlMetadataSchema,
  updateAuthProviderSchema,
} from '@ordo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authProviders } from '../db/schema.ts';
import { requireAdmin } from '../lib/auth.ts';
import { badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { auditCtx } from '../services/audit.ts';
import { secretAad } from '../services/oidc.ts';
import {
  certificateInfo,
  fetchIdpMetadata,
  normalizeCertificate,
  parseIdpMetadata,
} from '../services/saml.ts';

const toProvider = (p: typeof authProviders.$inferSelect): AuthProvider => ({
  id: p.id,
  name: p.name,
  protocol: p.protocol,
  issuer: p.issuer,
  clientId: p.clientId,
  scopes: p.scopes,
  saml: p.saml ? { ...p.saml, certificateInfo: p.saml.certificates.map(certificateInfo) } : null,
  trustEmail: p.trustEmail,
  enabled: p.enabled,
  defaultRole: p.defaultRole,
  groupClaim: p.groupClaim,
  groupRoles: p.groupRoles,
  createdAt: p.createdAt,
});

/** Certificates are stored as PEM, whichever way they were pasted. */
const cleanSaml = (saml: SamlSettings): SamlSettings => ({
  ...saml,
  idpEntityId: saml.idpEntityId.trim(),
  certificates: [...new Set(saml.certificates.map(normalizeCertificate))],
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
      // SAML addresses are per provider: see samlServiceProvider in shared.
      publicUrl: app.env.publicUrl,
    };
  });

  app.post('/auth-providers', async (req) => {
    const ws = requireAdmin(req);
    const input = parse(createAuthProviderSchema, req.body);
    if (input.protocol === 'oidc' && !app.keyring.available)
      throw badRequest('Set ORDO_SECRET_KEY before adding sign-in providers');
    return mutate(app, req, async (ctx) => {
      if (input.protocol === 'saml') {
        const { id, saml, ...rest } = input;
        if (id) {
          const [taken] = await ctx.tx
            .select({ id: authProviders.id })
            .from(authProviders)
            .where(eq(authProviders.id, id));
          if (taken) throw conflict('That provider id is taken');
        }
        const [row] = await ctx.tx
          .insert(authProviders)
          .values({ ...rest, ...(id && { id }), saml: cleanSaml(saml), workspaceId: ws.id })
          .returning();
        await auditCtx(ctx, {
          action: 'sso.provider_created',
          targetType: 'auth_provider',
          targetId: row!.id,
          data: { name: input.name, protocol: 'saml', idpEntityId: saml.idpEntityId },
        });
        return toProvider(row!);
      }
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
      const [current] = await ctx.tx
        .select({ protocol: authProviders.protocol })
        .from(authProviders)
        .where(and(eq(authProviders.id, id), eq(authProviders.workspaceId, ws.id)));
      if (!current) throw notFound('Sign-in provider');
      const { clientSecret, saml, ...rest } = input;
      const oidcOnly = rest.issuer ?? rest.clientId ?? rest.scopes ?? clientSecret;
      if (current.protocol === 'saml' ? oidcOnly : saml || rest.trustEmail !== undefined)
        throw badRequest("Those settings don't belong to this provider's protocol");
      const [row] = await ctx.tx
        .update(authProviders)
        .set({
          ...rest,
          issuer: rest.issuer?.trim(),
          clientSecret: clientSecret ? app.keyring.encrypt(clientSecret, secretAad(id)) : undefined,
          saml: saml ? cleanSaml(saml) : undefined,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(authProviders.id, id), eq(authProviders.workspaceId, ws.id)))
        .returning();
      await auditCtx(ctx, {
        action: 'sso.provider_updated',
        targetType: 'auth_provider',
        targetId: id,
        data: {
          ...rest,
          clientSecret: clientSecret ? 'changed' : undefined,
          saml: saml ? { idpEntityId: saml.idpEntityId, ssoUrl: saml.ssoUrl } : undefined,
        },
      });
      return toProvider(row!);
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

  /** Reads SAML settings from an IdP's metadata, pasted or fetched; nothing is saved. */
  app.post('/auth-providers/saml/metadata', async (req) => {
    requireAdmin(req);
    const input = parse(samlMetadataSchema, req.body);
    const xml = input.url ? await fetchIdpMetadata(app, input.url) : input.xml!;
    return { ...parseIdpMetadata(xml), metadataUrl: input.url ?? null };
  });
}
