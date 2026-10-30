# Ordo

**A self-hostable issue tracker for software teams, in the spirit of [Linear](https://linear.app).**
Keyboard-first, realtime, opinionated about workflow — and it runs on your own box with one command.

```
make up
```

Then open <http://localhost:3000>. The first person to sign up becomes the admin.

---

## What you get

- **Issues** with team identifiers (`ENG-42`), statuses, priorities, assignees, labels, estimates, due dates,
  sub-issues, relations (blocks / blocked by / related / duplicate), markdown descriptions, comments with
  threads and `@mentions`, a full change history, and a trash you can restore from.
- **Teams** with their own workflow (customizable statuses grouped into triage, backlog, unstarted, started,
  completed, canceled), estimate scale, optional triage inbox and cycles.
- **List and board layouts** with grouping (status, priority, assignee, project, cycle, label), ordering,
  filters, drag-and-drop, multi-select and bulk edits.
- **Cycles** — time-boxed iterations per team with progress tracking.
- **Projects** across teams, with lead, dates, status, health and written project updates.
- **Saved views**, shared with the workspace or private, and **favorites** in the sidebar.
- **Inbox** for assignments, mentions, comments and status changes on issues you follow.
- **Command menu** (`⌘K` / `Ctrl K`) and **keyboard shortcuts** for nearly everything (`?` lists them).
- **Realtime** — every change shows up for everyone instantly, over a WebSocket fed by Postgres `LISTEN/NOTIFY`.
- **Workspaces, members, roles and invite links**; invite-only or open sign-up.
- **GitHub, GitLab and Forgejo/Gitea**: PRs, branches and commits link to issues and move them along; works
  behind NAT by polling.
- **Single sign-on** per workspace with any OpenID Connect or SAML 2.0 provider, group → role mapping and "require SSO";
  **directory sync** (SCIM 2.0) from Okta, Entra ID or Authentik.
- **REST API** with personal API keys, and signed **webhooks** for issue, comment, project and cycle events.

See [ROADMAP.md](ROADMAP.md) for what's next and how far along the Linear feature set we are.

## Quick start (self-hosting)

Requirements: Docker with Compose v2, and `make`.

```bash
git clone <your fork or this repo> ordo && cd ordo
make up          # creates .env with a random DB password, builds, starts, waits until healthy
```

| Command               | What it does                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `make up`             | Build and start Ordo in the background                               |
| `make down`           | Stop Ordo (data is kept in the `ordo-db` volume)                     |
| `make restart`        | Restart the containers                                               |
| `make update`         | `git pull`, rebuild, restart — database migrations run automatically |
| `make logs`           | Follow the application logs                                          |
| `make backup`         | Dump the database to `backups/ordo-<timestamp>.sql.gz`               |
| `make restore FILE=…` | Restore a backup                                                     |
| `make seed`           | Load a demo workspace (`demo@ordo.test` / `ordo-demo-password`)      |
| `make help`           | Everything else                                                      |

Configuration lives in `.env` — see [docs/configuration.md](docs/configuration.md). Before exposing Ordo to the
internet, put it behind HTTPS and set `ORDO_PUBLIC_URL`; [docs/self-hosting.md](docs/self-hosting.md) has
Caddy and nginx examples.

## Development

```bash
make dev         # Postgres in Docker on :5433, API on :3001, web on :5173 with hot reload
pnpm db:seed     # optional demo data
make test        # API integration tests + shared unit tests
```

Node 24+ and pnpm 12 are required. [docs/development.md](docs/development.md) explains the layout and
conventions; [AGENTS.md](AGENTS.md) is the short version for AI coding agents.

## Stack

TypeScript end to end, in a pnpm monorepo:

- `apps/api` — Fastify 5, Drizzle ORM, PostgreSQL 18, WebSockets. Bundled with esbuild into a single file.
- `apps/web` — React 19, Vite, TanStack Router + Query, Tailwind CSS 4, cmdk, dnd-kit.
- `packages/shared` — Zod schemas, types and domain constants used by both.

One container serves both the API and the built web app; the only other service is Postgres.
The UI uses the **Hotline Pink** design system: dark charcoal ground (or a light theme), sparse pink accents, cyan
focus rings, chamfered corners instead of rounded ones ([docs/design.md](docs/design.md)).

## Documentation

| Doc                                                      |                                                    |
| -------------------------------------------------------- | -------------------------------------------------- |
| [docs/user-guide.md](docs/user-guide.md)                 | Concepts and everyday use                          |
| [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) | Every shortcut                                     |
| [docs/self-hosting.md](docs/self-hosting.md)             | Install, HTTPS, backups, upgrades, troubleshooting |
| [docs/configuration.md](docs/configuration.md)           | Environment variables                              |
| [docs/admin.md](docs/admin.md)                           | Instance administration and recovery               |
| [docs/sso.md](docs/sso.md)                               | Single sign-on (OIDC and SAML) per workspace       |
| [docs/scim.md](docs/scim.md)                             | Directory sync (SCIM) from your identity provider  |
| [docs/integrations/](docs/integrations/README.md)        | GitHub, GitLab, Forgejo/Gitea                      |
| [docs/api.md](docs/api.md)                               | REST API, webhooks and realtime events             |
| [docs/graphql.md](docs/graphql.md)                       | GraphQL API                                        |
| [docs/cli.md](docs/cli.md)                               | The `ordo` command line and the TypeScript SDK     |
| [docs/mcp.md](docs/mcp.md)                               | MCP server for AI agents                           |
| [docs/ai.md](docs/ai.md)                                 | Optional AI assistance (Claude API or local model) |
| [docs/architecture.md](docs/architecture.md)             | How it's built, data model                         |
| [docs/development.md](docs/development.md)               | Working on Ordo                                    |
| [docs/design.md](docs/design.md)                         | The design system as applied to Ordo               |

## Status

Early (v0.1). The core tracker is complete and tested; integrations, imports, SSO and attachments are on the
[roadmap](ROADMAP.md). Ordo is not affiliated with Linear.

## License

Ordo is source-available under the [Functional Source License 1.1, Apache 2.0 Future License](LICENSE.md)
(FSL-1.1-ALv2).

- **You can** self-host it for yourself or your organisation, change it, and contribute back.
- **You can't** offer Ordo, or a substantially similar product, to others as a commercial product or service.
- **Each release becomes Apache 2.0** two years after it is published.

Code up to the tag `apache-2.0-final` was released under the Apache License 2.0 and stays available under it.

## Contributing

By contributing, you license your contribution under the project's license and agree that the maintainer may
relicense it in future versions.
