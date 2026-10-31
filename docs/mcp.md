# MCP server: connect AI agents

Ordo runs a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI agents such as Claude (claude.ai
and Claude Desktop connectors), Claude Code, Cursor or VS Code can search, read, file and update issues. The agent
acts as you: it sees the teams you can see, and what it changes shows up under your name. It signs in with OAuth —
you approve it in your browser — or uses one of your personal API keys.

The quickest way in is **Settings → AI agents**. It shows the server URL, gives you a snippet for each client (with
OAuth or with a key it creates for you), and has a prompt you can paste into your coding agent so it sets up the
connection itself.

## Server

- **URL:** `https://ordo.example.com/api/w/<workspace-slug>/mcp`, one per workspace.
- **Transport:** Streamable HTTP, stateless, JSON responses (no SSE streams, no sessions).
- **Protocol versions:** `2026-07-28` (per-request metadata) and `2025-11-25`, `2025-06-18`, `2025-03-26`
  (`initialize` handshake). Clients of either era work on the same URL.
- **Auth:** an OAuth access token issued for this URL (see [Signing in with OAuth](#signing-in-with-oauth)), or
  `Authorization: Bearer ordo_…`, a personal API key (Settings → API keys or Settings → AI agents). Browser
  sessions are not accepted.

## Setting up a client

### With OAuth

Clients that support OAuth only need the URL. The first time they connect, they open Ordo in your browser, where you
sign in (if you aren't already) and allow them.

- **claude.ai and Claude Desktop** — Settings → Connectors → Add custom connector, and paste the URL. Connectors are
  called from Anthropic's servers, so Ordo has to be reachable from the internet for claude.ai.
- **Claude Code** — `claude mcp add --transport http --scope user ordo-acme https://ordo.example.com/api/w/acme/mcp`,
  then `/mcp` in Claude Code and pick the server to sign in.
- **Cursor** — `{ "mcpServers": { "ordo-acme": { "url": "https://ordo.example.com/api/w/acme/mcp" } } }` in
  `~/.cursor/mcp.json`; Cursor asks you to sign in when it connects.
- **VS Code** — `{ "servers": { "ordo-acme": { "type": "http", "url": "https://ordo.example.com/api/w/acme/mcp" } } }`
  in `.vscode/mcp.json`; VS Code asks you to sign in when the server starts.

Connected apps are listed at the bottom of Settings → AI agents, where you can disconnect them.

### With an API key

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

Settings → AI agents has a copyable prompt for your coding agent. It gives the agent the URL and how to sign in,
asks it to add the server to its own MCP configuration, and to check the connection by calling `list_teams`. With an
API key, the key is left out unless you tick the box to include the one you just created.

## Signing in with OAuth

Ordo is its own OAuth 2.1 authorization server for the MCP endpoint, following the MCP authorization spec:

- **Discovery.** A request without a token gets a 401 whose `WWW-Authenticate` header points at the protected
  resource metadata (RFC 9728), `/.well-known/oauth-protected-resource/api/w/<slug>/mcp`, which names Ordo as the
  authorization server. Its metadata (RFC 8414) is at `/.well-known/oauth-authorization-server`.
- **Clients** identify themselves with a [client ID metadata document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
  (an https `client_id` pointing at a JSON description, fetched like other outbound requests, so private addresses
  are refused unless the instance allows them) or register on the fly at `/api/oauth/register` (RFC 7591).
  Redirect URIs must be https, `http://localhost`/`127.0.0.1` (any port, RFC 8252) or an app's own scheme.
- **Authorization code flow with PKCE** (`S256` only) at `/oauth/authorize`, the consent screen in the web app.
  The request must carry `resource` (RFC 8707): the workspace's MCP URL. The consent screen says which app is
  asking, whether its name is vouched for by its own domain (metadata documents) or self-chosen (registration), and
  where it will be sent back to.
- **Tokens** (`/api/oauth/token`) are bound to that workspace's MCP endpoint: every other API refuses them, and so
  does another workspace's MCP endpoint. Access tokens last an hour. Refresh tokens last 30 days and are replaced
  each time they're used; one that comes back later than 30 seconds after being used ends the whole connection,
  since it must have leaked. `/api/oauth/revoke` (RFC 7009) ends a connection from the app's side.
- The scope is `mcp`; other requested scopes are ignored.

A connection keeps working while you can sign in and are a member of the workspace. Connections approved in an SSO
login count as SSO for require-SSO workspaces, and end when that login's maximum age (if the provider sets one) is
reached. Approving and disconnecting apps is recorded in the workspace's audit log.

## Tools

Tools take the names people use: team keys (`ENG`), issue identifiers (`ENG-42`), status and label names
(case-insensitive), and people as `me`, a username, an email address or a name. UUIDs work everywhere too. Results
are JSON with names rather than ids, plus a link to each issue.

| Tool                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_teams`         | Teams you can access, with their keys and workflow statuses                                                                                                                                                                                                                                                                                                                                                                                  |
| `list_statuses`      | A team's statuses in order, with their type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`)                                                                                                                                                                                                                                                                                                                           |
| `list_members`       | People in the workspace: name, username, role (guests don't see other people's email)                                                                                                                                                                                                                                                                                                                                                        |
| `list_labels`        | Workspace labels and team labels (`team` limits it to labels usable in that team)                                                                                                                                                                                                                                                                                                                                                            |
| `list_custom_fields` | [Custom fields](#custom-fields): name, type, team (`null` for workspace fields) and option names (`team` limits it to the fields that team's issues have)                                                                                                                                                                                                                                                                                    |
| `list_projects`      | Projects with status, health, lead, teams, dates, progress and milestones (name, target date, progress)                                                                                                                                                                                                                                                                                                                                      |
| `list_cycles`        | Current and upcoming cycles per team (`includePast` for ended ones)                                                                                                                                                                                                                                                                                                                                                                          |
| `create_cycle`       | `team`, `startsAt`, `endsAt` (the day after its last day, where the next cycle starts), optional `name` and `description`; it gets the team's next number                                                                                                                                                                                                                                                                                    |
| `update_cycle`       | `team` and `cycle` (a number, name, id or `current`), then any of `startsAt`, `endsAt`, `name`, `description` (`null` clears a name or description)                                                                                                                                                                                                                                                                                          |
| `create_milestone`   | `project`, `name`, optional `targetDate` and `description`; added after the project's other milestones                                                                                                                                                                                                                                                                                                                                       |
| `update_milestone`   | `project` and `milestone` (by name), then any of `name`, `targetDate`, `description` (`null` clears a date or description)                                                                                                                                                                                                                                                                                                                   |
| `search_issues`      | Text (`query`) and filters: `team`, `status`, `statusType`, `assignee` (or `none`), `creator`, `labels`, `project`, `cycle` (`current`, a number, or `none`), `priority`, `customFields` (field name → values, or `none`), `subscribed`. Open issues only unless `includeClosed`, `status` or `statusType` is set. Best matches first with a `query` (titles, descriptions and comments), otherwise newest activity first; `limit` up to 250 |
| `my_issues`          | Open issues assigned to you, most urgent first (`includeClosed` for all)                                                                                                                                                                                                                                                                                                                                                                     |
| `get_issue`          | One issue in full: description, comments (with ids, for replies), sub-issues, relations, links                                                                                                                                                                                                                                                                                                                                               |
| `create_issue`       | `team` and `title`, plus `description`, `status`, `priority`, `assignee`, `labels`, `project`, `milestone` (in that project), `cycle`, `parent`, `estimate`, `dueDate`, `customFields` (by name, see below)                                                                                                                                                                                                                                  |
| `update_issue`       | Any of the above (`null` clears assignee, project, milestone, cycle, parent, estimate or due date; a `milestone` without `project` is looked up in the issue's project); `labels` replaces all, `addLabels` / `removeLabels` change some; `customFields` sets the fields given (`null` clears one); `team` moves the issue                                                                                                                   |
| `add_relation`       | `issue`, `type` (`blocks`, `blocked_by`, `related`, `duplicate_of`) and `other`; replaces an earlier relation between the two. Agents wait to work on a blocked issue until its blockers are done ([agents](agents.md#day-to-day))                                                                                                                                                                                                           |
| `remove_relation`    | `issue` and `other`: removes the relation between them                                                                                                                                                                                                                                                                                                                                                                                       |
| `add_comment`        | Markdown comment; `@username` mentions notify; `replyTo` answers a comment                                                                                                                                                                                                                                                                                                                                                                   |
| `issue_time`         | [Time tracking](user-guide.md#time-tracking) (when the workspace has it on): an issue's entries and total                                                                                                                                                                                                                                                                                                                                    |
| `log_time`           | `issue`, `duration` (`1h 30m`, `45m`, `1.5h`, `1:30`), optional `note` and `date` (default today)                                                                                                                                                                                                                                                                                                                                            |
| `start_timer`        | `issue`, optional `note`; a timer you have running elsewhere stops first                                                                                                                                                                                                                                                                                                                                                                     |
| `stop_timer`         | Stops your running timer and logs the time                                                                                                                                                                                                                                                                                                                                                                                                   |
| `time_report`        | `from`, `to` (days, inclusive), optional `person`, `team`, `project`, `cycle`: totals by person and project, and entries                                                                                                                                                                                                                                                                                                                     |
| `list_agents`        | [Agents](agents.md) in the workspace and the teams they work in                                                                                                                                                                                                                                                                                                                                                                              |
| `assign_to_agent`    | `issue`, `agent`, optional `note` (posted as a comment first, so the run reads it); if the agent already has the issue, it runs again                                                                                                                                                                                                                                                                                                        |
| `agent_runs`         | An issue's runs, newest first: agent, status, runner, attempt, session link, summary or error, `usage` (tokens, `costUsd`, `durationMs`) when reported; each with its `run` id                                                                                                                                                                                                                                                               |
| `list_agent_runs`    | What agents are doing across the workspace, each with its `run` id and `usage`: `status` `active` (default: queued, working, waiting for an answer), `open` (active plus failed runs nobody has restarted or dismissed), `finished` or `all`; optional `agent`                                                                                                                                                                               |
| `rerun_agent`        | Queue another run for the issue's agent, with an optional `note` such as review feedback                                                                                                                                                                                                                                                                                                                                                     |
| `cancel_agent_run`   | Stop the queued or running work on an issue                                                                                                                                                                                                                                                                                                                                                                                                  |
| `restart_agent_run`  | Restart the latest failed or cancelled run on `issue` as a new run (same agent, issue and trigger), mention runs included; `agent` picks one when several agents' runs failed, or give `run` (an id from `agent_runs`)                                                                                                                                                                                                                       |
| `dismiss_agent_run`  | Set that run aside without restarting it; a failed run then leaves the `open` runs (a cancelled one was never in them); same arguments                                                                                                                                                                                                                                                                                                       |
| `current_run`        | _Agent keys only._ The runs the agent holds now, with their issues                                                                                                                                                                                                                                                                                                                                                                           |
| `report_run`         | _Agent keys only._ On a held run (`run`, or the only one): `sessionUrl`, `status` (`running`, `succeeded`, `failed`), `summary`, `error`, `resume` (handed back on the next pickup); finishing posts the summary on the issue                                                                                                                                                                                                                |
| `report_progress`    | _Agent keys only._ On a held run (`run`, or the only one): `step`, a few words on what it's doing now, and an optional rough `percent` (0–100). The latest one shows on the run in Ordo; it isn't a comment or a webhook event. A claimed run counts as running from then on                                                                                                                                                                 |
| `ask_question`       | _Agent keys only._ Ask a person and pause the run: posted on the issue with a mention; a person's reply resumes it ([questions](agents.md#questions))                                                                                                                                                                                                                                                                                        |

Priorities are `0`–`4` or `none`, `urgent`, `high`, `medium`, `low`. The input schemas are in
[`packages/shared/src/mcp.ts`](../packages/shared/src/mcp.ts).

### Custom fields

`create_issue` and `update_issue` take `customFields`, an object of field name → value, resolved against the fields
of the issue's team (case-insensitive; field and option ids work too):

| Field type   | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| select       | An option name: `"Gold"`                                       |
| multi-select | A list of option names: `["API", "Web"]`                       |
| number       | A number: `5`                                                  |
| date         | `"2026-01-31"`                                                 |
| text         | A string                                                       |
| person       | Like `assignee`: `"me"`, a username, an email, a name or an id |

`null` clears a field; fields left out keep their value. An unknown field or option is an error that lists the valid
ones. Issues in results have `customFields` the same way, by field name with option names and usernames (left out
when the issue has none). `search_issues` takes `customFields` as field name → list of values (`none` for issues
without one), and matches issues with any of the values.

```json
{
  "issue": "ENG-42",
  "customFields": { "Customer tier": "Gold", "Areas": ["API"], "Story points": null }
}
```

Changes go through the same code as the web app and the REST API: history, subscriptions, notifications, realtime
updates and webhooks all happen as usual. Webhook events and integrations see them with `"source": "mcp"`.

A tool that fails (an unknown status, an issue you can't see, invalid input) returns a result with `isError: true`
and a message meant for the model, often listing the valid choices, so the agent can correct itself.

## Access and limits

- **Same access as you.** The agent sees exactly the teams, issues, projects and labels you can, and can do what
  your role allows (guests only in their teams). Issues in teams you can't see are "not found".
- **Require SSO.** If the workspace requires SSO, API keys are refused unless an admin turned on **Allow API keys**
  (Settings → Authentication); the agent gets a 403 (`sso_required`). OAuth works when you approved the app while
  signed in with the workspace's SSO. Workspace owners are exempt.
- **Revoking** the key under Settings → API keys, or disconnecting the app under Settings → AI agents, disconnects
  the agent at once.
- **Rate limit:** 600 requests a minute per user.
- **Results:** searches return up to 250 issues; `truncated: true` means there are more, so narrow the filters.
- Browser requests from other origins are refused (403), per the MCP spec's DNS-rebinding guidance.

## Errors

Transport and auth failures come back as JSON-RPC errors with an HTTP status:

| HTTP | `error.code` | Meaning                                                                                       |
| ---- | ------------ | --------------------------------------------------------------------------------------------- |
| 401  | `401`        | Missing, expired or revoked token or key (`WWW-Authenticate` points at the OAuth metadata)    |
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
