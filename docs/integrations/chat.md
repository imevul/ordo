# Chat: Slack, Discord, Matrix, Telegram

Chat integrations do four things, the same way on every service:

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
