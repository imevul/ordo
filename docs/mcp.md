# MCP server: connect AI agents

Ordo runs a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI agents such as Claude Code,
Claude Desktop, Cursor or VS Code can search, read, file and update issues. The agent uses one of your personal API
keys and acts as you: it sees the teams you can see, and what it changes shows up under your name.

The quickest way in is **Settings → AI agents**. It shows the server URL, creates a key, gives you a snippet for
each client, and has a prompt you can paste into your coding agent so it sets up the connection itself.

## Server

- **URL:** `https://ordo.example.com/api/w/<workspace-slug>/mcp`, one per workspace.
- **Transport:** Streamable HTTP, stateless, JSON responses (no SSE streams, no sessions).
- **Protocol versions:** `2026-07-28` (per-request metadata) and `2025-11-25`, `2025-06-18`, `2025-03-26`
  (`initialize` handshake). Clients of either era work on the same URL.
- **Auth:** `Authorization: Bearer ordo_…`, a personal API key (Settings → API keys or Settings → AI agents).
  Browser sessions are not accepted, and there is no OAuth sign-in yet.

## Setting up a client

Replace the URL with yours and `YOUR_ORDO_API_KEY` with a key. Keep keys out of files you commit.

**Claude Code**

```bash
claude mcp add --transport http --scope user ordo-acme https://ordo.example.com/api/w/acme/mcp \
  --header "Authorization: Bearer YOUR_ORDO_API_KEY"
```

`--scope user` makes it available in every project; leave it out to add it to the current project only. Check with
`claude mcp list`, or `/mcp` inside Claude Code.

**Claude Desktop** — Settings → Developer → Edit config (`claude_desktop_config.json`), then restart. Claude
Desktop's config file only starts local servers, so this uses the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
bridge (needs Node.js):

```json
{
  "mcpServers": {
    "ordo-acme": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://ordo.example.com/api/w/acme/mcp",
        "--header",
        "Authorization:${ORDO_AUTH}"
      ],
      "env": { "ORDO_AUTH": "Bearer YOUR_ORDO_API_KEY" }
    }
  }
}
```

**claude.ai connectors** sign in with OAuth, which Ordo doesn't offer yet, and need a server that is reachable
from the internet. Use Claude Desktop or Claude Code for now.

**Cursor** — `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ordo-acme": {
      "url": "https://ordo.example.com/api/w/acme/mcp",
      "headers": { "Authorization": "Bearer YOUR_ORDO_API_KEY" }
    }
  }
}
```

**VS Code** — `.vscode/mcp.json` or "MCP: Open User Configuration". VS Code asks for the key once and keeps it in
its secret storage:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "ordo-api-key",
      "description": "Ordo API key",
      "password": true
    }
  ],
  "servers": {
    "ordo-acme": {
      "type": "http",
      "url": "https://ordo.example.com/api/w/acme/mcp",
      "headers": { "Authorization": "Bearer ${input:ordo-api-key}" }
    }
  }
}
```

**Anything else** that speaks Streamable HTTP: the URL plus the `Authorization` header.

### Let the agent do it

Settings → AI agents has a copyable prompt for your coding agent. It gives the agent the URL and where the key
goes, asks it to add the server to its own MCP configuration, and to check the connection by calling `list_teams`.
The key is left out unless you tick the box to include the one you just created.

## Tools

Tools take the names people use: team keys (`ENG`), issue identifiers (`ENG-42`), status and label names
(case-insensitive), and people as `me`, a username, an email address or a name. UUIDs work everywhere too. Results
are JSON with names rather than ids, plus a link to each issue.

| Tool            | What it does                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_teams`    | Teams you can access, with their keys and workflow statuses                                                                                                                                                                                                                                                |
| `list_statuses` | A team's statuses in order, with their type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`)                                                                                                                                                                                         |
| `list_members`  | People in the workspace: name, username, role (guests don't see other people's email)                                                                                                                                                                                                                      |
| `list_labels`   | Workspace labels and team labels (`team` limits it to labels usable in that team)                                                                                                                                                                                                                          |
| `list_projects` | Projects with status, health, lead, teams, dates and progress                                                                                                                                                                                                                                              |
| `list_cycles`   | Current and upcoming cycles per team (`includePast` for ended ones)                                                                                                                                                                                                                                        |
| `search_issues` | Text (`query`) and filters: `team`, `status`, `statusType`, `assignee` (or `none`), `creator`, `labels`, `project`, `cycle` (`current`, a number, or `none`), `priority`, `subscribed`. Open issues only unless `includeClosed`, `status` or `statusType` is set. Newest activity first; `limit` up to 250 |
| `my_issues`     | Open issues assigned to you, most urgent first (`includeClosed` for all)                                                                                                                                                                                                                                   |
| `get_issue`     | One issue in full: description, comments (with ids, for replies), sub-issues, relations, links                                                                                                                                                                                                             |
| `create_issue`  | `team` and `title`, plus `description`, `status`, `priority`, `assignee`, `labels`, `project`, `cycle`, `parent`, `estimate`, `dueDate`                                                                                                                                                                    |
| `update_issue`  | Any of the above (`null` clears assignee, project, cycle, parent, estimate or due date); `labels` replaces all, `addLabels` / `removeLabels` change some; `team` moves the issue                                                                                                                           |
| `add_comment`   | Markdown comment; `@username` mentions notify; `replyTo` answers a comment                                                                                                                                                                                                                                 |

Priorities are `0`–`4` or `none`, `urgent`, `high`, `medium`, `low`. The input schemas are in
[`packages/shared/src/mcp.ts`](../packages/shared/src/mcp.ts).

Changes go through the same code as the web app and the REST API: history, subscriptions, notifications, realtime
updates and webhooks all happen as usual. Webhook events and integrations see them with `"source": "mcp"`.

A tool that fails (an unknown status, an issue you can't see, invalid input) returns a result with `isError: true`
and a message meant for the model, often listing the valid choices, so the agent can correct itself.

## Access and limits

- **Same access as you.** The agent sees exactly the teams, issues, projects and labels you can, and can do what
  your role allows (guests only in their teams). Issues in teams you can't see are "not found".
- **Require SSO.** If the workspace requires SSO, API keys are refused unless an admin turned on **Allow API keys**
  (Settings → Authentication); the agent gets a 403 (`sso_required`). Workspace owners are exempt.
- **Revoking** the key under Settings → API keys disconnects the agent at once.
- **Rate limit:** 600 requests a minute per user.
- **Results:** searches return up to 250 issues; `truncated: true` means there are more, so narrow the filters.
- Browser requests from other origins are refused (403), per the MCP spec's DNS-rebinding guidance.

## Errors

Transport and auth failures come back as JSON-RPC errors with an HTTP status:

| HTTP | `error.code` | Meaning                                                                                       |
| ---- | ------------ | --------------------------------------------------------------------------------------------- |
| 401  | `401`        | Missing, unknown or revoked API key (with `WWW-Authenticate: Bearer`)                         |
| 403  | `403`        | The workspace requires SSO and doesn't allow API keys (`data.error: "sso_required"`)          |
| 404  | `404`        | No such workspace, or you're not a member                                                     |
| 400  | `-32020`     | `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` header doesn't match the body (2026-07-28) |
| 400  | `-32022`     | Unsupported protocol version; `data.supported` lists the ones Ordo speaks                     |
| 400  | `-32700`     | The body isn't JSON                                                                           |
| 404  | `-32601`     | Unknown method (2026-07-28; earlier versions get HTTP 200)                                    |
| 405  | —            | `GET` / `DELETE`: there are no SSE streams or sessions to open or close                       |
| 429  | `429`        | Rate limited                                                                                  |

## Trying it with curl

```bash
curl -s https://ordo.example.com/api/w/acme/mcp \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_issues","arguments":{"limit":5}}}'
```
