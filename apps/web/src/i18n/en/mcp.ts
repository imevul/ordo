/** Settings → AI agents: connecting MCP clients, and the apps signed in with OAuth. */
export default {
  connect: {
    title: 'Connect an AI agent',
    /** {workspace} and {doc} (docs/mcp.md) are styled spans. */
    description:
      'Ordo runs an MCP server for {workspace}. Agents such as Claude, Claude Code, Cursor or VS Code connect to it and act as you: they see the teams you can see, and what they change shows up under your name. Most sign in with OAuth — you approve them in the browser and can disconnect them below. Others use one of your API keys. See {doc}.',
    blockedKicker: '// api keys are blocked here',
    blockedBody:
      '{workspace} requires SSO and doesn’t allow API keys. Sign agents in with OAuth instead, or ask an admin to allow keys under Settings → Authentication.',
    serverUrl: 'Server URL',
    serverUrlHint: 'One URL per workspace. The transport is Streamable HTTP.',
    signInWith: 'Sign in with',
    signInWithHint: 'OAuth needs no key; use a key for clients without it.',
    apiKey: 'API key',
  },
  key: {
    title: 'Create a key for the agent',
    description: 'A personal API key, shown once. You can revoke it any time under API keys.',
    /** Default name of the new API key. */
    defaultName: 'AI agent',
    nameLabel: 'Key name',
    create: 'Create key',
    copyNow: "// copy it now — it won't be shown again",
    fillIntoSnippets: 'Fill this key into the setup snippets below',
  },
  setup: {
    title: 'Set it up yourself',
    cantConnect: '{client} can’t connect this way.',
    clientsLabel: 'MCP client',
    /** {placeholder} is YOUR_ORDO_API_KEY in the snippet. */
    replacePlaceholder: 'Replace {placeholder} with your key.',
    /** Tab for MCP clients not listed by name. */
    otherClient: 'Other',
    claudeOauth:
      'In claude.ai or Claude Desktop: Settings → Connectors → Add custom connector, and paste the URL. Claude then opens Ordo so you can allow it.',
    claudeKey:
      'Claude Desktop only: Settings → Developer → Edit config (claude_desktop_config.json), then restart Claude. Uses the mcp-remote bridge, which needs Node.js.',
    claudeCodeOauth:
      'Run in a terminal, then type /mcp in Claude Code and pick the server to sign in. --scope user makes Ordo available in every project.',
    claudeCodeKey: 'Run in a terminal. --scope user makes Ordo available in every project.',
    cursorOauth:
      '~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a project. Cursor asks you to sign in when it first connects.',
    cursorKey: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a project.',
    vscodeOauth:
      '.vscode/mcp.json, or "MCP: Open User Configuration". VS Code asks you to sign in when the server starts.',
    vscodeKey:
      '.vscode/mcp.json, or "MCP: Open User Configuration". VS Code asks for the key once and keeps it in its secret storage.',
    otherOauth:
      'Any MCP client that supports the Streamable HTTP transport and OAuth. It finds out how to sign in from the URL.',
    otherKey: 'Any MCP client that supports the Streamable HTTP transport and custom headers.',
  },
  agent: {
    title: 'Or let your agent do it',
    description:
      'Paste this into your coding agent. It adds the server to its own MCP config and checks the connection with a test call.',
    includeKey: 'Include the key I just created in the prompt',
    /** The prompt a person pastes into their coding agent, for OAuth sign-in. */
    promptOauth: `Please connect yourself to Ordo, our issue tracker, through its MCP server.

- Server URL: {url}
- Transport: Streamable HTTP (workspace "{workspace}")
- Auth: OAuth. The server tells your MCP client how to sign in; I'll approve it in my browser.

Steps:
1. Work out which MCP client you are running in and add the server to its user-level MCP configuration under the name "{name}", with no headers. In Claude Code that is:
   claude mcp add --transport http --scope user {name} {url}
   In Cursor or VS Code, edit their MCP config file instead (see Ordo → Settings → AI agents for the exact format).
2. Tell me how to start the sign-in (in Claude Code: run /mcp and pick "{name}"), or reload the MCP servers if your client starts it on its own.
3. Once I've approved it, verify the connection by calling the list_teams tool and show me the team keys you get back.
   - 404 means the URL is wrong or I'm not a member of that workspace.

The Ordo tools act as me, with my permissions. Ask me before creating or changing issues unless I asked you to.`,
    /** The same prompt for API-key sign-in. {keyLine} is promptKeyGiven or promptKeyLater. */
    promptKey: `Please connect yourself to Ordo, our issue tracker, through its MCP server.

- Server URL: {url}
- Transport: Streamable HTTP (workspace "{workspace}")
- Auth: my personal Ordo API key, sent as the HTTP header "Authorization: Bearer <key>".
  {keyLine}

Steps:
1. Work out which MCP client you are running in and add the server to its user-level MCP configuration under the name "{name}". In Claude Code that is:
   claude mcp add --transport http --scope user {name} {url} --header "Authorization: Bearer $ORDO_API_KEY"
   In Cursor, VS Code or Claude Desktop, edit their MCP config file instead (see Ordo → Settings → AI agents for the exact format).
2. Reload the MCP servers or tell me if I need to restart you.
3. Verify the connection by calling the list_teams tool and show me the team keys you get back.
   - 401 means the key is wrong or was revoked.
   - 403 means the workspace requires SSO and doesn't allow API keys.
   - 404 means the URL is wrong or I'm not a member of that workspace.

The Ordo tools act as me, with my permissions. Ask me before creating or changing issues unless I asked you to.`,
    promptKeyGiven:
      "The key is {key}. Store it in your client's MCP config or an environment variable, never in a file that is committed to git, and don't repeat it back to me.",
    promptKeyLater:
      "I'll give you the key when you ask for it (or it's in the ORDO_API_KEY environment variable). Never write it into a file that is committed to git, and don't repeat it back to me.",
  },
  tools: {
    title: 'What the agent can do',
    description: 'Tools take team keys, issue identifiers, status and label names, and usernames.',
    read: 'read',
    write: 'write',
    descriptions: {
      list_teams: 'Teams you can access, with their keys and workflow statuses.',
      list_statuses: "A team's workflow statuses in order, with their type.",
      list_members: 'People in the workspace: name, username and role.',
      list_labels: 'Workspace labels and team labels.',
      list_custom_fields: 'The custom fields issues can have, with their types and options.',
      list_projects: 'Projects with status, lead, teams, dates, progress and milestones.',
      list_cycles: 'Current and upcoming cycles (sprints) per team.',
      create_cycle: "Plan a cycle for a team; it gets the team's next number.",
      update_cycle: "Change a cycle's dates, name or description.",
      create_milestone: 'Add a milestone to a project, with an optional target date.',
      update_milestone: "Change a milestone's name, target date or description.",
      search_issues:
        'Find issues by text and filters (team, status, assignee, labels, project, cycle, priority). Open issues only unless includeClosed, status or statusType is set.',
      my_issues: 'Open issues assigned to you, most urgent first.',
      get_issue: 'One issue in full: description, comments, sub-issues, relations and links.',
      create_issue: 'Create an issue in a team. Statuses, labels and people are given by name.',
      update_issue:
        'Change an issue: title, description, status, priority, assignee, labels, project, milestone, cycle, parent, estimate or due date.',
      add_relation: 'Relate two issues: blocks, blocked by, related or duplicate of.',
      remove_relation: 'Remove the relation between two issues.',
      add_comment: 'Comment on an issue (Markdown, @mentions notify people).',
      list_agents: 'Agents in the workspace and the teams they work in.',
      assign_to_agent:
        'Hand an issue to an agent, optionally with a note. If it already has it, it runs again.',
      agent_runs:
        "An issue's agent runs: status, runner, session link, summary or error, and what each cost.",
      list_agent_runs:
        'What agents are doing across the workspace: active or finished runs, and what each cost.',
      rerun_agent: "Ask the issue's agent to work on it again, optionally with a note.",
      cancel_agent_run: "Stop the agent's queued or running work on an issue.",
      restart_agent_run:
        "Restart an issue's failed or cancelled run as a new run, for any agent on it.",
      dismiss_agent_run: "Set an issue's failed run aside, so it leaves the open runs.",
      current_run: 'The runs the agent is working on now.',
      report_run: 'Report on a run: a session link, started, or finished with a summary.',
      report_progress: 'Say what the agent is doing now; the latest one shows on the run.',
      ask_question: 'Ask a person something and pause; a reply on the issue resumes the run.',
    },
    /** Tag on tools only an agent's key sees. */
    agentsOnly: 'agents only',
  },
  apps: {
    title: 'Connected apps',
    description: 'Apps you allowed to use Ordo’s MCP server as you, in any workspace.',
    verified: 'Verified',
    used: 'used {time}',
    added: 'added {time}',
    empty: '// no apps connected',
    disconnect: 'Disconnect',
    disconnectName: 'Disconnect {name}',
    confirmDisconnectTitle: 'Disconnect {name}?',
    confirmDisconnectBody: 'It loses access right away and has to ask again to reconnect.',
  },
};
