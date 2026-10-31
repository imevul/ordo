# Command line and TypeScript SDK

## The `ordo` command

`ordo` works with issues from a terminal: list and search them, read one, file, edit, comment, start and close
them, all by the names people use (`ENG-42`, team keys, status and label names, usernames). It signs in with a
personal API key and acts as you.

### Install

Every Ordo instance serves the CLI as a single file that matches its version. It needs Node.js 22 or newer and
nothing else:

```bash
curl -fsSL https://ordo.example.com/cli/ordo.mjs -o ~/.local/bin/ordo && chmod +x ~/.local/bin/ordo
ordo login https://ordo.example.com
```

`ordo login` asks for a key (create one under **Settings → API keys**, which also shows these two lines with your
address filled in), checks it, and saves the address, the key and a default workspace in
`~/.config/ordo/config.json` (readable only by you: every write sets the file to `600` and its directory to `700`;
`$XDG_CONFIG_HOME` moves it). `ordo logout` deletes the file.

For scripts and CI, skip the login and set `ORDO_URL`, `ORDO_TOKEN` and, if you're in several workspaces,
`ORDO_WORKSPACE`. They override the saved login.

In a checkout of the Ordo repository, `pnpm ordo <command>` runs the CLI from source.

### Commands

| Command                          | What it does                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ordo login [url]`               | Save the instance's address and a personal API key (asks for what's missing; `--token <key>` skips the prompt) |
| `ordo logout`                    | Delete the saved login                                                                                         |
| `ordo whoami`                    | Who the key belongs to                                                                                         |
| `ordo workspaces`                | Your workspaces; `*` marks the default                                                                         |
| `ordo use <slug>`                | Make a workspace the default                                                                                   |
| `ordo teams`                     | Teams with their keys and statuses                                                                             |
| `ordo issues`                    | Open issues, most urgent first (same as `ordo issue list`)                                                     |
| `ordo issue view <id>`           | One issue in full; `--comments` adds them, `--web` opens it in the browser                                     |
| `ordo issue create [title]`      | File an issue                                                                                                  |
| `ordo issue edit <id>`           | Change fields                                                                                                  |
| `ordo issue comment <id> [text]` | Comment; `--body-file <path>`, or `-` to read stdin; `--attach <file>` adds files (images show inline)         |
| `ordo issue attach <id> <file…>` | Upload files to the issue and print the Markdown that shows them, for a comment, description or summary        |
| `ordo issue start <id>`          | Move to the team's first started status, assign it to you if nobody has it, and print the git branch name      |
| `ordo issue close <id>`          | Move to the first completed status (`--canceled` for the canceled one)                                         |
| `ordo issue branch <id>`         | Print the git branch name (the workspace's branch format)                                                      |
| `ordo search <words>`            | Issues and projects                                                                                            |
| `ordo api <method> <path>`       | Call any [REST endpoint](api.md); path relative to `/api`; `--data <json \| @file \| ->`                       |
| `ordo agent run …`               | Work on an agent's runs: launch a command of yours for each one (see [agents](agents.md))                      |
| `ordo agent check --file <yaml>` | Validate a runner file and its keys without claiming anything                                                  |
| `ordo agent ask <question>`      | Inside a run: ask a person and pause the run until they reply (`-` reads stdin)                                |
| `ordo agent plan <plan>`         | Inside a run: post a plan and pause the run until someone approves it or replies (`-` reads stdin)             |

Every command takes `-w, --workspace <slug>`, `--json` (machine-readable output, the API's own shapes) and
`-h, --help`. `ordo <command> --help` (or `ordo help <command>`) prints that command's usage and options, e.g.
`ordo issue create --help`; `ordo issue --help` and `ordo agent --help` list their subcommands. In `ordo agent run --
<command…>`, a `--help` after `--` goes to your command. `ordo help` prints the command list and `ordo --version`
(`-v`, `version`) the CLI's version. Some issue commands have aliases: `issue ls` for `list`, `show` for `view`, `new`
for `create` and `update` for `edit`. The options of `agent run` are in [agents](agents.md); with `--file`, the
runner file sets the key, repositories directory, concurrency and timeout, and the matching flags are refused.

**Filters for `ordo issues`:** `--team ENG`, `--status <name or type>` (`started`, `"In Review"`; repeatable),
`--assignee <me | username | email | none>` (repeatable), `--mine`, `--label <name>` (repeatable), `--project <name |
none>`, `--cycle <current | next | number | none>`, `--priority <urgent | high | medium | low | none>` (repeatable),
`--field "<name>=<value,…>"` (a custom field with any of the values, or `none`; repeatable),
`-q <words or identifier>`, `--all` (closed ones too) and `-n, --limit` (default 50).

**Fields for `create` and `edit`:** `--title`, `-d, --description <text>` or `--description-file <path | ->`,
`--status`, `--priority`, `--assignee` (`none` clears), `--project`, `--cycle`, `--parent <id>`, `--estimate`,
`--due <YYYY-MM-DD>` (`none` clears any of the last five). `create` also takes `--team` (else the workspace's default
team) and `--label` (repeatable); `edit` takes `--add-label`, `--remove-label` and `--unassign`.

**Custom fields:** `--field "<name>=<value>"` (repeatable) sets one on `create` and `edit`. The field is found by name
among the fields of the issue's team (any case); the value is an option name (select), option names separated by
commas (multi-select: `--field "Areas=API,Web"`), a number, a date as `YYYY-MM-DD`, text, or a person like
`--assignee` takes. `none` or an empty value clears it. `ordo issue view` lists the fields an issue has a value for.

```bash
ordo issues --mine --status started
ordo issue create "Login button misaligned on Safari" --team WEB --priority high --label Bug
ordo issue edit WEB-42 --field "Customer tier=Gold" --field "Reviewer=@sam"
ordo issue start WEB-42 && git switch -c "$(ordo issue branch WEB-42)"
git log -1 --format=%B | ordo issue comment WEB-42 -
ordo issue comment WEB-42 "Fixed on Safari too" --attach before.png --attach after.png
ordo api POST /w/acme/issues/query --data '{"filter":{"assigneeIds":["none"]}}'
```

A name that matches nothing fails with the names that would have worked (`No team "WBE". Teams: API, WEB`). Exit codes
are `0` for success, `1` for errors and `2` for a mistake in how the command was called.

## Server maintenance commands

`ordo` talks to an instance over HTTP. For the server itself, when nobody can sign in or after changing the secret
key, the API bundle ships `cli.mjs`, which connects to the database directly. It runs on the server with the server's
environment (`DATABASE_URL`, `ORDO_SECRET_KEY`…) and applies pending migrations before it does anything:

| Command                               | What it does                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `node cli.mjs promote-admin <email>`  | Make someone an instance admin, and enable the account if it was disabled                    |
| `node cli.mjs reset-password <email>` | Print a one-hour password reset link (on `ORDO_PUBLIC_URL`)                                  |
| `node cli.mjs disable-2fa <email>`    | Turn off someone's two-factor authentication: authenticator app, recovery codes and passkeys |
| `node cli.mjs rotate-key`             | Re-encrypt every stored secret with the current key, and list the ones it can't decrypt      |

With Docker: `make admin EMAIL=…`, `make reset-password EMAIL=…` or `docker compose exec app node cli.mjs <command>`.
In a checkout: `pnpm --filter @ordo/api cli <command>`. See [admin.md](admin.md#recovery-from-the-command-line) and
[key rotation](admin.md#rotating-the-secret-key).

## TypeScript SDK

The CLI is built on `@ordo/sdk` (`packages/sdk`), a small typed client for the REST API with no dependencies beyond
`fetch`. It uses the same types as the server (`@ordo/shared`):

```ts
import { Names, Ordo } from '@ordo/sdk';

const ordo = new Ordo({ url: 'https://ordo.example.com', token: process.env.ORDO_TOKEN! });
const acme = ordo.workspace('acme');

// Names → ids, from one bootstrap request.
const names = new Names(await acme.bootstrap(), (await ordo.me()).id);
const team = names.team('ENG');

const issue = await acme.issues.create({
  teamId: team.id,
  title: 'Rotate the signing keys',
  stateId: names.state(team, 'Todo').id,
  labelIds: [names.label('Security', team).id],
});
await acme.issues.comment(issue.identifier, { body: 'Before the audit, please.' });

// Every match, a page at a time.
for await (const i of acme.issues.all({ assigneeIds: ['me'], stateTypes: ['started'] }))
  console.log(i.identifier, i.title);
```

- `Ordo`: `me()`, `health()`, `workspace(slug)`, and `request(method, path, body?)` for anything else.
- `WorkspaceClient`: `bootstrap()`, `teams()`, `projects()`, `cycles()`, `labels()`, `customFields()`, `search(q)`,
  `notifications()`,
  `graphql(query, variables)` ([GraphQL API](graphql.md)), `request(…)`, and `issues.list | all | get | create | update | trash | archive | unarchive | history | comments |
  comment | link`. Issue ids can be identifiers (`ENG-42`) everywhere.
- Failed calls throw `OrdoError` with `status`, `code` (the API's `error`, e.g. `not_found`, `sso_required`),
  `message` and `details`.
- `Names` resolves team keys, status names or types, labels, people (`me`, usernames, emails), projects, cycles and
  custom fields (`field(name, team)`, `option(field, name)`, `fieldValue(field, "Gold")` for the value to send as
  `customFields[field.id]`, `fieldText(field, value)` to show one), throwing `NameError` with the valid choices;
  `parsePriority` reads priority words.

The SDK isn't published to npm yet. Use it from a checkout of the repository (it's a pnpm workspace package, imported
as TypeScript source like `@ordo/shared`), or copy `packages/sdk/src` next to `packages/shared/src`.
