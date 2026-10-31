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
| `pnpm dev:preview [--ttl 30m]`     | API + web on free ports, throwaway seeded database   |
| `pnpm typecheck`                   | TypeScript (v7) across packages                      |
| `pnpm test`                        | Vitest — shared unit tests and API integration tests |
| `pnpm e2e`                         | Browser smoke tests (Playwright) against a preview   |
| `pnpm lint` / `pnpm format`        | Biome check / fix                                    |
| `pnpm build`                       | Production bundles                                   |
| `pnpm db:generate --name <change>` | New migration from `schema.ts`                       |
| `pnpm db:migrate`                  | Apply migrations without starting the API            |
| `pnpm db:seed`                     | Demo workspace                                       |

## Tests

API tests (`apps/api/test`) build the real Fastify app against a fresh `ordo_test_<pid>` database on the dev Postgres
(created per run by `test/global-setup.ts` and dropped afterwards, so checkouts can run tests at the same time) and drive it with `app.inject`. Point them elsewhere with
`TEST_ADMIN_DATABASE_URL`. They run serially and take a couple of seconds.

```bash
make dev-db
pnpm --filter @ordo/api test
```

### End-to-end tests

`apps/web/e2e` holds a few Playwright smoke tests over the flows where UI wiring matters most: sign-in and creating
an issue with `c`, offline edits and handing sync between tabs, board drag and drop, the rich editor's Markdown,
moving an issue to another team, and keyboard scopes. Each runs at desktop width and at 375px, and fails on console
errors (a spec can allow expected ones with `test.use({ allowConsoleErrors: /…/ })`). They're not part of
`pnpm test`; CI runs them in their own job.

```bash
make dev-db
pnpm --filter @ordo/web exec playwright install chromium   # once
pnpm e2e                                                    # starts and stops its own pnpm dev:preview
E2E_BASE_URL=http://localhost:5173 pnpm e2e                 # or against one already running (seeded demo)
pnpm e2e --project desktop --ui                             # Playwright's flags pass through
```

Keep them few: a new spec is for a flow that unit and API tests can't see breaking. Set up data through the `api`
fixture (`e2e/fixtures.ts`) and give it `unique()` titles, so specs run in parallel and against a reused preview.

## CI and releases

`.github/workflows/ci.yml` runs lint, typecheck, tests and `scripts/check-bundle.sh` against a Postgres service,
the end-to-end tests in a job of their own, and builds the Docker image without pushing it. Pull requests and branches other than `main` run it directly.

`main` and version tags go through `.github/workflows/release.yml` instead: it runs the same CI, then builds the
image for `linux/amd64` and `linux/arm64` and pushes it to `ghcr.io/<owner>/ordo` with a build provenance
attestation.

| Push         | Image tags                       |
| ------------ | -------------------------------- |
| `main`       | `main`, `latest`, `<commit sha>` |
| tag `v1.2.3` | `1.2.3`, `1.2`, `<commit sha>`   |

To cut a release, tag a commit on `main` and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.

## Making changes

### Add a field to issues

1. Add the column in `apps/api/src/db/schema.ts`, run `pnpm db:generate --name issue_<field>`.
2. Add it to `Issue` in `packages/shared/src/types.ts` and to `createIssueSchema` / `updateIssueSchema`.
3. Map it in `toIssue()` and handle it in `createIssue` / `updateIssue` (`services/issues.ts`) — record history
   with `change()`.
4. Add a picker in `apps/web/src/components/properties.tsx` and show it in the issue sidebar
   (`components/issue/IssueSidebar.tsx`), `IssueRow` and the create modal as appropriate. Render its history
   entry in `Activity.tsx`.
5. Test it in `apps/api/test/api.test.ts`.

### Add an endpoint

Create or extend a file in `apps/api/src/routes/`. Workspace routes are registered inside the scoped plugin in
`app.ts` and get `req.workspace`. Use `parse()` with a shared schema, `mutate()` for writes, `emit()` for
realtime, `requireAdmin()` where needed, and add tests.

### Add a page

Add a route in `apps/web/src/router.tsx`, a component in `src/routes/`, read params with
`useParams({ from: '<route id>' })`, and link to it with typed `<Link to=… params=…>`. Most issue screens are a
thin wrapper around `IssuesView` with a `baseFilter`.

### Add or change text

Every word a person reads in the web app comes from a catalogue in `apps/web/src/i18n/`: English in `en/`, Swedish
in `sv/`, Norwegian Bokmål in `nb/`, one file per area (`issues.ts`, `shell.ts`, `settings.ts`…). The message format,
plural rules and the fallback to English live in `packages/shared/src/i18n.ts`, shared with the API.

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
- Call `t()` while rendering or in handlers, not at module scope: the catalogue loads after the module. Changing
  language reloads the page, so nothing needs to subscribe. A module-level list of labels becomes a function or uses
  getters (`THEME_PREFS` in `lib/theme.ts`).
- Labels for fixed values (priorities, state types, statuses, roles, estimates) come from `i18n/labels.ts`, not the
  English `*_LABELS` constants in `@ordo/shared`, which stay for the API and CLI.
- Dates go through `lib/format.ts` (`shortDate`, `longDate`, `relativeTime`), which follow the language.
- Text the server or `@ordo/shared` sends in English (integration provider descriptions, MCP tool descriptions) is
  translated in the web app by its id, falling back to the English it came with (`providerText` in
  `routes/settings/integrations.tsx`).

**What the server writes to people** (emails, push notifications, chat direct messages) comes from
`apps/api/src/i18n/{en,sv,nb}.ts`, in the recipient's language: `serverT(localeOf(user.preferences))`, or
`userLocale(db, userId)` / `localeForEmail(db, email, fallbackUserId)` when you only have an id or an address. Keep
the server's Swedish and Norwegian complete; `test/i18n.test.ts` fails if a message is missing. Channel posts in
chat apps have no single reader and stay in English.

**API errors** stay English in `message`. To have the web app show one in the reader's language, add a key to
`API_MESSAGE_KEYS` in shared, mark the error with it (`throw forbidden('Only team admins can do this').as('team_admins_only')`,
with params for values in the sentence) and add the message under `errors.api` in the web catalogues. The web client
(`errorMessage` in `api/client.ts`) translates keyed errors and words network, rate-limit and server failures
itself; in English it keeps the API's message, which can be more specific.

To add a language, add its code to `LOCALES` and `LOCALE_NAMES` in `packages/shared/src/constants.ts` and an
`INTL_TAG` in `packages/shared/src/i18n.ts`; then a folder like `sv/` and a loader in `LOADERS` (`i18n/index.ts`) and a
date-fns locale (`lib/format.ts`) in the web app, and a file like `sv.ts` in `apps/api/src/i18n/`.

## Conventions

See [AGENTS.md](../AGENTS.md) — it's the canonical list (validation, tenant scoping, mutations, styling,
shortcuts).

## Debugging tips

- `LOG_LEVEL=debug pnpm --filter @ordo/api dev` for verbose logs.
- `make psql` (Docker) or `psql postgres://ordo:ordo@localhost:5433/ordo` (dev).
- The sidebar footer shows the realtime connection state (live / connecting / offline).
- React Query state lives under keys `['ws', slug, …]` — see `apps/web/src/api/queries.ts`.
