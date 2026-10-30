# Agents and runners

Assign an issue to an agent, and a program you run somewhere picks it up, works on it, and reports back on the
issue. That program can be Claude Code, OpenCode, a Hermes profile, or your own software-factory app. Ordo doesn't
run anything itself, and it doesn't know or care what does the work.

There are three parts:

- An **agent** is a member that isn't a person. It appears in pickers with an _agent_ tag, you assign issues to it
  like anyone else, and it comments and moves issues under its own name. In Ordo it is an identity, the teams it
  works in, API keys, and optional standing instructions.
- A **runner** is a process you own: a laptop, a homelab box, a CI job, your own service. It holds an agent's key,
  claims the agent's work, and does it however it likes. Runners pull work from Ordo, so they work from behind NAT
  and Ordo never needs to reach them.
- A **run** is one pickup of an issue. It shows on the issue as _queued → claimed → running → done or failed_, with
  the runner's name, an optional link to the session, and the summary the runner reported.

## Setting up

1. **Repositories** (_Settings → Repositories_, admins). Register where your code lives: a name, a clone URL
   (`https://…`, `ssh://…`, `git@host:owner/repo.git`, or a path on the runner) and the default branch. With a
   GitHub or Forgejo integration connected, **Browse…** lists the repositories it can see and fills all of that in
   (SSH or HTTPS URL, as you choose), linking the repository to the integration. Then attach
   repositories to projects (the project's sidebar) and pick a **default repository** per team (_team settings_).
   A run's repositories are its project's, or else its team's default. Ordo stores only the address; runners bring
   their own git credentials.
2. **An agent** (_Settings → Agents_, admins). Give it a name and the teams it may work in. It can only see and be
   assigned issues there (agents are guests of those teams). _Instructions_ are added to every run's prompt, for
   example "Run `pnpm test` before opening a pull request. Never push to main." _Runs at once_ caps how many of its
   runs are worked on at the same time, across all its runners.
3. **A key** for the agent, shown once. A key only works for the agent's workspace, can't sign in to the web app, and
   stops working when the agent is disabled.
4. **A runner**, wherever the work should happen (see below).

## Day to day

1. Write the issue as you would for a colleague, and assign it to the agent. A run is queued.
2. A runner claims it within seconds and moves it along. The issue shows who is working on it and where.
3. When the runner finishes, it reports success or failure with a summary, which is posted on the issue as a
   comment by the agent. If the agent opened a pull request that mentions the issue (the suggested branch name
   contains the identifier), your [forge integration](integrations/README.md) links it and moves the issue on.
4. To ask for changes, comment on the issue and click **Run again**. The next run sees the whole thread.
5. **Cancel** stops a run: its runner hears about it on its next heartbeat and stops the command. Unassigning the
   agent cancels its open runs too.
6. **Agent runs** in the sidebar (shown once the workspace has an agent) lists what every agent is doing across the
   workspace: active runs (queued, working, waiting for an answer) or finished ones, by agent, with Resume and Cancel.
7. If a runner goes quiet (the laptop closed), its lease runs out after five minutes and the run goes back in the
   queue for another runner. After three claims it is marked failed, with a comment on the issue.
8. To save tokens or stop a runaway, an admin can **Pause new runs** on the Agent runs page. Runners claim nothing
   while it's paused: queued runs wait, and runs already going finish. **Resume runs** picks up the queue again. (It's
   the workspace setting `agentRunsPaused`.)

## `ordo agent run`

The [CLI](cli.md) includes a generic runner. You tell it what to launch for each run:

```bash
ordo agent run --key "$AGENT_KEY" -w acme -- sh -c 'claude -p --mcp-config "$ORDO_MCP_CONFIG" --allowedTools mcp__ordo'
ordo agent run --key "$AGENT_KEY" -w acme -- sh -c 'opencode run "$(cat "$ORDO_PROMPT_FILE")"'
ordo agent run --key "$AGENT_KEY" -w acme -- ./my-factory.sh
```

For each run it clones the run's repositories (once, under `~/.cache/ordo/repos`, fetched before every run), checks
out a worktree on the run's branch, and starts your command there. Then it waits for the next run.

Ctrl-C stops taking new runs and lets the running commands finish; a second Ctrl-C kills them and quits (their leases
lapse and Ordo queues the runs again). Each command runs in its own process group, so stopping a run — cancelled in
Ordo, or over `--timeout` — stops everything it started too (shells, `pnpm`, browsers): SIGTERM to the group, then
SIGKILL ten seconds later. Stopping the runner itself with SIGTERM or SIGHUP (`kill`, a closed terminal) sends
SIGTERM to the commands' groups first. On Windows only the command itself is signalled.

There is **one branch per issue**, whichever agent works on it: the issue's open pull request's branch, else a branch
already pushed for the issue, else `eng-42-short-title`. An existing local branch is reused, so a second run, or
another agent the issue was handed to, continues where the last one left off, in the same worktree. (Branches from
before this, named per agent like `claude-coder/eng-42-…`, are picked up too.)

Every half hour, and when it starts, the runner removes the worktrees of issues that are done or canceled, so
checkouts don't pile up. Branches stay in the clone; worktrees in use, and those of issues the agent can't see, are
left alone. Set `prune: false` in a runner file to keep them.

| Option                     | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `--key <key>`              | The agent's key (or `ORDO_AGENT_KEY`)                                             |
| `-w <slug>`, `--url <url>` | The workspace and Ordo's address (default: your `ordo login`)                     |
| `--repos <dir>`            | Where clones and worktrees go                                                     |
| `--concurrency <n>`        | Runs worked on at once by this runner (default 1)                                 |
| `--timeout <30m>`          | Kill the command and fail the run after this long                                 |
| `--name <name>`            | What the runner is called on the issue (default `<hostname>/<label>`)             |
| `--once`                   | Work through what's queued now, then exit (for cron or CI)                        |
| `-v, --verbose`            | Echo the command's output                                                         |
| `--file <yaml>`            | Read agents and commands from a runner file (repeatable); `--only a,b` picks some |

`ordo agent check --file <yaml>` validates a runner file and shows who each key belongs to, without claiming
anything.

### The launch contract

This is all the runner asks of your command:

| Environment                                                  | What it holds                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `ORDO_RUN_FILE`                                              | The run as JSON (`AgentRunContext`, below)                                        |
| `ORDO_MCP_CONFIG`                                            | An MCP config (`mcpServers`) for the Ordo MCP server, with the agent's key        |
| `ORDO_PROMPT_FILE`                                           | The run as a Markdown prompt; it is also on **stdin**                             |
| `ORDO_SUMMARY_FILE`                                          | Write your summary here (Markdown); without one, the end of stdout is used        |
| `ORDO_WORKDIR`                                               | Where the command starts: the first repository's worktree, or an empty directory  |
| `ORDO_REPO_PATHS`                                            | JSON: repository name → worktree path, when a run has several                     |
| `ORDO_ISSUE`, `ORDO_ISSUE_URL`                               | `ENG-42` and its link                                                             |
| `ORDO_RUN_ID`                                                | The run                                                                           |
| `ORDO_URL`, `ORDO_WORKSPACE`, `ORDO_TOKEN`, `ORDO_AGENT_KEY` | So `ordo` and the SDK inside the run act as the agent                             |
| `ORDO_RUNNER_DIR`                                            | The runner file's directory                                                       |
| `ORDO_QUESTION`, `ORDO_RESUME`                               | On a pickup after a question: what the agent asked, and the token it left (below) |

A line `ORDO_SESSION_URL=https://…` on stdout is reported right away and linked on the issue, and a line
`ORDO_RESUME=<token>` is kept for the next pickup of the run (see [Questions](#questions)). Exit code 0 means the
run succeeded; anything else means it failed, with the end of stderr (or of stdout, if stderr is empty) as the error.

Since `ORDO_TOKEN` is the agent's key, the command can use the CLI as the agent: `ordo issue comment "$ORDO_ISSUE"
"Found the cause, fixing it now"`, `ordo issue edit "$ORDO_ISSUE" --status "In Progress"`, or
`ordo issue comment "$ORDO_ISSUE" "Checked at 375px" --attach shot.png` to show a screenshot. `ORDO_MCP_CONFIG` hands it
the [MCP server](mcp.md) the same way.

**Claude Code** asks before using tools, and `claude -p` can't ask, so it refuses them. Allow what the agent needs
up front, and give it Ordo's tools:

```yaml
command: claude -p --permission-mode acceptEdits --mcp-config "$ORDO_MCP_CONFIG" --allowedTools mcp__ordo
```

That's the string form (run with `sh -c`), which expands `$ORDO_MCP_CONFIG`; the list form doesn't. To let it use
the CLI instead, allow `"Bash(ordo:*)"`. Add `"Bash(git:*)"` and the like for what else it should run.

### Runner files

A file describes one agent, or several under `agents:`, with `defaults` for all of them:

```yaml
# factory.yaml — ordo agent run --file factory.yaml
url: https://ordo.example.com
workspace: acme

# Loaded before ${VAR} expansion, relative to this file. A .env next to the file is loaded
# automatically; real environment variables win over both.
env_file: [.env.local]

defaults:
  repos: ~/.cache/ordo/repos
  instructions: Commit with the issue identifier in the message.
  concurrency: 1
  timeout: 2h
  env:
    GIT_AUTHOR_NAME: Ordo Agent

agents:
  claude: # a local label, for logs and the runner name
    key: ${CLAUDE_AGENT_KEY}
    command: claude -p --permission-mode acceptEdits --mcp-config "$ORDO_MCP_CONFIG" --allowedTools mcp__ordo
    concurrency: 2
    instructions: |
      This machine has a GPU; run the benchmarks in bench/ before and after.

  reviewer:
    key: ${HERMES_AGENT_KEY}
    command: hermes --profile review --prompt-file "$ORDO_PROMPT_FILE" # a string runs with sh -c

  docs:
    key: ${OPENCODE_AGENT_KEY}
    command: opencode run "$(cat "$ORDO_PROMPT_FILE")"
    env:
      OPENCODE_CONFIG: ./opencode.docs.json # relative paths resolve against this file

  factory:
    key: ${FACTORY_AGENT_KEY}
    command: ./scripts/factory.sh
    checkout: false # don't clone; the script reads the repositories from $ORDO_RUN_FILE
    cwd: tmp
```

```dotenv
# .env next to factory.yaml — keep it out of git
CLAUDE_AGENT_KEY=ordo_…
HERMES_AGENT_KEY=ordo_…
OPENCODE_AGENT_KEY=ordo_…
FACTORY_AGENT_KEY=ordo_…
```

A single-agent file puts `key` and `command` at the top level instead of `agents:`. `url` and `workspace` fall back to
your `ordo login`.

- `${VAR}` and `${VAR:-default}` expand from the environment, then `env_file`, then a sibling `.env`. An unset
  variable without a default is an error naming it. Plain `$VAR` is left alone, for the shell.
- `command` is a list (run directly; a leading `./` is relative to the file) or a string (run with `sh -c` in the
  worktree).
- Per agent: `key`, `command`, `repos`, `concurrency`, `timeout` (`90s`, `30m`, `2h`), `env`, `cwd` (`worktree` or
  `tmp`), `checkout` (`true` or `false`), `prune` (`true` or `false`) and `instructions`. Unknown fields are errors.
- `instructions` add up instead of replacing each other: the top level's, then `defaults`', then the agent's own,
  followed by the agent's instructions from Ordo. They go into the run's prompt (and `agent.instructions` in the run
  file), so a runner can describe its machine or its tools without changing the agent for everyone else. Ordo
  doesn't store them.
- The runner warns when a file that anyone on the machine can read holds a key.

## Writing your own runner

The runner protocol is three calls with the agent's key (see [api.md](api.md#agents-and-repositories)):

```text
POST  /api/w/<ws>/agent/claim?wait=30&runner=<name>   → 200 AgentRunContext, or 204 when there's nothing
POST  /api/w/<ws>/agent/runs/<id>/heartbeat          → { cancelled } — at least every 5 minutes
PATCH /api/w/<ws>/agent/runs/<id>                    { status: running | waiting | succeeded | failed, question?, resume?, sessionUrl?, summary?, error? }
```

`claim` takes an optional body `{ "instructions": "…" }`: the runner's own instructions, put before the agent's in
the run's prompt and `agent.instructions`, and not stored. `claim` long-polls: it answers as soon as a run is queued for the agent, or with `204` after `wait` seconds. Each
claim holds a five-minute lease. Keep it alive with heartbeats, and stop working when one answers `cancelled: true`.

`AgentRunContext` (`protocolVersion: 1`) has the `run`, the `workspace`, the `agent` (with its `instructions`), the
full `issue` (description, labels, relations, links, its `url` and `team`), its `comments` with author names, its
`project`, its `repositories` (each with `url`, `defaultBranch` and a `suggestedBranch`), the team's workflow `states`,
and the same information as one Markdown `prompt`. With `@ordo/sdk`:

```ts
const ws = new Ordo({ url, token: agentKey }).workspace('acme');
for (;;) {
  const run = await ws.agent.claim({ wait: 30, runner: 'factory-1' });
  if (!run) continue;
  await ws.agent.report(run.run.id, { status: 'running' });
  const summary = await doTheWork(run); // heartbeat at least every 5 minutes meanwhile
  await ws.agent.report(run.run.id, { status: 'succeeded', summary });
}
```

Every change to a run is also an `agent_run.updated` [webhook](api.md#webhooks) event, if you'd rather react to runs
than claim them.

## Mentions

A person **@mentioning an agent** in a comment asks it for something, whether or not the issue is its own: "@claude-reviewer can you look at this?" queues a run for that agent. Its prompt shows the comment under "Why you're here". If the issue isn't assigned to it, it's told to answer in a comment and leave the status, the assignee and the work itself alone unless the comment asks otherwise.

- Only agents that work in the issue's team can be mentioned, like people.
- A queued or waiting run already covers a mention: it will see the comment. A waiting run resumes, as on any person's comment.
- A mention while the agent is working on the issue queues one follow-up run, which starts once the current one ends. An agent never works on the same issue twice at once.
- Agents' mentions start nothing, so two agents can't keep starting each other. Agents hand work on by assigning the issue.

The run's `trigger` says why it exists (`assigned`, `mention`, `rerun` for Run again, or `pull_request`, see [Pull requests](#pull-requests)), with `triggerCommentId` for a mention and `triggerDetail` for a pull request. The context adds `trigger.comment` (author and body), `trigger.pullRequest`, and `assigned` (whether the issue is the agent's).

## Pull requests

An issue's pull requests show in its sidebar, with their checks and the latest review, when the forge reports them
(see the [GitHub](integrations/github.md), [GitLab](integrations/gitlab.md) and
[Forgejo](integrations/forgejo.md) pages). Agents get two more things from them.

**A project's pull request agent.** In a project's overview, an admin can pick an agent (one that works in one of
the project's teams) as its **Pull request agent**, and say which pull requests it gets:

- **Linked to the project's issues** (the default): pull requests that link an issue of the project, in one of the
  project's repositories (a repository's forge and `owner/name` must be set, so Ordo can match them).
- **All in the project's repositories**: also pull requests that link no issue, such as a contributor's or
  Dependabot's. Ordo makes an issue for each one in the project, titled `owner/name#57: <title>`, in the first of
  the project's teams the agent works in. When several projects list the same repository, the first in the
  project list that takes all pull requests gets it.

When a pull request becomes **ready for review** (it's opened, or moved out of draft), it's handed to that agent,
once:

- If an agent or nobody has the issue, it's reassigned to the pull request agent, like any hand-off: the previous
  agent's open runs stop, and the new one gets a run.
- If a person has it, they keep it, and the agent gets a run beside them.

The run's `trigger` is `pull_request`, and its `triggerDetail` says which pull request (`repo`, `number`, `url`,
`branch`) and what happened (`event`: `ready_for_review`). The prompt says it's the project's pull request agent,
and to handle the pull request as its instructions say. Ordo doesn't review or merge anything itself: what
"handle" means is up to the agent's instructions. Two set-ups, for example:

- **Coder → reviewer → pull request → integrator.** The coder opens a draft pull request and hands the issue to a
  reviewer agent, which marks it ready when it's happy. The project's pull request agent is an integrator: "Merge
  the pull request once its checks pass, with `gh pr merge --squash`. Resolve merge conflicts by rebasing on the
  default branch. If it can't be merged, say why in a comment and assign the issue to a person."
- **Coder → pull request → review and merge.** The coder opens the pull request when it's done. The pull request
  agent reviews and merges in one run: "Review the pull request. If it's good, approve and merge it. Otherwise
  request changes on the forge, explain on the issue, and assign the issue back to @coder."

Without a pull request agent, pull requests go to people, as before.

**Following up.** When checks start failing on a pull request, or a reviewer requests changes, the issue's
assignee gets a run if it's an agent (event `checks_failed` or `changes_requested`). Its prompt says to fix it and
push to the same branch, and the runner checks out that branch: a repository's `suggestedBranch` is the issue's
open pull request's branch, when it has one. After three such runs in a row, Ordo stops and says so in a comment,
so two agents can't keep bouncing a pull request between them; Run again or a mention starts it again. Turn it off
per agent with **Follow up on pull requests** in its settings.

Asking for anything else is a comment: "@integrator rebase this on main and merge it when checks pass" (an agent
with `gh` can use `gh pr merge --auto`). The context's `pullRequests` lists the issue's pull requests with their
state, checks and review, and the prompt has them under "Pull requests".

## Questions

When an agent needs a person before it can go on, it asks and stops. Any of these works from inside a run:

- the MCP tool `ask_question` (with the agent's key),
- `ordo agent ask "Should this target v1 or v2 of the API?"` (it reads `ORDO_RUN_ID` and `ORDO_TOKEN`),
- the protocol: `PATCH …/agent/runs/<id> { "status": "waiting", "question": "…" }`.

Ordo posts the question on the issue as a comment by the agent, @mentioning whoever asked for the run (else the
issue's creator), so they're notified the usual way. The run shows **waiting for an answer**. It holds no lease,
doesn't count toward the agent's _runs at once_, and never expires. Whatever the runner reports after that (the
command exiting, a summary) changes nothing but the session link and resume token.

**Any comment by a person** on the issue resumes it, from the web app, an email reply, or an assistant over MCP.
Comments by agents and integrations don't. **Resume** on the issue (or `rerun_agent`) puts it back without an
answer; **Cancel** and unassigning stop it. The next pickup is the same run: its prompt has a "You asked" section,
the answer is in the comments, and `run.question` and `run.resume` are in the context.

### Continuing the session

A runner can leave an opaque token on a run (`resume` in a report, or an `ORDO_RESUME=<token>` line from the
command) and gets it back on the next pickup as `ORDO_RESUME`. Ordo never reads it. With Claude Code, a small
wrapper keeps the same session across questions:

```sh
#!/bin/sh
# claude-run.sh — command: [./claude-run.sh] in the runner file
out=$(claude -p --output-format json --permission-mode acceptEdits ${ORDO_RESUME:+--resume "$ORDO_RESUME"})
echo "ORDO_RESUME=$(printf '%s' "$out" | jq -r .session_id)"
printf '%s' "$out" | jq -r .result
```

## From an assistant, over MCP

The [MCP server](mcp.md) has tools for working with agents from a chat: `list_agents`, `assign_to_agent` (with a
note for the agent), `agent_runs`, `rerun_agent` and `cancel_agent_run`. "Hand ENG-42 to Claude and tell me what it
did" works from Claude in a browser.

An agent's own key also sees `current_run` and `report_run`, so an agent can report a session link or finish its run
over MCP when the program running it doesn't report for it.

## Security

- A runner executes whatever its command does, with the access of the account it runs as. Use the command's own
  safeguards (for example Claude Code's permission modes), a container, or a dedicated user, and give the runner git
  credentials that can push branches but not protected ones.
- An agent's key reads everything in the agent's teams and can do what a guest of those teams can. Give agents only
  the teams they need, and revoke keys you no longer use.
- Prompts include issue text and comments, which anyone who can comment can write. Treat them as input from those
  people, not as trusted instructions.
