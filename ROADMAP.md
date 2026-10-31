# Roadmap

This file tracks where Ordo is and what's next. ✅ shipped · 🟡 partial · ⬜ planned. Items within a milestone are
roughly in priority order.

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
- ✅ Jira integration (Cloud and Data Center), one of three modes: links with status and backlinks, a Jira → Ordo
  mirror, or two-way sync of title, description, status, priority, assignee and comments; webhooks or polling;
  adopts issues the Jira importer brought in

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
- [x] ✅ Agents: assignable non-human members, repositories on projects and teams, agent runs with a claim/lease
  runner protocol, and `ordo agent run` (any command, runner files with .env) — see docs/agents.md
- [x] ✅ Failed agent runs: a reason for each failure, Restart and Dismiss on the Agent runs page (failed runs stay
  in its Open list), and usage limits recognised: the agent pauses until the limit resets and its runs restart
- [x] ✅ Agents and pull requests: PRs with checks and review in the issue sidebar, a project's pull request
  agent (hand-off when a PR is ready, issues for PRs opened outside Ordo), assignees woken on failing checks and
  requested changes
- [x] ✅ GraphQL API, TypeScript SDK, CLI; optional AI assistance (Claude API or a local OpenAI-compatible model: summaries, drafts, triage suggestions); OAuth sign-in for MCP (claude.ai connectors)

### Phase 11 — Enterprise sign-in and offline-first

- [x] ✅ Passkeys: passwordless sign-in with autofill, and as a second factor
- [x] ✅ SAML 2.0 SSO alongside OIDC (SP metadata, test mode, group roles)
- [x] ✅ SCIM 2.0 provisioning: users to members (deactivating suspends), groups to teams (Okta, Entra ID, Authentik)
- [x] ✅ Offline-first sync: a local copy of the workspace, a change feed, offline edits replayed on reconnect

### Hardening — findings from the 2026-10-30 review ✅

- [x] ✅ Security
  - [x] ✅ SSO account linking: POST with an Origin check, only providers of workspaces the user belongs to
  - [x] ✅ GitHub App setup: confirm the user can access `installation_id` with GitHub, refuse one another
    workspace already holds
  - [x] ✅ Sign-in rate limits: trust one proxy hop instead of any `X-Forwarded-For`; per-account lockout after ten
    wrong passwords or codes in 15 minutes
  - [x] ✅ Clear an integration's stored secrets when its base or API URL changes
  - [x] ✅ `safeRedirect` rejects `/\…`; TOTP codes can't be reused; invite tokens and other URL secrets kept out of
    request logs
  - [x] ✅ Invite tokens at rest: store a hash for lookup and the link encrypted, so admins can still copy and resend it
- [x] ✅ Bugs
  - [x] ✅ Hotkeys: a matching `g x` sequence wins over a newer single-key binding
  - [x] ✅ `rotate-key` re-encrypts every secret (SSO, webhooks, integrations, AI, VAPID, Matrix store, imports)
  - [x] ✅ Moving an issue to another team keeps `completedAt`/`canceledAt` and sends no status change when the state
    type is the same
  - [x] ✅ Deleting a cycle or a status updates issues through `services/issues.ts` and emits their real ids
  - [x] ✅ SDK/CLI `--cycle current` treats `endsAt` as exclusive, like the API
  - [x] ✅ Grouping by assignee keeps issues assigned to placeholders and removed members
  - [x] ✅ `ordo agent run`: Ctrl-C drains without killing agents; cancel and timeout stop the whole process group
  - [x] ✅ Digests: ordered pending query, emailed state recorded with each queued email
  - [x] ✅ Scheduled jobs survive one failing team or issue; long exports don't run twice; re-trashing keeps the
    trash date; turning triage off moves triage issues; one definition of "today" in cycle automation
- [x] ✅ Docs
  - [x] ✅ docker-compose.yml passes every documented setting (`ORDO_MAX_ATTACHMENT_MB`, `ORDO_OFFLINE_SYNC`,
    `ORDO_WORKSPACE_AI`, `ORDO_GITHUB_URL`, `ORDO_GITHUB_API_URL`, `DATABASE_POOL_SIZE`)
  - [x] ✅ README: Status, feature list, stack, `make backup`; one key-rotation story in configuration.md and admin.md
  - [x] ✅ Fix api.md (agent run states, realtime kinds, `scim` source), the `Mod Shift .` shortcut on Nordic
    layouts, per-command CLI help, the backup cron prune
  - [x] ✅ Operator topics: `/api/health` monitoring, running without Docker, restoring onto a new host, missing
    secret key troubleshooting; undocumented API groups and CLI commands
- [x] ✅ Code quality
  - [x] ✅ Zod schemas for integration config and secrets instead of casts and hand validation
  - [x] ✅ `bulkUpdateIssues` in `services/issues.ts` for the direct issue writes (cycles, statuses, placeholders,
    SLA, comments)
  - [x] ✅ A `one(rows)` helper for `.returning()`; handle a missing team in the issue view instead of `!`
  - [x] ✅ Split `IssueDetailView`, `auth.tsx`, `admin.tsx` and `account.tsx`
  - [x] ✅ Small cleanups: `<TeamSelect>`, `useWsMutation` key type, role helpers, parsed query strings, one
    `escapeHtml`, dead label maps, unused `clsx`, current lint warnings
  - [x] ✅ Unit tests for `apps/web/src/lib/issues.ts`
  - [x] ✅ The remaining route query strings (callbacks, SCIM, hooks) parsed with Zod; AAD helpers shared between
    secret call sites and the `rotate-key` registry, so a new secret can't be missed
- [x] ✅ Also shipped alongside
  - [x] ✅ Instance admins invite people to the instance without adding them to a workspace
  - [x] ✅ Inbox items open the issue at the comment they're about; a count on _Agent runs_ in the sidebar
  - [x] ✅ Add a workspace repository by browsing GitHub or Forgejo; agents get a profile color
  - [x] ✅ `ordo agent run` reuses the worktree an issue's branch is already checked out in

### Hardening, round 2 — findings from the second 2026-10-30 review

- [ ] ⬜ Security
  - [ ] ⬜ SSO and SCIM attach an identity to an existing account only if its email is verified
  - [ ] ⬜ Accounts without a password re-authenticate (recent sign-in) before changing email or setting up 2FA
  - [ ] ⬜ Clear the stored AI key when the provider or base URL changes, and an OIDC client secret when the issuer
    changes
  - [ ] ⬜ Password reset and change revoke API keys and OAuth grants (or offer to)
  - [ ] ⬜ Rate limits and lockout on every endpoint that checks a password; replay-safe codes for new recovery codes
  - [ ] ⬜ `safeFetch` drops `Authorization` and cookies on cross-origin redirects
- [ ] ⬜ Bugs
  - [ ] ⬜ `automationBot` recurses forever when someone already holds the username `ordo-<workspace id prefix>`
    (`onConflictDoNothing` also swallows the username conflict): triage rules and every scheduled sweep hang
  - [ ] ⬜ Offline sync: gaining access to a team (added, promoted, team made public) never loads its existing issues
    into the local copy
  - [ ] ⬜ Offline sync outbox: a failed save stalls every later change; a broadcast from another tab drops this tab's
    unsaved entries (and can hang the mutation); an IndexedDB upgrade in another tab leaves the leader unable to write
  - [ ] ⬜ Jobs: a job whose lease expires is claimed again without checking `max_attempts`, so a job that crashes the
    process (a large export) retries forever; `reapLeases` and `maintenance.cleanup` stop at the first failing item
  - [ ] ⬜ One failing outbound event holds up an integration's inbound webhooks and polls for ~20 minutes per event
    (shared ordering key), so Jira sync can stall
  - [ ] ⬜ Moving an issue to another team with an unchanged `stateId` keeps the old team's status
  - [ ] ⬜ Issue page: queued offline edits aren't layered on the issue detail, so fields snap back until sent; trash
    and Undo (list and issue header), and moving issues to another team, bypass the outbox and fail silently
  - [ ] ⬜ Project documents: edits in the last second before switching docs are lost; a slow save can raise a
    conflict against your own edit
  - [ ] ⬜ `ordo agent run`: relative `--repos` puts worktrees inside the clones; `--key`, `--repos`, `--concurrency`
    and `--timeout` are ignored with `--file`; `${VAR}` in a runner-file command aborts loading; `ordo login` leaves
    an existing config file world-readable
  - [ ] ⬜ Smaller: recurring issues use UTC "today" (not the workspace zone) and swallow every template error; CSV
    due dates shift a day on hosts east of UTC; purging an issue sends no update for its sub-issues; integration
    dedupe keys don't survive a crash after dispatch; two concurrent export requests both start
- [ ] ⬜ Self-hosting
  - [x] ✅ `make up` failed on a fresh install: `.env.example` had an unquoted `ORDO_SMTP_FROM` that the Makefile sources
  - [ ] ⬜ `make backup` reports success when `pg_dump` fails (no pipefail); `make restore` doesn't stop on SQL errors
    before replacing uploads
  - [ ] ⬜ Compose trusts `X-Forwarded-For` by default while publishing on `0.0.0.0:3000`, so without a proxy anyone
    on the network can dodge per-IP sign-in limits
  - [ ] ⬜ Migrations on boot take no advisory lock, so several instances starting together race
  - [ ] ⬜ CI builds the Docker image; the Dockerfile's dependency layer copies `packages/sync/package.json`;
    workflow `permissions:` and pinned actions
- [ ] ⬜ Mobile and accessibility
  - [ ] ⬜ Issue properties can't be edited below 1024px (the sidebar is hidden and nothing replaces it)
  - [ ] ⬜ Click-to-edit descriptions (issues, projects, initiatives) can't be reached by keyboard; the mobile nav
    drawer has no Escape, hotkey scope or focus trap
- [ ] ⬜ Docs
  - [ ] ⬜ The `factory` runner-file example in agents.md can't run (string command with `./` and a temp `cwd`)
- [ ] ⬜ Code quality
  - [ ] ⬜ One optimistic-patch implementation for React Query and the sync outbox (issues and reactions)
  - [ ] ⬜ Realtime invalidates the whole bootstrap on every issue and notification event
  - [ ] ⬜ Split the remaining large settings and page files (workspace, SSO, projects, integrations, agents, teams,
    chat; 800–1000 lines each)

### Inbox focus

- [x] ✅ Delivery rules: per notification type, Inbox / Push / Email / Chat
- [x] ✅ Inbox filters: quick chips (mentions, assigned, comments, unread) and a filter modal
- [x] ✅ Status and pause: a profile menu at the bottom of the sidebar, statuses others see, "only mentions" / mute

### Phase 12 — Desktop and mobile apps

- [ ] ⬜ Desktop app
- [ ] ⬜ Mobile apps

### Project

- [ ] ⬜ Contributor agreement (CLA, or DCO with a relicensing clause) before accepting outside pull requests

## Known limitations

- Board grouped by **label** shows multi-label issues in several columns; dragging is disabled there.
