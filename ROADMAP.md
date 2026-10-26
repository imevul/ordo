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

## v0.2 — Daily-driver polish

- ⬜ Rich text editor for descriptions/comments (Tiptap/ProseMirror) with slash commands and paste-to-link
- ⬜ File attachments and images (local disk or S3-compatible storage)
- ⬜ Email notifications + digest (SMTP), per-user notification preferences
- ⬜ Snooze notifications, "remind me", inbox filters
- ⬜ Comment reactions (emoji)
- ⬜ Issue templates per team
- ⬜ Postgres full-text search (tsvector + ranking), search filters
- ⬜ Pagination / virtualized lists for very large teams
- ⬜ Light theme (Hotline Pink is dark-only today)
- ⬜ Cycle automation: auto-create upcoming cycles, roll over unfinished issues
- ⬜ Auto-archive completed issues after N months; archive view
- ⬜ Customer-facing "copy issue as markdown"
- ⬜ Profile pictures

## v0.3 — Planning

- ⬜ Project milestones
- ⬜ Initiatives (groups of projects) and roadmap/timeline view
- ⬜ Cycle burn-up / burndown charts; team insights (throughput, cycle time, lead time)
- ⬜ SLA rules and due-date reminders
- ⬜ Recurring issues
- ⬜ Project documents
- ⬜ Team-level and project-level views; view folders
- ⬜ Custom fields? (Linear deliberately avoids them — decide)

## v0.4 — Integrations & automation

- ⬜ Outgoing webhooks with signed payloads, retries and a delivery log
- ⬜ GitHub / GitLab / Forgejo: link branches and PRs, auto-move status on open/merge (magic words)
- ⬜ Slack / Discord / Matrix notifications; create issues from messages
- ⬜ Workflow automations (on status change, on label, on PR merge…)
- ⬜ Importers: Linear (API/CSV), Jira, GitHub Issues, Trello, CSV
- ⬜ Export (CSV / JSON), full workspace export
- ⬜ GraphQL API (Linear-compatible subset) and a typed TypeScript SDK
- ⬜ CLI (`ordo issue create …`)
- ⬜ MCP server for AI assistants
- ⬜ Asks / intake forms and a public issue intake email address

## v0.5 — Teams at scale

- ⬜ SSO: OIDC (Authentik, Keycloak, Google, GitHub), SAML
- ⬜ SCIM provisioning
- ⬜ Guests and private teams; granular permissions
- ⬜ Audit log
- ⬜ Two-factor authentication (TOTP, passkeys)
- ⬜ Sub-teams
- ⬜ Rate limiting per API key; API usage page

## Later / exploring

- ⬜ Offline-first sync engine (local IndexedDB store + delta sync) like Linear's
- ⬜ Desktop app (Tauri) and mobile apps / PWA with push notifications
- ⬜ AI features (triage suggestions, duplicate detection, summaries) using a configurable model provider
- ⬜ Helm chart, prebuilt multi-arch images on a registry, one-click installers
- ⬜ i18n

## Known limitations

- Board grouped by **label** shows multi-label issues in several columns; dragging is disabled there.
- Issue lists load up to 2 000 issues per view (server cap 5 000) — fine for most teams, not for huge backlogs.
- Search is substring-based (`ILIKE`), not ranked.
- No attachments yet; link to files instead.
