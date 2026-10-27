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
packages/sdk/      @ordo/sdk: typed REST client + name resolution (Names) — used by the CLI
packages/cli/      the `ordo` command; bundled to one file, served by instances at /cli/ordo.mjs
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
pnpm build                  # web → apps/web/dist, CLI → packages/cli/dist/ordo.mjs, API → apps/api/dist/server.mjs
pnpm ordo <command>         # the CLI from source (see docs/cli.md)
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
- **Instance-admin endpoints** live in `routes/admin.ts` under `/api/admin`, guarded by `isInstanceAdmin` in a
  plugin-level hook. Workspace membership changes go through `joinWorkspace` (`services/workspaces.ts`).
- **Correlated subqueries**: name the outer table explicitly (`"issues"."id"`), not `${issues.id}` — Drizzle leaves
  columns unqualified in single-table selects, so a bare `"id"` binds to the subquery's own table.
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
- **Text editing:** `MarkdownEditor` is the one editor for long text: rich text (TipTap, `RichTextEditor.tsx`) or
  Markdown source, chosen per browser. Markdown is the storage format, so the rich editor's schema
  (`lib/richtext.ts`) holds only what GFM can store; extend it there and add a case to `richtext.test.ts`, which
  checks that every document round-trips and loads.
- **Keyboard:** register shortcuts with `useHotkey` (`src/lib/hotkeys.ts`). Modals push a scope via
  `useHotkeyScope` so page shortcuts don't fire underneath. Document new shortcuts in
  `components/ShortcutsHelp.tsx` and `docs/keyboard-shortcuts.md`.
- **Design:** use the Hotline Pink tokens and classes in `app.css` (`panel`, `btn btn-primary|ghost|danger`,
  `prop`, `tag`, `chip`, `section-label`, `kicker`, `menu-item`, `nav-item`). No rounded corners. Pink is for
  small, sharp accents; cyan only for focus rings and tiny highlights. Workspaces can change the accent, so never
  hard-code its hex values — use the tokens (`bg-primary`, `text-on-primary`, `accent-primary`). See `docs/design.md`.
- **Style:** Biome formatting (single quotes, semicolons, 100 cols). Comments explain _why_, sparingly.

## Testing

API tests in `apps/api/test/api.test.ts` drive the real app through `app.inject` with a cookie-carrying
`Client` (`test/helpers.ts`). Add a test for every new endpoint or rule. Shared logic gets unit tests next to
the source (`*.test.ts`). The web app has unit tests only for pure logic (`src/lib/*.test.ts`); verify UI changes in a browser with
`pnpm dev`.
SSO tests run against an in-process OpenID provider (`test/mock-idp.ts`: discovery, PKCE-checking token endpoint,
RS256 ID tokens); set `idp.next` to the claims of the next sign-in and `idp.tamper` to corrupt the next token.

## Events and integrations

- Every service mutation that the outside world should hear about calls `record(ctx, '<type>', data, { teamIds })`
  next to its `emit(...)`. New event types go in `DOMAIN_EVENT_TYPES` (shared) and the table in `docs/api.md#webhooks`
  — they're public API, so don't rename them.
- A new integration is a provider object (`integrations/types.ts`) registered with `registerProvider` (see
  `integrations/registry.ts`). Do slow or fallible work in its hooks — they all run in jobs. Use `ictx.run(fn)` for
  changes so they're attributed to the bot and not echoed back.
- Forges share `services/forge.ts`; a forge provider only maps payloads and API calls. `test/forges.test.ts` runs
  each forge against `test/mock-forge.ts`, a tiny HTTP stand-in that logs calls.
- Tests: `test/events.test.ts` shows a fake provider and a local webhook receiver; `settle()` runs queued jobs
  including retries.

## Gotchas

- `pnpm` 12 blocks dependency build scripts unless listed under `allowBuilds` in `pnpm-workspace.yaml`.
- The production image contains only `server.mjs`, `seed.mjs`, `drizzle/` and the web build — anything the API
  needs at runtime must be bundleable by esbuild (no native modules; passwords use Node's built-in scrypt).
- Realtime fan-out uses Postgres `NOTIFY` (8 KB payload cap); `Realtime.publish` batches events under that.
- Workspace URL slugs and team keys appear in URLs and identifiers — changing them breaks old links.

## Where to look first

| Task               | Start in                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| New issue field    | `schema.ts` → `types.ts`/`schemas.ts` in shared → `services/issues.ts` → `properties.tsx`                |
| New page           | `apps/web/src/router.tsx`, then a file in `src/routes/`                                                  |
| New API resource   | a route file in `apps/api/src/routes/`, register it in `app.ts`, add tests                               |
| Notifications      | `services/notifications.ts`, inbox UI in `routes/inbox.tsx`                                              |
| Filters / grouping | `filterConditions` in `services/issues.ts`, `lib/issues.ts`, `components/FilterBar.tsx`                  |
| New import source  | an `ImportAdapter` in `services/imports/`, added to `ADAPTERS` in `engine.ts`                            |
| New MCP tool       | schema + `MCP_TOOLS` entry in shared `mcp.ts`, handler in `services/mcp.ts`, `test/mcp.test.ts`          |
| GraphQL field      | SDL in `services/graphql/schema.ts`, resolver in `resolvers.ts` (reuse services), `test/graphql.test.ts` |

See [ROADMAP.md](ROADMAP.md) for planned work.
