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
| `packages/sdk`    | `@ordo/sdk`: a typed client for the REST API (`Ordo`, `WorkspaceClient`) and `Names`, which turns team keys, status, label and user names into ids from a bootstrap.       |
| `packages/cli`    | The `ordo` command on top of the SDK. Bundled into one dependency-free file that the Docker image serves at `/cli/ordo.mjs`.                                               |

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

This keeps the protocol tiny and the server stateless, at the cost of a refetch per change.

### Change log

Offline-capable clients need to catch up on what they missed, so every published change is also logged in
`sync_changes` (`services/sync.ts`). At the end of each `runInWorkspace` transaction, its events are folded to one
entry per entity and numbered from the workspace's `sync_cursors` row. That `INSERT … ON CONFLICT DO UPDATE` is the
transaction's last statement and holds the row lock until commit, so numbers follow commit order with no gaps: once
change #7 is visible, so is #6. Entries hold only what changed (kind, id, action, the teams involved, and a user for
personal things like notifications), never data; clients load the current rows through the usual access checks.
Realtime events carry their `seq` and `epoch`.

- Everything clients hear about goes through `runInWorkspace` or `publishChanges()` (for changes made outside one);
  a test fails on any other `realtime.publish` call.
- An issue that moves team logs both teams (`prevTeamId`). Over the socket, people who could see only the old team
  get it as a deletion.
- Imports don't log their rows. When they finish (or fail, or are cancelled), and when a team is deleted, the
  workspace starts a new **epoch**: clients load everything again instead of replaying.
- The log keeps 30 days; `min_seq` says how far back it still goes.

### Sync clients

`packages/sync` is the client half, without React so the Phase 12 apps can share it. An `Engine` keeps one
workspace in memory and in a store (`IdbStore`: IndexedDB `ordo:<user>:<workspace>`, or `MemoryStore`). The first
time it loads `/sync/snapshot` and pages through `/sync/issues`; after that it reads `/sync/changes` whenever a
realtime event is ahead of it, the tab becomes visible or the browser comes back online, and starts over on `410
resync`. A changed bootstrap is loaded again, and issues of teams no longer in it are dropped.

In the web app (`src/sync/`), `SyncProvider` opens the engine when the instance's `offlineSync` setting and this
device allow it. `useIssues` answers from the copy whenever `matchIssue` can (everything but full-text search,
"subscribed by me", trash and archive, which stay online); a parity test in the API checks `matchIssue` against the
SQL filter with random filters. `useIssue` and `useComments` still ask the server but show the copy meanwhile and
offline, and the workspace's bootstrap falls back to the copy when the server can't be reached. Only one tab talks
to the server: it holds a Web Lock and shares what it saves over a `BroadcastChannel`. Signing out deletes every
copy on the device.

Changes go into an outbox (`outbox.ts`): typed operations for creating, editing and trashing issues, comments,
reactions and relations, each one REST call, with ids chosen on the client so a retry can't duplicate anything.
They show at once: the engine keeps the server's issues apart from the queue and shows the one on top of the
other, so changes arriving from the server slide in underneath what's still waiting. The leading tab sends them
in order as soon as it can; while the server can't be reached it backs off (1 s, 2 s, … a minute), and without a
session it stops until someone signs in. A change the server refuses (4xx) is dropped from view along with
anything that needed it (a comment on an issue that couldn't be created), and listed under the sidebar's
"unsaved" with its text, to copy or discard. Settings, admin and everything else stay online-only.

Starting offline: the build writes `precache.json` (every file in `assets/`), and the service worker caches all of
it when it installs, so any screen opens without a connection, and drops files of earlier builds when the next one
activates. `useConfig` and `useMe` fall back to their last answers (the signed-in person is remembered only on
devices that keep a copy, and forgotten at sign-out); React Query runs queries and mutations even when the browser
says it's offline, so they reach those fallbacks and the outbox. A banner says when the server can't be reached;
attachments, AI assistance and settings say they need a connection. The copy asks for persistent storage, and if
the device runs out of space it carries on in memory for the rest of the tab, with a notice.

How it scales (`test/sync-load.test.ts`, run with `ORDO_BENCH=1`; one laptop, test database): a workspace of
50,000 issues loads in about a second (snapshot and 50 pages of 1,000, 15–30 ms each), "my open issues" filters
in 10 ms, catching up on 100 changes takes 20 ms, and a local change shows and is sent in 20 ms. The paging query
needs current planner statistics: right after a bulk insert it took 750 ms a page, so imports `ANALYZE issues` when
they finish, just before their new epoch sends clients to reload.

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
  every identifier.
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
- SSO (`services/sso.ts`, `routes/sso.ts`): the protocols prove who someone is, and the shared core (`resolveSsoUser`,
  `finishSso`) decides which account that is. The state lives in `auth_states` (single use, 10 minutes) and in a short
  `HttpOnly` cookie, so a sign-in must come back to the browser that started it.
  - OpenID Connect (`services/oidc.ts`): `openid-client` with PKCE (S256) and a nonce; `response_mode=query` only.
    Discovery and token requests go through `safeFetch`.
  - SAML 2.0 (`services/saml.ts`): `@node-saml/node-saml`, SP-initiated only (the AuthnRequest's ID is kept on the
    state, and the response must answer it). The response is a cross-site POST without our `SameSite=Lax` cookies,
    so the ACS validates it, parks the claims on the state and 303-redirects to a GET that has the cookie and finishes.
    Identity is read only from the verified assertion; Issuer, Destination and Recipient are checked on top of the
    library's signature, time, audience and InResponseTo checks; any DOCTYPE is refused.
    Accounts are created or matched by email only for trusted emails (OIDC `email_verified`, or SAML with the provider's
    "trust emails" on) at the workspace's verified domains; otherwise identities are linked explicitly. Require-SSO is checked in `authorizeWorkspace` (HTTP and WebSocket):
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

### Forges

`services/forge.ts` holds what GitHub, GitLab and Forgejo share. Providers (`integrations/github.ts`,
`gitlab.ts`, `forgejo.ts`) only translate payloads and API calls into `ForgePullRequest`, `ForgeCommit` and
`ForgeBranch`; `applyPullRequest` / `applyCommits` / `applyBranch` then parse identifiers and magic words, resolve them
through team keys and `team_key_aliases`, upsert `issue_links`, and call `automate`, which moves an issue only to a
status further along (by status type, then position). Each provider supports webhooks (hooks it creates on install
and removes on uninstall; `install` reconciles, so it reruns after settings change) and polling with cursors kept in
`integrations.state`. The GitHub App lives in `integration_apps`: its private key signs a JWT for short-lived
installation tokens, and its single webhook URL resolves to integrations by installation id.

### Chat and long-lived connections

`services/chat.ts` holds what Slack, Discord, Matrix and Telegram share; providers (`integrations/slack.ts`,
`discord.ts`, `matrix.ts`, `telegram.ts`) translate payloads into a `ChatIncoming` and render a `ChatMessage`
through their `chat` adapter (`post`, `direct`, `linkHint`).

- **Feeds**: `chatFeed` (a provider's `onDomainEvent`) turns an event into one `chat.post` job per subscribed channel,
  so a failing channel retries alone. Channels without teams only get public teams.
- **Accounts**: a code from `createLinkCode` (an `auth_tokens` row of kind `chat_link`, stored hashed, 15 minutes)
  sent from a chat account proves both sides; it becomes an `external_accounts` row with `integration_id` and
  `verified_at`. Only verified accounts act as their user (`chatActor`, with that user's computed access) or get
  direct messages: `notify()` queues a `chat.notify` job per linked account, which re-checks team access before
  sending.
- **Synchronous answers**: `ackInbound` lets a provider answer inside the webhook request (Slack's URL challenge,
  Discord's ping and deferred response); the real answer follows from the job (Slack `response_url`, Discord's
  interaction webhook).
- **Connections** (`services/connectors.ts`): providers with `connect` (Slack Socket Mode, the Discord gateway,
  Telegram long polling, Matrix `/sync`) run under the supervisor. Every 10 s each server takes or renews a lease
  (`leases`, `connector:<integration id>`, 45 s) per wanted connection, starts what it holds, stops what it lost or
  what changed (`updated_at`), and restarts failed ones with backoff. Connections hand deliveries to the same
  `integration.inbound` queue as webhooks, with the same idempotency keys, so a takeover can't double-process.

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
