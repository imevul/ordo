# Roadmap

Ordo aims to cover most of what [Linear](https://linear.app/docs) offers, self-hosted. This file tracks where
we are. ✅ shipped · 🟡 partial · ⬜ planned. Items within a milestone are roughly in priority order.

## v0.1 — Core tracker (current)

- ✅ Workspaces, members, admin/member roles, invite links (email-bound or open), invite-only or open sign-up
- ✅ Email + password auth (scrypt), sliding sessions, personal API keys
- ✅ Teams with keys and per-team issue numbering (`ENG-42`); join/leave teams
- ✅ Custom workflow statuses per team, grouped by type; default status
- ✅ Issues: title, markdown description, status, priority, assignee, labels, estimate, due date, project, cycle
- ✅ Sub-issues with progress, parent picker and loop protection
- ✅ Relations: blocks / blocked by / related / duplicate of (marking duplicate closes the issue)
- ✅ Comments with threads, editing, `@mentions` with autocomplete
- ✅ Issue history (every property change), subscriptions
- ✅ Trash with restore; admins can delete permanently
- ✅ Moving issues between teams (re-numbered, status mapped by type)
- ✅ List view: grouping, ordering, collapse, keyboard navigation, multi-select, bulk edit
- ✅ Board view with drag-and-drop between groups and manual ordering
- ✅ Filters (status, status type, priority, assignee, creator, labels, project, cycle)
- ✅ Display options: show completed, sub-issues, empty groups; persisted per view
- ✅ Saved views (shared or private), favorites
- ✅ My issues (assigned / created / subscribed)
- ✅ Triage (per-team toggle)
- ✅ Cycles with progress (scope, started, completed, points)
- ✅ Projects across teams: status, lead, dates, color, progress, health, project updates
- ✅ Inbox: assigned, unassigned, mentions, comments, status changes, urgent; read/unread/delete
- ✅ Labels (workspace or team scoped), estimate scales (linear, fibonacci, exponential, t-shirt)
- ✅ Command menu with contextual issue actions; keyboard shortcuts with `G` sequences; shortcut help
- ✅ Realtime updates via WebSocket + Postgres `LISTEN/NOTIFY` (multi-instance safe)
- ✅ Search by title, description and identifier
- ✅ REST API (session cookie or `Bearer` API key)
- ✅ Docker Compose deployment, `make up|down|restart|update|backup|restore`, auto-migrations, demo seed
- ✅ Hotline Pink design system UI, mobile-friendly navigation

## v0.2 → v1.0, in order

Each phase ships on its own. The detailed design lives in the planning notes behind each phase; this is the summary.

### Phase 1 — Foundations ✅

- ✅ Secret keyring (`ORDO_SECRET_KEY`, rotation via `ORDO_SECRET_KEY_PREVIOUS`) for secrets at rest
- ✅ `runInWorkspace` contexts with actor source and silent mode, for jobs, webhooks and imports
- ✅ Account kinds (human, bot, placeholder), disabled accounts, instance admin (first user), SSO-ready sessions
- ✅ Audit log of security-relevant actions; workspace audit-log API
- ✅ Instance settings (env → database → default), changeable without restart
- ✅ Hardened outbound fetch (no private/loopback targets unless allowed, rebinding-safe)
- ✅ Cross-site write protection; deleting users keeps their issues and comments
- ✅ Bundle check and CI workflow

### Phase 2 — Access control ✅

- ✅ Roles: owner, admin, member, guest; team admins
- ✅ Private teams; guests see only their teams
- ✅ Access enforced on every read and write path, progress counts, search, notifications and realtime events
- ✅ Role × endpoint test matrix and route inventory

### Phase 3 — Jobs, email, storage, account area ✅

- ✅ Postgres job queue with retries, ordering, schedules and leases
- ✅ SMTP email: password reset, verification, email change, security notices, notification digests (invites: Phase 4)
- ✅ File storage (local volume or S3-compatible) with signed URLs
- ✅ Account area: picture, email change, password reset, sessions, TOTP 2FA with recovery codes, notification preferences, connected accounts

### Phase 4 — Organisation settings, invites, instance admin ✅

- ✅ Org settings: general (logo, default team), members (suspend), security (invite policy, domains), audit log, danger zone (transfer, delete)
- ✅ Emailed and bulk invites into teams, resend, guest invites, verified-domain auto-join
- ✅ Instance admin: users, workspaces, domains, settings (SMTP, sign-up, network), jobs, audit, health; recovery CLI

### Phase 5 — Per-organisation OIDC SSO ✅

- ✅ Providers per organisation (encrypted secrets, test connection), verified domains, domain-aware login,
  just-in-time accounts with an account-takeover guard, connected accounts
- ✅ Require SSO with an audited owner fallback, SSO session length, API-key policy, group → role mapping

### Phase 6 — Events and integration framework ✅

- ✅ Transactional event outbox (issues, comments, relations, projects, project updates, cycles)
- ✅ Signed outgoing webhooks with filters, delivery log, ping, redelivery and auto-disable
- ✅ Integration framework: inbound webhooks, polling, domain events, bot accounts; issue links (PRs, branches,
  messages, plain links)
- ✅ Long-lived connectors under leases (landed with chat in Phase 8)

### Phase 7 — Git forges ✅

- ✅ GitHub (one-click App from a manifest, or a token), GitLab, Forgejo/Gitea: link branches, commits and PRs/MRs
- ✅ Magic words, per-team status automation (forward only), key aliases after renames, PR comments
- ✅ Webhooks or polling for instances the forge can't reach; claimable forge usernames; branch name format

### Phase 8 — Chat ✅

- ✅ Slack, Discord, Matrix, Telegram: channel feeds per team and kind of activity, personal notifications by
  direct message, create issues from messages, link previews for people who can read the issue
- ✅ Accounts linked with one-time codes; commands (`link`, `new`, `unlink`, `help`)
- ✅ Works behind NAT: Slack Socket Mode, Discord gateway, Telegram long polling, Matrix sync, under leases
- [x] ✅ Threaded comment sync (Slack, Discord, Matrix, Telegram), end-to-end encrypted Matrix rooms, one-click Slack install (Add to Slack)

### Phase 9 — Importers and export ✅

- ✅ Import framework: analysis, suggested mapping (teams, statuses, people, labels, projects), dry run, resumable
  silent runs in background jobs, kept issue numbers, cancel, undo; CSV importer with column detection
- ✅ Placeholder people for unmatched users, reused across imports, merged into members later
- ✅ Linear importer: teams, statuses, people, labels, projects, cycles, issues, sub-issues, comments, relations,
  attachments as links; waits out rate limits
- ✅ GitHub Issues importer: repositories as teams, open/closed statuses, labels, milestones as projects,
  comments, people by claimed usernames; GitHub Enterprise Server
- ✅ Jira importer (Cloud and Data Center): projects, epics as projects, sub-tasks, types and components as
  labels, story points, links as relations, comments; wiki markup to Markdown
- ✅ Forgejo/Gitea and GitLab importers: repositories or projects as teams, labels, milestones as projects,
  comments (GitLab notes), people by claimed usernames
- ✅ Workspace export: JSON of the whole workspace, CSV of issues that imports back; kept a week, audited
- ✅ Settings → Import & export: imports with mapping, dry runs, progress and reports; merging placeholders;
  exports

### Phase 10 — Product depth

- [x] ✅ Rich text editor and attachments; comment reactions; issue templates
- [x] ✅ Full-text search; pagination for very large teams
- [x] ✅ Cycle automation; auto-archive
- [x] ✅ Project milestones; initiatives and roadmap timeline; insights and charts
- [x] ✅ SLAs, recurring issues, triage rules; customer requests and intake by email
- [x] ✅ Project documents; notification snooze
- [x] ✅ PWA and push; light theme; i18n (English, Swedish, Norwegian Bokmål: the app, emails, push and chat notifications, common errors)
- ✅ MCP server for AI agents (Streamable HTTP, per workspace, personal API keys; search, read, create, update and
  comment on issues) and Settings → AI agents with setup snippets and an agent prompt
- [x] ✅ GraphQL API, TypeScript SDK, CLI; optional AI assistance (Claude API or a local OpenAI-compatible model: summaries, drafts, triage suggestions); OAuth sign-in for MCP (claude.ai connectors)

### Phase 11 — Enterprise sign-in and offline-first

- [x] ✅ Passkeys: passwordless sign-in with autofill, and as a second factor
- [x] ✅ SAML 2.0 SSO alongside OIDC (SP metadata, test mode, group roles)
- [x] ✅ SCIM 2.0 provisioning: users to members (deactivating suspends), groups to teams (Okta, Entra ID, Authentik)
- [~] 🟡 Offline-first sync: a local copy of the workspace, a change feed, offline edits replayed on reconnect — change log, delta API and client-chosen ids shipped; client store next

### Phase 12 — Desktop and mobile apps

- [ ] ⬜ Desktop app
- [ ] ⬜ Mobile apps

## Known limitations

- Board grouped by **label** shows multi-label issues in several columns; dragging is disabled there.
