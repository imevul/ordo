import type { ForgeRepository, IntegrationProviderInfo, WebhookPayload } from '@ordo/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import type { integrations } from '../db/schema.ts';
import type { Ctx } from '../services/context.ts';

export type IntegrationRow = typeof integrations.$inferSelect;
export type Secrets = Record<string, string>;

/** An integration's settings as stored: `config` in the clear, `secrets` encrypted. */
export interface IntegrationSettings {
  config: Record<string, unknown>;
  secrets: Secrets;
}

/**
 * Reads an integration's config as its provider's settings schema made it. Not parsed again:
 * config only gets into the table through that schema (or a provider's own install flow).
 */
export const configOf =
  <C>() =>
  (row: IntegrationRow) =>
    row.config as C;

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

/**
 * An answer a provider must give inside the webhook request itself (Slack's URL challenge,
 * Discord's interaction ack). `process: false` answers without queueing the delivery.
 */
export interface InboundAck {
  status?: number;
  body?: unknown;
  process?: boolean;
}

/** What a long-lived connection hands back: deliveries, processed like inbound webhooks. */
export interface ConnectionIO {
  deliver(req: InboundRequest): Promise<void>;
  /** Call once connected: clears an earlier connection error. */
  connected(): Promise<void>;
  /** Aborted when the lease is lost, the integration changes or the server stops. */
  signal: AbortSignal;
}

/** A message posted to chat, rendered by each provider in its own format. */
export interface ChatMessage {
  /** What happened, plain text: "Ada moved ENG-12 to Done". */
  headline: string;
  /** The thing it happened to, linked to `url`: "ENG-12 Fix the flux capacitor". */
  title?: string;
  url?: string;
  /** An excerpt (a comment, a description), plain text. */
  body?: string;
  /** A footnote: "Todo · High · Bob". */
  context?: string;
  /** Accent for providers with coloured cards. */
  color?: string;
}

/** A chat account as providers need it to message someone privately. */
export interface ChatRecipient {
  externalId: string;
  dmChannel?: string;
}

/** A thread inside a channel: the one started by the message `root`. */
export interface ChatThread {
  root: string;
  /** For services that name threads (Discord): "ENG-12 Fix the flux capacitor". */
  name: string;
}

/** What chat providers add: posting to channels and to people. */
export interface ChatAdapter {
  /** Posts to a channel, or into a thread there; returns the posted message's id. */
  post(
    ictx: IntegrationContext,
    channel: string,
    message: ChatMessage,
    thread?: ChatThread,
  ): Promise<string | undefined>;
  /** Messages one person; returns the direct-message channel to remember, when it opened one. */
  direct(
    ictx: IntegrationContext,
    to: ChatRecipient,
    message: ChatMessage,
  ): Promise<string | undefined>;
  /** How people send their link code, shown under Account → Connected accounts. */
  linkHint(integration: IntegrationRow): string;
}

/** A domain event as integrations see it: the webhook payload plus the teams it belongs to. */
export type IntegrationEvent = WebhookPayload & { teamIds: string[] };

/**
 * An outside service. Every hook is optional: forges mostly receive webhooks, chat apps mostly
 * react to domain events, and private instances poll instead of receiving.
 */
export interface IntegrationProvider extends IntegrationProviderInfo {
  /**
   * What an admin enters when connecting by hand: a shared schema (`@ordo/shared` integrations.ts)
   * that validates and normalises it. The route parses with it, so invalid settings are a 400
   * naming the field, and `integration.config` always has the schema's output shape.
   */
  settings?: ZodType<IntegrationSettings>;
  /** After `settings` parsed: what only the server does (generating a webhook secret). Throw to reject. */
  configure?(input: IntegrationSettings): IntegrationSettings;
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
  /**
   * Answers a URL handshake before any integration is looked up: a shared app URL is checked by
   * the service as soon as the app is registered, when no integration uses it yet.
   */
  challenge?(app: FastifyInstance, key: string, req: InboundRequest): Promise<InboundAck | null>;
  /** Checks the request's signature against the raw body. False → 401. */
  verify?(req: InboundRequest, integration: IntegrationRow, secrets: Secrets): boolean;
  /** Idempotency key for a delivery (e.g. `X-GitHub-Delivery`); defaults to a hash of the body. */
  deliveryId?(req: InboundRequest): string | null;
  /** Answers the webhook request synchronously, before (or instead of) queueing it. */
  ackInbound?(
    req: InboundRequest,
    integration: IntegrationRow,
    secrets: Secrets,
  ): InboundAck | null;
  /** Processes an inbound delivery, in a job. */
  handleInbound?(ictx: IntegrationContext, req: InboundRequest): Promise<void>;

  /** Every domain event of the workspace, except the ones this integration caused. */
  onDomainEvent?(ictx: IntegrationContext, event: IntegrationEvent): Promise<void>;

  /**
   * For services with user accounts (forges, chat): the host people's usernames belong to, so
   * they can claim them under Account → Connected accounts and get credit for their work.
   */
  accountHost?(integration: IntegrationRow): string;

  /**
   * For forges: repositories the integration's credentials can see, matching `query` (a
   * substring of owner/name) when given, so admins can pick one instead of typing its URL.
   */
  listRepositories?(ictx: IntegrationContext, query?: string): Promise<ForgeRepository[]>;

  /**
   * A long-lived connection (a socket, a long poll) for services that can't reach this instance.
   * Runs on one server at a time under a lease, restarted with backoff when it ends or throws.
   */
  connect?(ictx: IntegrationContext, io: ConnectionIO): Promise<void>;
  /** Whether this integration, as configured, wants `connect` running. */
  wantsConnection?(integration: IntegrationRow): boolean;

  chat?: ChatAdapter;

  /** For services that can't reach this instance: fetch what changed. */
  poll?(ictx: IntegrationContext): Promise<void>;
  pollIntervalSeconds?: number;
}
