# Integrations

Admins connect integrations under **Settings → Integrations**. Each one runs as a bot account (shown as the author
of what it does), keeps its tokens encrypted, and shows its status and last error there. Disconnecting one removes the
webhooks Ordo created; links on issues stay, and its past changes keep its name, tagged _removed_.

| Integration                    | What it does                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| [GitHub](github.md)            | Links PRs, branches and commits; moves issues as PRs progress     |
| [GitLab](gitlab.md)            | The same for merge requests, on GitLab.com or self-managed GitLab |
| [Forgejo / Gitea](forgejo.md)  | The same for Forgejo, Gitea and Codeberg                          |
| [Slack](slack.md)              | Channel feeds, notifications by DM, issues from messages, unfurls |
| [Discord](discord.md)          | The same on Discord                                               |
| [Matrix](matrix.md)            | The same on any Matrix homeserver                                 |
| [Telegram](telegram.md)        | The same with a Telegram bot                                      |
| [Email](email.md)              | Mail to an address becomes triage issues, filed under customers   |
| [Jira](jira.md)                | Links Jira issues, mirrors Jira projects, or syncs both ways      |
| [Webhooks](../api.md#webhooks) | Your own endpoints, for anything else                             |

What the chat integrations share (feeds, linking accounts, commands) is in [chat](chat.md). For moving data over once, see
the importers under **Settings → Import & export**.

## Public or private instances

Every integration works when Ordo can't be reached from outside; for chat, see [behind NAT](chat.md#behind-nat).
Every forge integration works in two modes:

- **Webhooks** — the forge tells Ordo about changes the moment they happen. The forge must be able to reach
  `ORDO_PUBLIC_URL`.
- **Polling** — Ordo asks the forge every two minutes. Use this when Ordo sits behind NAT, a VPN or a firewall the
  forge can't get through. Polling picks up pull and merge requests (and, for GitHub, commits on the default
  branch); pushed branches and other commits are only seen with webhooks.

If your forge lives on your LAN, turn on **Allow private network targets** in the admin area (or set
`ORDO_ALLOW_PRIVATE_NETWORK_TARGETS=true`), otherwise Ordo refuses to connect to private addresses.

## How linking works

| Where                                                     | Example                          | Links | Moves the issue |
| --------------------------------------------------------- | -------------------------------- | ----- | --------------- |
| Branch name                                               | `ada/eng-42-flux-capacitor`      | ✓     | ✓               |
| Pull request title                                        | `ENG-42: Fix the flux capacitor` | ✓     | ✓               |
| Description, after a closing word                         | `Fixes ENG-42, ENG-43`           | ✓     | ✓               |
| Description, after a reference word                       | `Part of ENG-42`                 | ✓     |                 |
| Commit message                                            | `ENG-42: tidy up`                | ✓     |                 |
| Commit message with a closing word, on the default branch | `Closes ENG-42`                  | ✓     | ✓ (to Done)     |

Closing words: close, closes, closed, closing, fix, fixes, fixed, fixing, resolve, resolves, resolved, resolving,
complete, completes, completed, completing. Reference words: ref, refs, references, part of, related to,
contributes to, towards. A word applies to the whole list after it (`Fixes ENG-1, ENG-2 and ENG-3`).

Old identifiers keep working after a team's key changes.

## Status automation

Each team chooses where linked issues go (**Team settings → Git automation**):

| Event            | Default                              |
| ---------------- | ------------------------------------ |
| Branch pushed    | No change                            |
| Draft PR opened  | The team's first "started" status    |
| PR opened        | The team's first "started" status    |
| Review requested | A started status named like "review" |
| PR merged        | The team's first "completed" status  |

Issues only ever move forward: a PR opened for something already in review or done leaves it there, and canceled
issues stay canceled. Closing a PR without merging changes nothing.

## Credit where it's due

Everyone can add their forge usernames under **Settings → Connected accounts → Git usernames**. Pull requests they open then
show as theirs. Claims aren't verified with the forge; each username can be claimed once per workspace.

## "Copy git branch name"

The issue menu (or `Mod Shift .`) copies a branch name like `ada/eng-42-fix-the-flux-capacitor`. Admins change the
format under **Settings → General → Git branch names** with `{username}`, `{identifier}` and `{title}`.
