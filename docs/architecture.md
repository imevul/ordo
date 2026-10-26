# Architecture

## Overview

```
 browser ── HTTPS ──▶ ordo app container (Node 26)
   │                   ├─ Fastify: /api/* JSON routes
   │                   ├─ /api/ws WebSocket ◀── LISTEN ordo_events
   └── static SPA ◀────┤─ static files + SPA fallback (apps/web/dist)
                       └─ Drizzle ORM ── SQL ──▶ PostgreSQL 18 ── NOTIFY ordo_events
```

One process serves the API, the WebSocket and the built web app. Postgres is the only dependency: it stores
everything and also carries realtime events between API instances.

## Repository layout

| Path              |                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Domain constants (state types, priorities, estimate scales), Zod request schemas, response types, realtime event type, sort helpers. Consumed as TypeScript source.        |
| `apps/api`        | Fastify server. `app.ts` wires plugins and routes; `routes/` are thin HTTP handlers; `services/` hold domain logic; `db/` has the schema, migrations runner and demo seed. |
| `apps/web`        | React SPA. `router.tsx` (TanStack Router, code-based), `api/` (fetch + React Query + socket), `components/`, `routes/` (pages), `lib/` (context, hotkeys, store).          |

## Access control

`services/access.ts` turns a user's workspace role and team memberships into an `Access` object:
readable team ids, administered team ids, and flags (`isOwner`, `isAdmin`, `isGuest`). It is computed once per
request in `authorizeWorkspace` (shared by HTTP routes and the WebSocket) and carried on `req.workspace.access`
and `ctx.access`. Every query helper takes it:

- `teamScope(access, column)` adds `team_id in (…)` (nothing for admins) — used by issue filters, `getIssue`,
  progress counts, cycles, labels and notifications.
- `assertTeamAccess(access, teamId, 'read' | 'admin')` guards writes; unreadable teams are reported as 404.
- `can(access, action)` covers workspace-level actions (guests can't create teams, projects, views, labels).
- `usersWithTeamAccess` filters notification recipients and @mentions.

Realtime clients keep their own `Access`, drop events for teams they can't read, and re-check (or are disconnected)
when team or membership events arrive. `test/access.test.ts` runs a role × endpoint matrix and a route inventory
that fails when a new workspace route isn't accounted for.

## Request lifecycle

1. `onRequest` hook resolves the caller from the `ordo_session` cookie (SHA-256 of the token is the session id)
   or an `Authorization: Bearer ordo_…` API key.
2. Routes under `/api/w/:ws` run a `preHandler` (`authorizeWorkspace`) that loads the workspace by slug, checks
   membership and computes access → `req.workspace = { id, slug, role, access }`. Non-members get 404, so
   workspace existence isn't leaked.
3. Handlers validate input with shared Zod schemas (`parse()`), then call services.
4. Writes run inside `mutate()`: one transaction, a `Ctx` carrying `{ tx, userId, workspaceId, events }`.
   Services push `RealtimeEvent`s with `emit()`; they're published only after commit.
5. Errors are `HttpError`s rendered as `{ error, message, details }`.

## Realtime

`Realtime.publish()` sends events with `NOTIFY ordo_events, '<json array>'` (batched under the 8 KB payload
limit). Every API instance `LISTEN`s on that channel and forwards each event to its WebSocket clients for that
workspace (or a single user for notifications/favorites). Clients treat events as cache-invalidation hints:
`useRealtime()` coalesces a burst into one round of React Query invalidations and refetches what's on screen.
On reconnect it invalidates the whole workspace cache.

This keeps the protocol tiny and the server stateless, at the cost of a refetch per change. A local-first sync
engine (Linear-style) is on the roadmap.

## Data model

```
workspaces ─┬─ workspace_members ── users ── sessions, api_keys
            ├─ invites
            ├─ teams ─┬─ team_members
            │         ├─ workflow_states (type: triage|backlog|unstarted|started|completed|canceled)
            │         └─ cycles (number per team)
            ├─ labels (team_id nullable = workspace label)
            ├─ projects ── project_teams, project_updates
            ├─ issues ─┬─ issue_labels
            │          ├─ issue_relations (blocks | related | duplicate)
            │          ├─ issue_subscribers
            │          ├─ issue_history (jsonb list of {field, from, to})
            │          └─ comments (parent_id for threads)
            ├─ notifications (per user)
            ├─ views (filters + display as jsonb)
            └─ favorites (per user)
```

Notable choices:

- **Identifiers** are `team.key + '-' + issue.number`, computed on read. `teams.issue_counter` is incremented
  atomically (`UPDATE … RETURNING`) when an issue is created or moved into the team. Renaming a team key renames
  every identifier, like Linear.
- **Ordering** uses a float `sort_order`; inserting between neighbours takes the midpoint
  (`sortOrderBetween`), so a reorder updates one row.
- **Status timestamps** (`started_at`, `completed_at`, `canceled_at`) are maintained from the status type on
  every transition.
- **Relations** are stored once and mirrored on read (`blocks` ↔ `blocked_by`, `duplicate` ↔ `duplicate_of` /
  `duplicated_by`).
- **Soft delete**: `issues.deleted_at` is the trash. Purging hard-deletes and detaches sub-issues.
- **History** is append-only rows with a jsonb array of changes; the client renders them.
- **Progress** for projects and cycles is a grouped count over issues joined to state types — no
  denormalized counters to drift.
- **Timestamps** use a custom `timestamptz` column type that always returns ISO-8601 strings.

## Security

- Stored secrets: AES-256-GCM via `Keyring` (`lib/secrets.ts`), keyed by `ORDO_SECRET_KEY` through HKDF subkeys,
  bound to their row and column with associated data; `ORDO_SECRET_KEY_PREVIOUS` supports rotation.
- Audit log: `audit_log` rows written in the same transaction as the change (`services/audit.ts`).
- Outbound requests to admin-supplied URLs go through `safeFetch`, which checks every redirect and validates the
  resolved address at connect time (no DNS rebinding) against loopback/private/link-local ranges.
- Cross-site writes: besides `SameSite=Lax` cookies and JSON-only bodies, state-changing cookie requests with
  `Sec-Fetch-Site: cross-site` or a foreign `Origin` are rejected (`rejectCrossSite` in `app.ts`).
- Instance settings (`services/settings.ts`): env → `instance_settings` table → default, cached per instance and
  reloaded on `NOTIFY ordo_settings`.
- Passwords: Node's built-in scrypt (N=2¹⁵, r=8, p=1) — no native modules.
- Two-factor: TOTP (RFC 6238, ±1 step), secret encrypted with the keyring; ten single-use recovery codes stored as
  hashes. Logging in with 2FA returns a short-lived `mfa` token instead of a session; `POST /auth/mfa` completes it.
- Email links (reset, verification, email change) are single-use tokens stored as hashes in `auth_tokens` with short
  expiries; a reset signs out every session.
- SSO (`services/sso.ts`, `routes/sso.ts`): OpenID Connect via `openid-client` with PKCE (S256) and a nonce; the
  state lives in `auth_states` (single use, 10 minutes) and in a short `HttpOnly` cookie, so a callback must come back
  to the browser that started it; `response_mode=query` only. Discovery and token requests go through `safeFetch`.
  Accounts are created or matched by email only for `email_verified` addresses at the workspace's verified domains;
  otherwise identities are linked explicitly. Require-SSO is checked in `authorizeWorkspace` (HTTP and WebSocket):
  the session's `auth_provider_id` must belong to the workspace; owners pass (password sign-ins are audited as
  `auth.sso_bypass`); `sso_expires_at` caps SSO session length in `resolveUser`.
- Sessions: 32 random bytes in an `HttpOnly`, `SameSite=Lax` cookie; stored as SHA-256; 30-day sliding expiry.
- API keys: `ordo_` + 24 random bytes, stored as SHA-256, shown once.
- CSRF: `SameSite=Lax` cookies plus JSON-only bodies.
- Login/sign-up rate-limited; constant-time hash comparison runs even for unknown emails.
- Tenant isolation: every query filters by the workspace from the membership check.

## Events, webhooks and integrations

- **Outbox** (`services/events.ts`): services call `record(ctx, type, data, { teamIds, changes })` next to
  `emit(...)`. `emit` is a cache hint for open browsers; `record` is the durable, public description of the change.
  `runInWorkspace` writes the recorded events to `domain_events` at the end of the transaction, plus **one**
  `events.dispatch` job ordered per workspace, so a rollback leaves nothing and consumers see commit order. Silent
  contexts (imports) record nothing.
- **Dispatch** fans out to webhook deliveries (`webhook_deliveries`, one `webhook.deliver` job each, payload stored
  so redeliveries are identical) and to `integration.event` jobs (ordered per integration, deduplicated by event).
  An integration never receives events whose `source` is itself.
- **Integration framework** (`integrations/types.ts`, `services/integrations.ts`): a provider may implement
  `configure`, `install`/`uninstall`, `verify` + `deliveryId` + `handleInbound` (webhooks at
  `/api/hooks/<provider>/<key>`, raw bodies up to 25 MB, answered 202 and processed in a job), `onDomainEvent`, and
  `poll` (scheduled per `pollIntervalSeconds`, for instances that can't receive webhooks). Each integration has an
  encrypted secrets blob, a bot user (`users.kind = 'bot'`, not a workspace member) that its changes are
  attributed to, a status and last error. `issue_links` holds PRs, branches, commits and messages per issue;
  `external_accounts` maps provider users to Ordo users.

## Background work

`lib/jobs` is a job queue on Postgres itself (no Redis):

- `enqueue(tx, name, payload, opts)` inserts in the caller's transaction, so a job exists only if the change
  committed; `pg_notify('ordo_jobs')` wakes idle workers on commit.
- Every API instance runs workers that claim jobs with a short `UPDATE … FOR UPDATE SKIP LOCKED`, run them outside a
  transaction, delete them on success and retry with exponential backoff on failure, finally marking them `dead`.
- `orderingKey` serialises related jobs (oldest first); `dedupeKey` makes enqueueing idempotent.
- `jobs.every(name, seconds)` schedules recurring work; whichever instance advances the schedule row runs it.
- `Leases` (with fencing tokens) keep singleton work — long-lived bot connections — on one instance.

Jobs are registered in `src/jobs.ts`: email delivery, notification digests (every minute) and cleanup (hourly).

## Email and files

- `Mailer` sends through nodemailer using the SMTP setting (env or encrypted in the database); `queueEmail(tx, …)`
  delivers via the job queue. Templates (`services/mail-templates.ts`) are inline-styled Hotline Pink HTML with a
  plain-text twin.
- `Storage` (`lib/storage`) is local disk or S3-compatible (a built-in SigV4 signer, no SDK). Uploads are
  recorded in `files`; images are identified by their bytes, never the client's claim, and served from
  `/api/files/:id` with an HMAC-signed, expiring URL, `nosniff`, a sandboxing CSP, and `attachment` disposition for
  anything that isn't an image.

## Frontend

- **Bootstrap**: on entering a workspace, `/bootstrap` loads everything small (members, teams + statuses, labels,
  projects, cycles, views, favorites) into `WorkspaceProvider`, with id → entity maps. Issues load per screen via
  `POST /issues/query`.
- **IssuesView** is the one component behind every issue screen: it merges the screen's fixed filter with the
  user's filter chips, queries, groups (`lib/issues.ts`), renders `IssueList` or `IssueBoard`, and owns focus,
  selection, bulk actions and keyboard handling.
- **Optimistic updates**: `useUpdateIssue` patches every cached list and detail before the request, then
  invalidates on settle.
- **Keyboard**: a single global `keydown` listener (`lib/hotkeys.ts`) with scopes (app → popover/modal/palette)
  and two-key sequences.
- **Command palette** pages reuse the same option builders as the property pickers (`components/properties.tsx`).

## Build & deploy

`pnpm build` runs Vite for the web app and esbuild for the API (one ESM file plus `seed.mjs`). The Docker
image copies those, the SQL migrations and nothing else onto `node:26-alpine` (~270 MB). Migrations run on
boot via Drizzle's migrator.
