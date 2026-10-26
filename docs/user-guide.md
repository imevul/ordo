# User guide

Ordo is built around a few concepts: workspaces hold teams, teams hold issues, and cycles, projects and views cut
across them. Nearly everything has a [keyboard shortcut](keyboard-shortcuts.md).

## Workspaces and members

A **workspace** is your organization: its URL is `ordo.example.com/<workspace>`. You can belong to several and
switch from the menu under the Ordo logo. Members are **admins** (manage members, invites, workspace settings,
delete teams, empty the trash) or **members** (everything else).

Invite people from **Settings → Members**. An invite with an email address works once, for that address; an
invite without one is a link anyone can use until it expires.

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

Create an issue with `C` (or the pen icon). Type a title, optionally a markdown description, then set
properties with the chips below — or press `Mod Enter` straight away. Toggle **Create more** to keep the
dialog open for the next one.

Properties: **status, priority** (urgent, high, medium, low, none), **assignee, labels, project, cycle,
estimate, due date**, and a **parent** issue. Change any of them from the issue page's sidebar, from the icons
in a list row, by dragging on the board, or with the keyboard (`S`, `P`, `A`, `L`, …).

- **Sub-issues** — _Add_ under _Sub-issues_ on an issue. The parent shows `done/total`.
- **Relations** — _blocks_, _blocked by_, _related to_, _duplicate of_. Marking an issue as a duplicate moves it to
  the team's _Duplicate_ (or first canceled) status.
- **Comments** — markdown, replies, edits, `@username` mentions (with autocomplete). Mentioned people are notified
  and subscribed. Issue identifiers like `ENG-12` in text become links.
- **Activity** — every property change is recorded with who and when.
- **Subscribe** to follow an issue. You're subscribed automatically when you create it, are assigned to it,
  comment on it or are mentioned.
- **Move to another team** from the _Team_ property — the issue gets a new identifier and the closest
  matching status.
- **Delete** moves the issue to the **Trash**, where anyone can restore it and admins can delete it for good.
- **Copy git branch name** in the `…` menu gives you `eng-42-short-title`.

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
follow, and issues marked urgent. Select one to read the issue alongside. `U` toggles read, `⌫` deletes;
the header buttons mark everything read or clear read notifications.

## Cycles

Cycles are a team's time-boxed iterations (usually 1–2 weeks). Turn them on per team, create them under
**Cycles** (dates default to the two weeks after the last cycle), and assign issues with the _Cycle_ property
or `Shift C`. A cycle page shows scope, started, completed and remaining counts, with points when you use
estimates.

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

`/` opens search (title, description, or identifier). `Mod K` opens the command menu: type to jump anywhere,
create things, or — with issues focused or selected — change their properties. Search results appear in the
command menu after two characters.

## Your account

**Settings → Profile** for your name, `@username` and avatar color; **Password** signs out other sessions on
change. **API keys** lets you create personal keys for scripts and integrations ([API docs](api.md)).
