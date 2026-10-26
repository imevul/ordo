# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working on Ordo. Read this before changing code.

## What this is

Ordo is a self-hostable, Linear-style issue tracker. TypeScript pnpm monorepo:

```
apps/api/          Fastify API + realtime. Entry: src/index.ts, wiring: src/app.ts
  src/db/          schema.ts (Drizzle, source of truth), migrate.ts, seed.ts
  src/routes/      one file per resource, all registered under /api/w/:ws (workspace-scoped)
  src/services/    domain logic (issues.ts is the heart), Ctx + emit() for realtime
  src/lib/         auth, errors, crypto, mutate() transaction helper
  drizzle/         generated SQL migrations — never edit by hand
  test/            Vitest integration tests against a real Postgres
apps/web/          React SPA
  src/api/         fetch client, React Query hooks (queries.ts), realtime socket
  src/components/  shared UI (IssuesView, IssueList, IssueBoard, CommandPalette, properties.tsx pickers…)
  src/routes/      pages; router.tsx defines every route
  src/lib/         workspace context, hotkeys, UI store, issue grouping
  src/styles/      app.css — Hotline Pink tokens + component classes
packages/shared/   Zod schemas, API types, constants — imported by both apps as TS source
docs/              user, operator and developer docs
```

## Commands

```bash
make dev-db                 # Postgres for dev/tests on localhost:5433 (docker-compose.dev.yml)
pnpm dev                    # API :3001 (tsx watch) + web :5173 (Vite, proxies /api and /api/ws)
pnpm typecheck              # tsc (TypeScript 7) in every package
pnpm test                   # Vitest; API tests recreate an `ordo_test` database
pnpm lint / pnpm format     # Biome
pnpm db:generate            # after editing apps/api/src/db/schema.ts → new file in apps/api/drizzle/
pnpm db:seed                # demo workspace "demo", login demo@ordo.test / ordo-demo-password
pnpm build                  # web → apps/web/dist, API → apps/api/dist/server.mjs (+ seed.mjs)
make check-bundle           # boots the built API with no node_modules (CI runs this too)
```

Before you finish: `pnpm typecheck && pnpm test && pnpm lint` must pass.

## Conventions

- **Validate at the edge with shared Zod schemas.** Request bodies are parsed with `parse(schema, req.body)`
  (`apps/api/src/lib/errors.ts`). Add new payload schemas to `packages/shared/src/schemas.ts` so the web client
  can reuse them. Response shapes live in `packages/shared/src/types.ts`.
- **Every workspace route is tenant- and team-scoped.** Routes under `/api/w/:ws` get `req.workspace` (with
  `access`) from `authorizeWorkspace`. Every query must filter by `workspaceId` **and** by team access: use
  `teamScope(access, column)` in queries, `assertTeamAccess` before writes, `can(access, action)` for
  workspace-level actions, and `requireAdmin` / `requireOwner` for admin areas. Never compare roles as strings
  (`isAdminRole` in shared). New `/api/w/*` routes must be added to the matrix or allowlist in
  `test/access.test.ts`, which fails otherwise.
- **Mutations go through `mutate(app, req, async (ctx) => …)`**, or `runInWorkspace(app, opts, fn)` when there is
  no request (jobs, webhooks, imports). Both open a transaction and give you a `Ctx` (`tx`, `userId`,
  `workspaceId`, `events`, `source`, `silent`, `meta`), then publish realtime events after commit. Call
  `emit(ctx, { kind, action, id, teamId? })` for anything clients should refetch. `source` says who caused the
  change (`web`, `api`, `system`, `import`, `integration:<id>`); `silent` suppresses notifications.
- **Audit security-relevant actions** with `audit(tx, entry, meta)` / `auditCtx(ctx, entry)`
  (`services/audit.ts`) in the same transaction as the change. Add new action names to `AUDIT_ACTIONS` in shared.
- **Secrets at rest** (tokens, client secrets) are encrypted with `app.keyring.encrypt(value, 'table:id:column')`.
  Never store them in plain text and never return them from the API.
- **Outbound requests to URLs a user typed** must use `safeFetch` (`lib/safeFetch.ts`) with
  `allowPrivate: app.settings.get('allowPrivateNetworkTargets')`. Plain `fetch` is only for fixed, well-known hosts.
- **Instance settings** come from `app.settings.get(key)` (env → DB → default), never from `app.env` directly.
- **Background work** goes through the job queue: `enqueue(ctx.tx, name, payload)` inside the transaction, with the
  handler registered in `src/jobs.ts` (`app.jobs.define` / `app.jobs.every`). Handlers must be idempotent (jobs
  retry). Send email with `queueEmail(tx, to, template(...))`, never `app.mailer.send` from a request. Tests run jobs
  with `await app.jobs.drain()` and capture mail with `captureMail(app)`.
- **Uploads** go through `saveFile` (`services/files.ts`) and are exposed only via `signedFileUrl`. Never serve user
  files from the web root or trust a client-supplied content type.
- **Only enabled humans authenticate.** `users.kind` is `human | bot | placeholder`; `disabled_at` blocks sign-in and
  kills sessions. Authors and creators are nullable (deleted users).
- **Issue changes go through `services/issues.ts`** (`createIssue`, `updateIssue`, `trashIssue`). They handle
  numbering, state timestamps, history, subscriptions and notifications. Do not update the `issues` table
  directly from routes.
- **Schema changes:** edit `schema.ts`, run `pnpm db:generate --name <what>`, commit the generated SQL. Data
  backfills go in a separate `pnpm exec drizzle-kit generate --custom --name <what>` file, with a test in
  `test/migrations.test.ts`. Stop `pnpm dev` while writing a custom migration: the watcher restarts the
  API, which applies the still-empty generated file and records it as done.
  Migrations run automatically on boot. Only `import type` from `@ordo/shared` inside `schema.ts`.
- **Timestamps** are ISO-8601 strings everywhere (custom `timestamptz` column type). Calendar dates
  (`dueDate`, cycle dates) are `YYYY-MM-DD` strings.
- **Imports use explicit `.ts`/`.tsx` extensions** (`allowImportingTsExtensions`).
- **Web data flow:** read with the hooks in `src/api/queries.ts`; write with `useUpdateIssue` /
  `useWsMutation`. Realtime events only invalidate caches — never push data through the socket.
- **Keyboard:** register shortcuts with `useHotkey` (`src/lib/hotkeys.ts`). Modals push a scope via
  `useHotkeyScope` so page shortcuts don't fire underneath. Document new shortcuts in
  `components/ShortcutsHelp.tsx` and `docs/keyboard-shortcuts.md`.
- **Design:** use the Hotline Pink tokens and classes in `app.css` (`panel`, `btn btn-primary|ghost|danger`,
  `prop`, `tag`, `chip`, `section-label`, `kicker`, `menu-item`, `nav-item`). No rounded corners. Pink is for
  small, sharp accents; cyan only for focus rings and tiny highlights. See `docs/design.md`.
- **Style:** Biome formatting (single quotes, semicolons, 100 cols). Comments explain _why_, sparingly.

## Testing

API tests in `apps/api/test/api.test.ts` drive the real app through `app.inject` with a cookie-carrying
`Client` (`test/helpers.ts`). Add a test for every new endpoint or rule. Shared logic gets unit tests next to
the source (`*.test.ts`). The web app has no unit tests yet; verify UI changes in a browser with `pnpm dev`.

## Gotchas

- `pnpm` 12 blocks dependency build scripts unless listed under `allowBuilds` in `pnpm-workspace.yaml`.
- The production image contains only `server.mjs`, `seed.mjs`, `drizzle/` and the web build — anything the API
  needs at runtime must be bundleable by esbuild (no native modules; passwords use Node's built-in scrypt).
- Realtime fan-out uses Postgres `NOTIFY` (8 KB payload cap); `Realtime.publish` batches events under that.
- Workspace URL slugs and team keys appear in URLs and identifiers — changing them breaks old links.

## Where to look first

| Task               | Start in                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| New issue field    | `schema.ts` → `types.ts`/`schemas.ts` in shared → `services/issues.ts` → `properties.tsx` |
| New page           | `apps/web/src/router.tsx`, then a file in `src/routes/`                                   |
| New API resource   | a route file in `apps/api/src/routes/`, register it in `app.ts`, add tests                |
| Notifications      | `services/notifications.ts`, inbox UI in `routes/inbox.tsx`                               |
| Filters / grouping | `filterConditions` in `services/issues.ts`, `lib/issues.ts`, `components/FilterBar.tsx`   |

See [ROADMAP.md](ROADMAP.md) for planned work.
