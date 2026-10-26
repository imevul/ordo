# Roadmap

This file tracks where
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
- ✅ Account area: picture, email change, password reset, sessions, TOTP 2FA with recovery codes, notification preferences (connected accounts: Phase 5)

### Phase 4 — Organisation settings, invites, instance admin ✅

- ✅ Org settings: general (logo, default team), members (suspend), security (invite policy, domains), audit log, danger zone (transfer, delete)
- ✅ Emailed and bulk invites into teams, resend, guest invites, verified-domain auto-join
- ✅ Instance admin: users, workspaces, domains, settings (SMTP, sign-up, network), jobs, audit, health; recovery CLI

### Phase 5 — Per-organisation OIDC SSO

- ⬜ Providers per organisation, verified domains, email-first login, just-in-time accounts
- ⬜ Require SSO with owner fallback, group → role mapping

### Phase 6 — Events and integration framework

- ⬜ Transactional event outbox
- ⬜ Signed outgoing webhooks with delivery log
- ⬜ Integration framework: inbound webhooks, polling, long-lived connectors; issue links (PRs, branches, messages)

### Phase 7 — Git forges

- ⬜ GitHub (App or token), GitLab, Forgejo/Gitea: link branches, commits and PRs; magic words; status automation

### Phase 8 — Chat

- ⬜ Slack, Discord, Matrix, Telegram: channel subscriptions, personal notifications, create issues from messages,
  link unfurls; works behind NAT

### Phase 9 — Importers and export

- ⬜ Jira, Linear, GitHub Issues, CSV importers with mapping and dry run
- ⬜ Workspace export (JSON, CSV)

### Phase 10 — Product depth

- ⬜ Rich text editor and attachments; comment reactions; issue templates
- ⬜ Full-text search; pagination for very large teams
- ⬜ Cycle automation; auto-archive
- ⬜ Project milestones; initiatives and roadmap timeline; insights and charts
- ⬜ SLAs, recurring issues, triage rules; customer requests and intake by email
- ⬜ Project documents; notification snooze
- ⬜ PWA and push; light theme; i18n
- ⬜ GraphQL API, TypeScript SDK, CLI, MCP server; optional AI assistance
- ⬜ Later: passkeys, SCIM, SAML, offline-first sync, desktop app, Helm chart and prebuilt images

## Known limitations

- Board grouped by **label** shows multi-label issues in several columns; dragging is disabled there.
- Issue lists load up to 2 000 issues per view (server cap 5 000) — fine for most teams, not for huge backlogs.
- Search is substring-based (`ILIKE`), not ranked.
- No attachments yet; link to files instead.
