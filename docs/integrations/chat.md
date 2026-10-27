# Chat: Slack, Discord, Matrix, Telegram

Chat integrations do five things, the same way on every service:

- **Channel feeds.** Each connected channel picks what it hears about (new issues, status changes, completed
  issues, comments, project updates) and from which teams. With no teams picked, a channel gets every _public_ team;
  private teams only ever reach channels that name them.
- **Personal notifications.** Everything that lands in your Inbox (assigned, mentioned, comments, status changes,
  urgent) also arrives as a direct message, once you've linked your chat account. Turn it off per account under
  **Settings → Connected accounts → Chat**.
- **Creating issues.** `new [TEAM] title` creates an issue as you. Reply to a message with it (or use the message
  shortcut on Slack and Discord) to file that message: it's quoted in the description and linked from the issue.
  Without a team key the issue goes to the channel's default team, then the workspace's default team.
- **Link previews.** Links to issues get a preview, but only when the person who posted the link has linked their
  account and can read the issue.
- **Threads.** An issue's first post in a channel starts its thread; comments (and the channel's other updates about
  that issue) go into it, and replies there become comments. See [Threads](#threads).

## Threads

On by default for every channel (**Sync comments in threads** in the channel's settings):

- The first post about an issue in a channel (usually _created_) starts the issue's thread there.
- Comments on the issue go into that thread, even when the channel doesn't subscribe to comments. Other updates the
  channel subscribes to (status changes, completed) go there too, instead of to the channel.
- A reply in the thread becomes a comment. If the person linked their chat account, it's theirs (as long as they can
  read the issue); otherwise it comes from the integration's bot as "**Name** via Slack: …".
- Replies synced from chat aren't posted back. Edits and deletions don't sync.

| Service  | What counts as the thread                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Slack    | The message's thread (needs `channels:history` / `groups:history` and the `message.channels` / `message.groups` events) |
| Discord  | A thread opened on the issue's message when the first comment arrives (replies need the gateway)                        |
| Matrix   | An `m.thread` on the issue's message                                                                                    |
| Telegram | Replies to the issue's message, or to replies to it                                                                     |

With threads off, a channel gets top-level posts only for what it subscribes to, and replies stay in chat.

## Linking your account

Ordo only messages you, and only lets chat act as you, once you've proven the chat account is yours:

1. **Settings → Connected accounts → Chat → Link account** shows a one-time code (valid 15 minutes).
2. Send it to the bot from your chat account: `/ordo link ABCDE-FGHIJ` on Slack and Discord, `/link ABCDE-FGHIJ` to
   the Telegram bot, `!ordo link ABCDE-FGHIJ` in a direct chat with the Matrix bot.

Send `unlink` the same way (or use the button in Ordo) to disconnect. Linking and unlinking are recorded in the audit
log.

## Commands

| Command            | What it does                                               |
| ------------------ | ---------------------------------------------------------- |
| `link CODE`        | Links your chat account to your Ordo account               |
| `new [TEAM] title` | Creates an issue; as a reply, files the message replied to |
| `unlink`           | Unlinks your chat account                                  |
| `help`             | Lists the commands                                         |

How to address the bot: `/ordo …` on Slack and Discord (or mention the bot); `/new`, `/link`… on Telegram (in groups
`/new@your_bot` works too); `!ordo …` on Matrix. In a direct chat with the bot, plain text works everywhere.

## Behind NAT

Every chat service can work without reaching Ordo:

| Service  | Ordo is reachable     | Ordo isn't reachable                     |
| -------- | --------------------- | ---------------------------------------- |
| Slack    | Events API            | Socket Mode                              |
| Discord  | Interactions endpoint | Gateway                                  |
| Telegram | Webhook               | Long polling                             |
| Matrix   | —                     | Sync (always; nothing has to reach Ordo) |

Long-lived connections run on one Ordo server at a time, under a lease that another server takes over within a
minute if that one goes away. Their state shows up on the integration (an error appears there if the connection keeps
failing) and in **Admin → Health** under leases.

Setup per service: [Slack](slack.md) · [Discord](discord.md) · [Matrix](matrix.md) · [Telegram](telegram.md).
