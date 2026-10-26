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

## Request lifecycle

1. `onRequest` hook resolves the caller from the `ordo_session` cookie (SHA-256 of the token is the session id)
   or an `Authorization: Bearer ordo_…` API key.
2. Routes under `/api/w/:ws` run a `preHandler` that loads the workspace by slug and checks membership →
   `req.workspace = { id, slug, role }`. Non-members get 404, so workspace existence isn't leaked.
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
- Sessions: 32 random bytes in an `HttpOnly`, `SameSite=Lax` cookie; stored as SHA-256; 30-day sliding expiry.
- API keys: `ordo_` + 24 random bytes, stored as SHA-256, shown once.
- CSRF: `SameSite=Lax` cookies plus JSON-only bodies.
- Login/sign-up rate-limited; constant-time hash comparison runs even for unknown emails.
- Tenant isolation: every query filters by the workspace from the membership check.

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
