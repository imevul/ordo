# Ordo documentation

New here? Start with the [quick start](../README.md#quick-start), then the [user guide](user-guide.md).

## Using Ordo

| Guide                                       |                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| [User guide](user-guide.md)                 | Workspaces, teams, issues, cycles, projects, the inbox and views        |
| [Keyboard shortcuts](keyboard-shortcuts.md) | Every shortcut and the command menu                                     |
| [Import and export](import-export.md)       | Bringing work in from CSV and other tools, exporting a workspace        |
| [AI assistance](ai.md)                      | Optional summaries, drafts and triage suggestions (Claude API or local) |

## Running an instance

| Guide                               |                                                                       |
| ----------------------------------- | --------------------------------------------------------------------- |
| [Self-hosting](self-hosting.md)     | Install, HTTPS, backups, upgrades, monitoring, running without Docker |
| [Configuration](configuration.md)   | Every environment variable and instance setting                       |
| [Instance administration](admin.md) | The admin area, key rotation and recovery                             |
| [Single sign-on](sso.md)            | OpenID Connect and SAML 2.0 per workspace                             |
| [Directory sync (SCIM)](scim.md)    | Provisioning from Okta, Entra ID or Authentik                         |

## Integrating

| Guide                                     |                                                       |
| ----------------------------------------- | ----------------------------------------------------- |
| [REST API, webhooks and realtime](api.md) | Endpoints, API keys, signed webhooks, realtime events |
| [GraphQL](graphql.md)                     | The GraphQL API                                       |
| [CLI and SDK](cli.md)                     | The `ordo` command and the TypeScript SDK             |
| [MCP server](mcp.md)                      | Connecting AI clients to a workspace                  |
| [Agents](agents.md)                       | Agent members, runners and pull request agents        |
| [Integrations](integrations/README.md)    | Overview of everything below                          |

Integrations one by one: [GitHub](integrations/github.md) · [GitLab](integrations/gitlab.md) ·
[Forgejo / Gitea](integrations/forgejo.md) · [Slack](integrations/slack.md) · [Discord](integrations/discord.md) ·
[Matrix](integrations/matrix.md) · [Telegram](integrations/telegram.md) · [chat in general](integrations/chat.md) ·
[Email](integrations/email.md) · [Jira](integrations/jira.md)

## Working on Ordo

| Guide                              |                                         |
| ---------------------------------- | --------------------------------------- |
| [Contributing](../CONTRIBUTING.md) | How to propose a change, and the terms  |
| [Development](development.md)      | Setup, commands, layout and conventions |
| [Architecture](architecture.md)    | How it's built and the data model       |
| [Design system](design.md)         | Hotline Pink as applied to Ordo         |
| [AGENTS.md](../AGENTS.md)          | The short version, for AI coding agents |

Planned work lives in the [roadmap](../ROADMAP.md).
