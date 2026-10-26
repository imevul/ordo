import type { IntegrationProviderInfo, WebhookPayload } from '@ordo/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { integrations } from '../db/schema.ts';
import type { Ctx } from '../services/context.ts';

export type IntegrationRow = typeof integrations.$inferSelect;
export type Secrets = Record<string, string>;

/** A raw inbound webhook request, exactly as received (signatures cover the raw body). */
export interface InboundRequest {
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
}

/** What a provider gets to work with for one integration. */
export interface IntegrationContext {
  app: FastifyInstance;
  integration: IntegrationRow;
  secrets: Secrets;
  log: FastifyBaseLogger;
  /** Runs `fn` in the integration's workspace as its bot, with source `integration:<id>`. */
  run<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T>;
  /** Merges into the integration's persisted state (polling cursors and the like). */
  saveState(patch: Record<string, unknown>): Promise<void>;
}

/** A domain event as integrations see it: the webhook payload plus the teams it belongs to. */
export type IntegrationEvent = WebhookPayload & { teamIds: string[] };

/**
 * An outside service. Every hook is optional: forges mostly receive webhooks, chat apps mostly
 * react to domain events, and private instances poll instead of receiving.
 */
export interface IntegrationProvider extends IntegrationProviderInfo {
  /** Validates and normalises what an admin entered when connecting by hand. Throw to reject. */
  configure?(input: { config: Record<string, unknown>; secrets: Record<string, unknown> }): {
    config: Record<string, unknown>;
    secrets: Secrets;
  };
  /** After the integration is created (e.g. register remote webhooks). */
  install?(ictx: IntegrationContext): Promise<void>;
  /** Before it's deleted (e.g. remove remote webhooks). Failures are logged, not fatal. */
  uninstall?(ictx: IntegrationContext): Promise<void>;

  /**
   * Inbound webhooks arrive at `/api/hooks/<provider>/<key>`. By default `key` is the
   * integration's `inboundToken`; providers with one URL for many installations (a GitHub App)
   * resolve the integrations themselves.
   */
  resolveInbound?(
    app: FastifyInstance,
    key: string,
    req: InboundRequest,
  ): Promise<IntegrationRow[]>;
  /** Checks the request's signature against the raw body. False → 401. */
  verify?(req: InboundRequest, integration: IntegrationRow, secrets: Secrets): boolean;
  /** Idempotency key for a delivery (e.g. `X-GitHub-Delivery`); defaults to a hash of the body. */
  deliveryId?(req: InboundRequest): string | null;
  /** Processes an inbound delivery, in a job. */
  handleInbound?(ictx: IntegrationContext, req: InboundRequest): Promise<void>;

  /** Every domain event of the workspace, except the ones this integration caused. */
  onDomainEvent?(ictx: IntegrationContext, event: IntegrationEvent): Promise<void>;

  /** For services that can't reach this instance: fetch what changed. */
  poll?(ictx: IntegrationContext): Promise<void>;
  pollIntervalSeconds?: number;
}
