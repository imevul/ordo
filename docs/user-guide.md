# User guide

Ordo is built around a few concepts borrowed from Linear. If you know Linear you'll feel at home; the
[keyboard shortcuts](keyboard-shortcuts.md) are nearly the same.

## Workspaces, members and roles

A **workspace** is your organization: its URL is `ordo.example.com/<workspace>`. You can belong to several and
switch from the menu under the Ordo logo. Everyone in a workspace has a role:

| Role       | Can                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**  | Everything an admin can, plus grant or remove ownership. Every workspace keeps at least one owner.                                                                          |
| **Admin**  | Manage members, invites, teams, workspace settings and the audit log; see every team, including private ones; delete issues permanently.                                    |
| **Member** | Work in every public team and in private teams they belong to; create teams, projects, views and labels.                                                                    |
| **Guest**  | Only see and work on issues in the teams they've been added to. Guests can't create teams, projects, views, labels or cycles, and don't see other people's email addresses. |

Invite people from **Settings → Members**: paste one or more email addresses (each gets an emailed invite when
email is set up) or leave it empty for a shareable link; choose member, guest or admin, and the teams they should
join. An invite with an email address works once, for that address; an open link works for anyone until it
expires. Pending invites can be copied, resent or revoked. By default only admins invite; **Settings → Access**
can let members invite too (never as admins).

Admins can **suspend** a member — they keep their history but can't open the workspace — and restore them later.

### Workspace settings

- **General** — name, URL, logo, an **accent colour** (Hotline Pink by default; pick a preset or any colour), and a
  **default team** every new member (except guests) joins automatically.
- **Access** — who may invite; **domains** you've verified with a DNS TXT record
  (`_ordo-verify.example.com` → `ordo-verify=…`); and **join by domain**, which lets anyone with a _verified_ email at
  one of those domains join without an invite (as member or guest). They'll see the workspace when they sign up.
- **Authentication** — single sign-on with your own identity provider (OpenID Connect), group → role mapping, and
  **require SSO**. See [SSO](sso.md).
- **Integrations** — connect GitHub, GitLab or Forgejo/Gitea, and Slack, Discord, Matrix or Telegram; see
  [integrations](integrations/README.md).
- **Webhooks** — send issue, comment, project and cycle events to your own endpoints, signed, with a delivery log,
  test button and redelivery ([API docs](api.md#webhooks)).
- **Import & export** — bring issues in from a CSV file, Linear, GitHub, GitLab, Forgejo/Gitea or Jira (with a
  dry run first, and undo afterwards), merge people from imports into members who've joined, and export the
  workspace as JSON or CSV. See [importing data](import-export.md).
- **Audit log** — security-relevant changes: invites, role changes, team changes, domains, and more.
- **Danger zone** (owners) — **transfer ownership** to another member (you become an admin), or **delete** the
  workspace for good.

## Teams

Issues belong to a **team**. Each team has a short **key** (`ENG`) that prefixes its issue identifiers
(`ENG-42`), its own **workflow**, **estimate scale**, and optional **triage** and **cycles**. Join the teams you
work in — they show up under _Your teams_ in the sidebar. Configure a team in **Settings → Your teams**.

### Workflow

Statuses are grouped into six types that drive behavior:

| Type      | Meaning                                             | Default statuses       |
| --------- | --------------------------------------------------- | ---------------------- |
| Triage    | Incoming, not yet accepted (only when triage is on) | Triage                 |
| Backlog   | Accepted but not planned                            | Backlog                |
| Unstarted | Planned, ready to pick up                           | Todo                   |
| Started   | In progress — sets _started at_                     | In Progress, In Review |
| Completed | Done — sets _completed at_, counts toward progress  | Done                   |
| Canceled  | Won't do                                            | Canceled, Duplicate    |

Rename, recolor, add and delete statuses freely; every type except triage keeps at least one. The **default**
status is where new issues land.

## Issues

Create an issue with `C` (or the pen icon). Type a title, optionally a description, then set
properties with the chips below — or press `Mod Enter` straight away. Toggle **Create more** to keep the
dialog open for the next one.

**Templates** give new issues a head start. Pick one under **Template** at the top of the dialog: it switches to the
template's team, sets the properties it defines (status, priority, assignee, labels, project, estimate), and fills
in its title and description — keeping what you already typed, with the template's description added below yours.
Manage templates under **Settings → Templates**; anyone but guests can. Templates for all teams appear everywhere,
team templates only in that team (and only a team template can set a status).

Properties: **status, priority** (urgent, high, medium, low, none), **assignee, labels, project, cycle,
estimate, due date**, and a **parent** issue. Change any of them from the issue page's sidebar, from the icons
in a list row, by dragging on the board, or with the keyboard (`S`, `P`, `A`, `L`, …).

- **Sub-issues** — _Add_ under _Sub-issues_ on an issue. The parent shows `done/total`.
- **Relations** — _blocks_, _blocked by_, _related to_, _duplicate of_. Marking an issue as a duplicate moves it to
  the team's _Duplicate_ (or first canceled) status.
- **Comments** — rich text, replies, edits, `@username` mentions (with autocomplete). Mentioned people are notified
  and subscribed. Issue identifiers like `ENG-12` in text become links.
- **Reactions** — the smiley on a comment adds an emoji; click a reaction to add or take back yours, hover it to see
  who reacted. The comment's author finds reactions in their Inbox (not emailed unless they turn it on).
- **Attachments** — paste or drop files into a description or comment (or use the paperclip), or drop them on the
  issue's _Attachments_ section. See below.
- **Activity** — every property change is recorded with who and when.
- **Subscribe** to follow an issue. You're subscribed automatically when you create it, are assigned to it,
  comment on it or are mentioned.
- **Move to another team** from the _Team_ property — the issue gets a new identifier and the closest
  matching status.
- **Delete** moves the issue to the **Trash**, where anyone can restore it and admins can delete it for good.
- **Archive** (in the `…` menu) takes an issue out of lists and boards without deleting it: it still opens by link,
  shows up in search (tagged _archived_) and under the team's **Archived** tab. _Unarchive_ brings it back, and so
  does reopening it. Teams can archive closed issues automatically: team settings → _Auto-archive_, 1 to 12 months
  after they were completed or canceled (off by default). The **Ordo** bot does the archiving.
- **Copy git branch name** in the `…` menu gives you `eng-42-short-title`.

### Writing descriptions and comments

Descriptions, comments, project descriptions and project updates use a rich text editor: what you write shows
formatted as you type. Markdown shortcuts work (`## ` for a heading, `- ` for a list, `[ ] ` for a checklist,
`**bold**`, `` `code` ``, three backticks for a code block — see [keyboard shortcuts](keyboard-shortcuts.md#editing)),
and selecting text brings up buttons for bold, italic, strikethrough, code and links. Pasting a link over selected
text links it. Tables and images from Markdown are kept and editable.

Prefer writing Markdown yourself? Click **// markdown** under the editor to edit the source (with a preview); your
browser remembers the choice. Ordo stores everything as Markdown either way, so the API, MCP, webhooks and chat
messages see the same text. Text containing raw HTML or footnotes always opens in the Markdown view, because the rich
editor can't keep those.

### Attachments

Files you paste, drop or pick in a description or comment are uploaded and linked where your cursor is: images show
inline, anything else as a link. Every file also appears under **Attachments** on the issue, with its size, who added
it and when; the uploader and team admins can remove it there. Files dropped on that section are attached without
touching the text.

Attachments are as private as their issue: only people who can see the issue can open them, and their links keep
working if the workspace URL changes. Images (PNG, JPEG, GIF, WebP) open in the browser; every other file downloads.
The size limit is 25 MB unless your instance admin changed it. Files pasted into an issue you then don't create are
deleted after a day.

### Links

The **Links** section of an issue collects what lives elsewhere: pull requests, branches and commits from connected
forges, chat messages, and any URL you add with **Add link**. Forge links show their state (open, draft, review,
merged, closed).

With a forge connected, name your branch after the issue (**Copy git branch name** in the issue menu, or
`Mod Shift .`) or put its identifier in the PR title, and the issue moves along by itself: in progress when the PR
opens, in review when someone's asked to review, done when it merges. Write `Fixes ENG-42` in a description or
commit to do the same from there; `Part of ENG-42` only links. Each team picks the statuses under **Team settings →
Git automation**. Details: [integrations](integrations/README.md).

## Lists and boards

Every issue screen (team issues, my issues, project and cycle issues, views) works the same way:

- **Filter** narrows by status, priority, assignee, creator, labels, project or cycle. Filters combine with AND;
  values within one filter combine with OR.
- **Display** sets grouping, ordering and whether to show completed issues, sub-issues and empty groups.
- The **list / board** toggle (or `V`) switches layouts. On the board, drag cards between columns to change the
  grouped property, and within a column to reorder (when ordering is _Manual_).
- Select issues with `X`, shift-click or the checkbox, then use the bar at the bottom or the keyboard to
  change them all at once.

Your layout, grouping and filters are remembered per screen in your browser.

Team screens have tabs: **All**, **Active** (unstarted + started), **Backlog**, and **Triage** when enabled.

## Views

Filter any list, then **Save view** to give it a name. Views are shared with the workspace unless you untick
the option. Open one from **Views** in the sidebar; change its filters or display and press **Save** to
update it. Star views and projects to pin them under _Favorites_.

## My issues and Inbox

**My issues** has three tabs: assigned to you, created by you, and subscribed.

The **Inbox** collects notifications: assigned / unassigned, mentions, comments and status changes on issues you
follow, issues marked urgent, and reactions to your comments. Select one to read the issue alongside. `U` toggles read, `⌫` deletes;
the header buttons mark everything read or clear read notifications.

## Cycles

Cycles are a team's time-boxed iterations (usually 1–2 weeks). Turn them on per team, create them under
**Cycles** (dates default to the two weeks after the last cycle), and assign issues with the _Cycle_ property
or `Shift C`. A cycle page shows scope, started, completed and remaining counts, with points when you use
estimates.

**Cycle automation** (team settings → _Cycle automation_) lets cycles run themselves. Pick a length (1–8 weeks), an
optional cooldown, the weekday they start on and how many to plan ahead; Ordo then keeps that many cycles on the
calendar. When a cycle ends, its unfinished issues move to the next one (_Roll over unfinished issues_), and with
_Add started issues to the active cycle_, issues join the current cycle as soon as work on them starts. These changes
are made by a bot called **Ordo**, without notifications, and show in each issue's history. Cycles that had already
ended when you turned automation on keep their issues.

## Projects

Projects collect issues toward a goal, possibly across teams. Each has a **status** (backlog, planned, in
progress, paused, completed, canceled), a **lead**, **start** and **target dates**, a color and a brief.
Post **project updates** with a health (on track, at risk, off track) to keep everyone informed; the latest
health shows in the project list. Progress is computed from the project's issues.

## Labels and estimates

Labels are workspace-wide or limited to one team (**Settings → Labels**, or create one on the fly from the label
picker). Teams choose an estimate scale: linear (1–5), Fibonacci (1–13), exponential (1–16), t-shirt (XS–XL) or
none.

## Search and the command menu

`/` opens search: words in titles, descriptions and comments (matched as you type, best matches first, any
language), or an identifier like `ENG-12`. `Mod K` opens the command menu: type to jump anywhere, create things, or —
with issues focused or selected — change their properties. Search results appear in the command menu after two
characters.

## Your account

Open **Settings** (workspace menu, or `G` then `S`):

- **Profile** — name, `@username`, picture (cropped to a square in your browser) or initials colour, time zone and
  first day of the week. Your email address: change it (the new address must be confirmed by a link when email is
  set up) and see whether it's verified.
- **Security** — change your password (this signs out your other sessions); turn on **two-factor authentication**
  with any authenticator app, and keep the ten recovery codes somewhere safe — each works once if you lose your
  device; see and revoke your **sessions**.
- **Connected accounts** — sign-in identities you've linked (and a button to connect your workspace's SSO
  provider), your usernames on connected forges so your pull requests show as yours, and your **chat** accounts:
  link one with a one-time code to get notifications as direct messages and to create issues from chat
  ([chat](integrations/chat.md)).
- **Notifications** — everything lands in your Inbox; choose which kinds are also emailed and how often (within a few
  minutes, hourly, daily, or never). Anything you read in the app first isn't emailed.
- **API keys** — personal keys for scripts and integrations ([API docs](api.md)).
- **AI agents** — connect Claude Code, Claude Desktop, Cursor or VS Code to Ordo's MCP server: the URL, a key,
  setup snippets and a prompt that lets your agent set itself up ([MCP docs](mcp.md)).

If your workspace uses single sign-on, enter your work email on the sign-in page and pick **Continue with …**, or
use **Sign in with SSO** and type your workspace's URL name.

Forgot your password? Use **Forgot password?** on the sign-in page (needs email to be set up on the instance).
