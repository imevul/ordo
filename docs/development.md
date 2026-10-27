# Development

## Setup

Requirements: Node 24+ (26 recommended, see `.nvmrc`), pnpm 12, Docker.

```bash
make dev          # = pnpm install + make dev-db + pnpm dev
```

- Postgres runs in Docker on **localhost:5433** (`docker-compose.dev.yml`, user/password/db `ordo`).
- **Mailpit** catches all email: SMTP on :1025, inbox at <http://localhost:8025>. `pnpm dev` points the API at it.
- Uploads go to `apps/api/data/uploads`.
- The API runs with `tsx watch` on **:3001**; it migrates the database on start.
- Vite serves the web app on **:5173** and proxies `/api` and `/api/ws` to the API.

`pnpm dev` sets `ORDO_PUBLIC_URL=http://localhost:5173`, so email links and SSO callbacks come back through Vite.
To try SSO without a real provider, run the test IdP on a fixed port (it signs in whoever `CLAIMS` describes) and
add `http://127.0.0.1:9400` with client `ordo-test` / `top-secret` under Settings → Authentication, after turning on
private network targets in the admin area:

```ts
// sso-dev.mts — run with: pnpm --filter @ordo/api exec tsx sso-dev.mts
import { startMockIdp } from './test/mock-idp.ts';
const idp = await startMockIdp(9400);
idp.next = { sub: 'grace-1', email: 'grace@ordo.test', email_verified: true, name: 'Grace Hopper' };
```

Open <http://localhost:5173>. Load demo data with `pnpm db:seed` and sign in as `demo@ordo.test` /
`ordo-demo-password`.

## Commands

|                                    |                                                      |
| ---------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                         | API + web with hot reload                            |
| `pnpm typecheck`                   | TypeScript (v7) across packages                      |
| `pnpm test`                        | Vitest — shared unit tests and API integration tests |
| `pnpm lint` / `pnpm format`        | Biome check / fix                                    |
| `pnpm build`                       | Production bundles                                   |
| `pnpm db:generate --name <change>` | New migration from `schema.ts`                       |
| `pnpm db:migrate`                  | Apply migrations without starting the API            |
| `pnpm db:seed`                     | Demo workspace                                       |

## Tests

API tests (`apps/api/test`) build the real Fastify app against a fresh `ordo_test` database on the dev Postgres
(recreated by `test/global-setup.ts`) and drive it with `app.inject`. Point them elsewhere with
`TEST_ADMIN_DATABASE_URL`. They run serially and take a couple of seconds.

```bash
make dev-db
pnpm --filter @ordo/api test
```

## Making changes

### Add a field to issues

1. Add the column in `apps/api/src/db/schema.ts`, run `pnpm db:generate --name issue_<field>`.
2. Add it to `Issue` in `packages/shared/src/types.ts` and to `createIssueSchema` / `updateIssueSchema`.
3. Map it in `toIssue()` and handle it in `createIssue` / `updateIssue` (`services/issues.ts`) — record history
   with `change()`.
4. Add a picker in `apps/web/src/components/properties.tsx` and show it in `IssueDetailView`, `IssueRow`
   and the create modal as appropriate. Render its history entry in `Activity.tsx`.
5. Test it in `apps/api/test/api.test.ts`.

### Add an endpoint

Create or extend a file in `apps/api/src/routes/`. Workspace routes are registered inside the scoped plugin in
`app.ts` and get `req.workspace`. Use `parse()` with a shared schema, `mutate()` for writes, `emit()` for
realtime, `requireAdmin()` where needed, and add tests.

### Add a page

Add a route in `apps/web/src/router.tsx`, a component in `src/routes/`, read params with
`useParams({ from: '<route id>' })`, and link to it with typed `<Link to=… params=…>`. Most issue screens are a
thin wrapper around `IssuesView` with a `baseFilter`.

### Add or change text in the web app

Every word a person reads comes from a catalogue in `apps/web/src/i18n/`: English in `en/`, Swedish in `sv/`,
Norwegian Bokmål in `nb/`, one file per area (`issues.ts`, `shell.ts`, `settings.ts`…).

```tsx
import { t, tx } from '../i18n/index.ts';

<button>{t('issues.create.submit')}</button>
toast.success(t('issues.moved', { count: ids.length }));          // { one: '…', other: '…' }
<p>{tx('issue.activity.assigned', { actor: <ActorName … />, b: (c) => <strong>{c}</strong> })}</p>
```

- Add the English message first; it's the source and the fallback. Swedish and Norwegian may lag behind: a missing
  message shows in English, and `pnpm test` prints how many are missing per language.
- `{name}` placeholders and `<tag>…</tag>` markup must match English in every translation (a test checks).
  Write whole sentences as one message so a translation can reorder them; never glue translated pieces together.
- Messages with a number are plural objects (`{ one, other }`) picked by `count`.
- Call `t()` while rendering, not at module scope: the catalogue loads after the module, and changing language
  remounts the app so every `t()` runs again.
- Labels for fixed values (priorities, state types, statuses, roles, estimates) come from `i18n/labels.ts`, not the
  English `*_LABELS` constants in `@ordo/shared`, which stay for the API and CLI.
- Dates go through `lib/format.ts` (`shortDate`, `longDate`, `relativeTime`), which follow the language.

To add a language, add its code to `LOCALES` and `LOCALE_NAMES` in `packages/shared/src/constants.ts`, a folder
like `sv/`, a loader in `LOADERS` and an `INTL_TAG` in `i18n/index.ts`, and a date-fns locale in `lib/format.ts`.

## Conventions

See [AGENTS.md](../AGENTS.md) — it's the canonical list (validation, tenant scoping, mutations, styling,
shortcuts).

## Debugging tips

- `LOG_LEVEL=debug pnpm --filter @ordo/api dev` for verbose logs.
- `make psql` (Docker) or `psql postgres://ordo:ordo@localhost:5433/ordo` (dev).
- The sidebar footer shows the realtime connection state (live / connecting / offline).
- React Query state lives under keys `['ws', slug, …]` — see `apps/web/src/api/queries.ts`.
