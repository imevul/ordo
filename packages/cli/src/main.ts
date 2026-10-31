import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { NameError, Names, Ordo, OrdoError, parsePriority, type WorkspaceClient } from '@ordo/sdk';
import {
  type Attachment,
  attachmentMarkdown,
  type Bootstrap,
  branchName,
  fieldsForTeam,
  type Issue,
  type IssueFilter,
  type Me,
  PRIORITIES,
  prioritySortKey,
  STATE_TYPES,
  type StateType,
  type Team,
  type UpdateIssueInput,
} from '@ordo/shared';
import {
  type AgentSpec,
  agentClients,
  defaultReposDir,
  loadRunnerFile,
  parseDuration,
  RunnerConfigError,
  runnerFilePath,
  serveAgent,
  untilAvailable,
} from './agent.ts';
import {
  type Config,
  configPath,
  effectiveConfig,
  readConfig,
  removeConfig,
  writeConfig,
} from './config.ts';
import { relative, type Style, style, table } from './output.ts';

/** Everything the CLI touches outside itself, so tests can run it in-process. */
export interface Io {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  /** Asks for one line; `hidden` for secrets. */
  prompt: (question: string, opts?: { hidden?: boolean }) => Promise<string>;
  openUrl: (url: string) => void;
  color: boolean;
  width: number;
  fetch?: typeof fetch;
  /** Aborted on Ctrl-C: long-running commands (`agent run`) stop taking new work. */
  signal?: AbortSignal;
}

/** A mistake in how the command was called; prints the usage hint. */
class UsageError extends Error {}

const VERSION = '0.1.0';

const HELP = `ordo — Ordo from the terminal

Usage: ordo <command> [options]

Setup
  login [url]              Save Ordo's address and a personal API key
  logout                   Forget them
  whoami                   Who the key belongs to
  workspaces               Your workspaces (* marks the default)
  use <workspace>          Make a workspace the default

Issues
  issues                   Open issues (same as: issue list)
  issue list               --team --status --assignee --mine --label --project --cycle
                           --priority --field <name=value> -q <words> --all --limit <n>
  issue view <id>          The issue in full; --comments, --web to open it in the browser
  issue create [title]     --team --title -d <text> | --description-file <path|->
                           --status --priority --assignee --label --project --cycle
                           --parent --estimate --due <YYYY-MM-DD> --field <name=value>
  issue edit <id>          The same fields, plus --add-label --remove-label --unassign
  issue comment <id> [text]  Text, --body-file <path>, or - to read stdin; --attach <file> adds
                           a file below the text (repeatable; images show inline)
  issue attach <id> <file…>  Upload files to the issue and print the Markdown that shows them
  issue start <id>         Assign to you, move to the first started status, print the branch name
  issue close <id>         Move to the first completed status (--canceled to cancel)
  issue branch <id>        The git branch name for the issue
  teams                    Teams with their keys and statuses
  search <words>           Issues and projects

Agents (docs/agents.md)
  agent run -- <command…>  Work on an agent's runs: --key (or ORDO_AGENT_KEY), --repos <dir>,
                           --concurrency <n>, --timeout <30m>, --name, --once, --verbose
  agent run --file <yaml>  The agents and commands in a runner file (repeatable; --only a,b)
  agent check --file <yaml>  Validate a runner file and its keys without claiming anything
  agent ask <question>     Inside a run: ask a person and pause it (- reads stdin)
  agent plan <plan>        Inside a run: post a plan for approval and pause it (- reads stdin)

Anything else
  api <method> <path>      Call the REST API (path relative to /api); --data <json|@file|->

Every command takes -w/--workspace <slug>, --json and -h/--help.
"ordo <command> --help" (or "ordo help <command>") shows that command's options.
ORDO_URL, ORDO_TOKEN and ORDO_WORKSPACE override the saved login.
Docs: docs/cli.md in the Ordo repository.`;

const COMMON_HELP = `Every command also takes -w/--workspace <slug>, --json and -h/--help.`;

const ISSUE_FIELDS_HELP = `  --title <text>                 The title
  -d, --description <text>       The description (Markdown)
  --description-file <path|->    The description from a file, or - for stdin
  -s, --status <name|type>       A status of the issue's team ("In Review", started)
  --priority <name>              urgent, high, medium, low or none
  -a, --assignee <who>           me, a username, an email, or none
  -p, --project <name>           A project, or none
  --cycle <which>                current, next, a number, or none
  --parent <id>                  Make it a sub-issue of another issue, or none
  --estimate <n>                 A number, or none
  --due <YYYY-MM-DD>             The due date, or none
  --field <name=value>           A custom field: an option, options as a,b, a number, a date,
                                 text or a person; none clears it. Repeatable`;

/** `ordo <command> --help`, keyed by the command's canonical name. */
const USAGE: Record<string, string> = {
  login: `Usage: ordo login [url] [--token <key>]

Save Ordo's address and a personal API key (Settings → API keys). Asks for what's missing.`,
  logout: `Usage: ordo logout

Forget the saved address and key.`,
  whoami: `Usage: ordo whoami

Who the API key belongs to.`,
  workspaces: `Usage: ordo workspaces

Your workspaces; * marks the default.`,
  use: `Usage: ordo use <workspace>

Make a workspace the default for every command.`,
  teams: `Usage: ordo teams

Teams with their keys and statuses.`,
  issue: `Usage: ordo issue <command> [options]

  list                     Open issues (same as: ordo issues)
  view <id>                The issue in full
  create [title]           A new issue
  edit <id>                Change an issue
  comment <id> [text]      Comment on an issue
  attach <id> <file…>      Upload files and print the Markdown that shows them
  start <id>               Assign to you, move to the first started status, print the branch name
  close <id>               Move to the first completed status
  branch <id>              The git branch name for the issue

Run "ordo issue <command> --help" for its options.`,
  'issue list': `Usage: ordo issue list [options]   (or: ordo issues)

Open issues, most urgent first.

  -t, --team <key>               One team
  -s, --status <name|type>       A status name or type (started, "In Review"); repeatable
  -a, --assignee <who>           me, a username, an email, or none; repeatable
  --mine                         Assigned to you
  -l, --label <name>             Repeatable
  -p, --project <name>           A project, or none
  --cycle <which>                current, next, a number, or none
  --priority <name>              urgent, high, medium, low or none; repeatable
  --field <name=value>           A custom field with one of the values (a,b), or none; repeatable
  -q, --query <words>            Words or an identifier
  --all                          Closed issues too
  -n, --limit <n>                At most this many (default 50)`,
  'issue view': `Usage: ordo issue view <id> [options]

The issue in full.

  -c, --comments                 Its comments too
  --web                          Open it in the browser instead`,
  'issue create': `Usage: ordo issue create [title] [options]

A new issue, in the workspace's default team unless you give one.

  -t, --team <key>               The team
  -l, --label <name>             Repeatable
${ISSUE_FIELDS_HELP}`,
  'issue edit': `Usage: ordo issue edit <id> [options]

Change an issue; only the fields you give change.

${ISSUE_FIELDS_HELP}
  --add-label <name>             Repeatable
  --remove-label <name>          Repeatable
  --unassign                     Clear the assignee`,
  'issue comment': `Usage: ordo issue comment <id> [text|-] [options]

Comment on an issue; - reads the text from stdin.

  -F, --body-file <path|->       The text from a file, or - for stdin
  -A, --attach <file>            Add a file below the text (repeatable; images show inline)`,
  'issue attach': `Usage: ordo issue attach <id> <file…>

Upload files to the issue and print the Markdown that shows them.`,
  'issue start': `Usage: ordo issue start <id>

Assign to you if nobody has it, move to the first started status, print the branch name.`,
  'issue close': `Usage: ordo issue close <id> [--canceled]

Move to the first completed status, or with --canceled to the first canceled one.`,
  'issue branch': `Usage: ordo issue branch <id>

The git branch name for the issue (the workspace's branch format).`,
  search: `Usage: ordo search <words>

Issues and projects, best matches first.`,
  api: `Usage: ordo api <method> <path> [--data <json|@file|->]

Call the REST API; the path is relative to /api. Prints the JSON answer.`,
  agent: `Usage: ordo agent <command> [options]

  run -- <command…>        Work on an agent's runs with a command of yours
  run --file <yaml>        The agents and commands in a runner file
  check --file <yaml>      Validate a runner file and its keys without claiming anything
  ask <question>           Inside a run: ask a person and pause it
  plan <plan>              Inside a run: post a plan for approval and pause it

Run "ordo agent <command> --help" for its options. Docs: docs/agents.md.`,
  'agent run': `Usage: ordo agent run [options] -- <command…>
       ordo agent run --file <yaml> [--only a,b]

Claim an agent's runs and launch the command for each one, in a worktree of the issue's repository.

  --key <key>                    The agent's key (or ORDO_AGENT_KEY)
  --url <url>                    Ordo's address (default: the saved login)
  --repos <dir>                  Where clones and worktrees go
  --concurrency <n>              Runs worked on at once (default 1)
  --timeout <30m>                Kill the command and fail the run after this long
  --name <name>                  What the runner is called on the issue
  --once                         Work through what's queued now, then exit
  -v, --verbose                  Echo the command's output
  --no-output                    Don't send the command's output to the run's page
  -f, --file <yaml>            A runner file (repeatable)
  --only <labels>                Only these agents from the runner files`,
  'agent check': `Usage: ordo agent check --file <yaml> [--only a,b]

Validate a runner file and its keys without claiming anything.`,
  'agent ask': `Usage: ordo agent ask <question|-> [--run <id>]

Inside a run: ask a person and pause the run until they reply on the issue. - reads stdin.`,
  'agent plan': `Usage: ordo agent plan <plan|-> [--run <id>]

Inside a run: post your plan (Markdown) on the issue and pause the run until a person approves it
or replies with changes. - reads stdin.`,
};

const ISSUE_ALIASES: Record<string, string> = {
  ls: 'list',
  show: 'view',
  new: 'create',
  update: 'edit',
};

/** The USAGE key for a command line, or null when the command is unknown. */
function usageKey(argv: string[]): string | null {
  const [command, sub] = argv;
  if (command === 'issues') return 'issue list';
  if (command === 'issue' || command === 'agent') {
    const name = command === 'issue' ? (ISSUE_ALIASES[sub ?? ''] ?? sub) : sub;
    if (!name || name.startsWith('-')) return command;
    return USAGE[`${command} ${name}`] ? `${command} ${name}` : null;
  }
  return command && USAGE[command] ? command : null;
}

/** Whether -h/--help appears among the CLI's own arguments (not after `--`, which belongs to `agent run`). */
function wantsHelp(args: string[]) {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).some((a) => a === '-h' || a === '--help');
}

const common = {
  workspace: { type: 'string', short: 'w' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const OPEN_TYPES: StateType[] = ['triage', 'backlog', 'unstarted', 'started'];

/** Runs one command line; resolves to the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const s = style(io.color);
  try {
    await dispatch(argv, io, s);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${s.error('error:')} ${err.message}\nRun "ordo --help" for usage.\n`);
      return 2;
    }
    if (err instanceof OrdoError) {
      const hint =
        err.status === 401
          ? ' (run "ordo login", or check ORDO_TOKEN)'
          : err.code === 'sso_required'
            ? ' (this workspace requires SSO and does not allow API keys)'
            : '';
      io.stderr(`${s.error('error:')} ${err.message}${hint}\n`);
      return 1;
    }
    if (err instanceof NameError || err instanceof RunnerConfigError) {
      io.stderr(`${s.error('error:')} ${err.message}\n`);
      return 1;
    }
    const e = err as Error & { cause?: { code?: string } };
    const message =
      e.message === 'fetch failed'
        ? `can't reach Ordo (${e.cause?.code ?? 'network error'})`
        : e.message;
    io.stderr(`${s.error('error:')} ${message}\n`);
    return 1;
  }
}

async function dispatch(argv: string[], io: Io, s: Style) {
  const [command, ...rest] = argv;
  if (
    !command ||
    command === '-h' ||
    command === '--help' ||
    (command === 'help' && !rest.length)
  ) {
    io.stdout(`${HELP}\n`);
    return;
  }
  if (command === '-v' || command === '--version' || command === 'version') {
    io.stdout(`ordo ${VERSION}\n`);
    return;
  }
  // `ordo issue create --help`, or `ordo help issue create`. Unknown commands fall through to
  // the usual error, so a typo isn't answered with the global help.
  const helpFor = command === 'help' ? rest : wantsHelp(rest) ? argv : null;
  const key = helpFor && usageKey(helpFor);
  if (key) {
    io.stdout(`${USAGE[key]}\n\n${COMMON_HELP}\n`);
    return;
  }
  if (command === 'help') throw new UsageError(`unknown command "${rest.join(' ')}"`);
  const path = configPath(io.env);
  const file = await readConfig(path);
  const ctx = new Context(io, s, path, file);
  switch (command) {
    case 'login':
      return login(ctx, rest);
    case 'logout':
      await removeConfig(path);
      io.stdout('Signed out: the saved address and key are gone.\n');
      return;
    case 'whoami':
      return whoami(ctx, rest);
    case 'workspaces':
      return workspaces(ctx, rest);
    case 'use':
      return use(ctx, rest);
    case 'teams':
      return teams(ctx, rest);
    case 'issues':
      return issueList(ctx, rest);
    case 'issue': {
      const [sub, ...args] = rest;
      switch (sub) {
        case 'list':
        case 'ls':
          return issueList(ctx, args);
        case 'view':
        case 'show':
          return issueView(ctx, args);
        case 'create':
        case 'new':
          return issueCreate(ctx, args);
        case 'edit':
        case 'update':
          return issueEdit(ctx, args);
        case 'comment':
          return issueComment(ctx, args);
        case 'attach':
          return issueAttach(ctx, args);
        case 'start':
          return issueMove(ctx, args, 'start');
        case 'close':
          return issueMove(ctx, args, 'close');
        case 'branch':
          return issueBranch(ctx, args);
        default:
          throw new UsageError(sub ? `unknown issue command "${sub}"` : 'which issue command?');
      }
    }
    case 'search':
      return search(ctx, rest);
    case 'api':
      return api(ctx, rest);
    case 'agent': {
      const [sub, ...args] = rest;
      if (sub === 'run') return agentRun(ctx, args);
      if (sub === 'check') return agentRun(ctx, args, { check: true });
      if (sub === 'ask') return agentAsk(ctx, args);
      if (sub === 'plan') return agentPlan(ctx, args);
      throw new UsageError(
        sub ? `unknown agent command "${sub}"` : 'which agent command? run or check',
      );
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

/** The signed-in client and the workspace a command works in, loaded on demand. */
class Context {
  readonly config: Config;
  #ordo: Ordo | null = null;
  #me: Promise<Me> | null = null;
  #boot: Promise<Bootstrap> | null = null;

  constructor(
    readonly io: Io,
    readonly s: Style,
    readonly path: string,
    readonly file: Config,
  ) {
    this.config = effectiveConfig(file, io.env);
  }

  get ordo() {
    if (!this.#ordo) {
      const { url, token } = this.config;
      if (!url || !token) throw new Error('not signed in; run "ordo login" first');
      this.#ordo = new Ordo({ url, token, fetch: this.io.fetch });
    }
    return this.#ordo;
  }

  me() {
    this.#me ??= this.ordo.me();
    return this.#me;
  }

  async workspace(flag: string | undefined): Promise<WorkspaceClient> {
    let slug = flag ?? this.config.workspace;
    if (!slug) {
      const { workspaces } = await this.me();
      if (workspaces.length !== 1)
        throw new UsageError(
          'which workspace? Pass -w <slug>, or pick a default with "ordo use <slug>"',
        );
      slug = workspaces[0]!.slug;
    }
    return this.ordo.workspace(slug);
  }

  async names(ws: WorkspaceClient) {
    this.#boot ??= ws.bootstrap();
    const [boot, me] = await Promise.all([this.#boot, this.me()]);
    return new Names(boot, me.id);
  }

  issueUrl(ws: WorkspaceClient, identifier: string) {
    return `${this.ordo.url}/${ws.slug}/issue/${identifier}`;
  }

  json(value: unknown) {
    this.io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  }
}

function parse<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  const config = {
    args,
    options: { ...common, ...options },
    allowPositionals: true as const,
    strict: true as const,
  };
  try {
    return parseArgs(config);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** Text from a flag, a file, or stdin (`-`). */
async function textFrom(ctx: Context, value: string | undefined, file: string | undefined) {
  if (file === '-' || value === '-') return ctx.io.readStdin();
  if (file) return readFile(file, 'utf8');
  return value;
}

// ─── Setup ───────────────────────────────────────────────────────────

async function login(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, { token: { type: 'string' } });
  const { io, s } = ctx;
  let url = positionals[0] ?? io.env.ORDO_URL ?? ctx.file.url;
  url ??= (await io.prompt('Ordo address (e.g. https://ordo.example.com): ')).trim();
  if (!url) throw new UsageError('give the address Ordo runs at');
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  let token = (values.token as string | undefined) ?? io.env.ORDO_TOKEN;
  if (!token) {
    io.stderr(`Create a personal API key in Ordo under Settings → API keys (${url}).\n`);
    token = (await io.prompt('API key: ', { hidden: true })).trim();
  }
  if (!token) throw new UsageError('an API key is needed');
  const me = await new Ordo({ url, token, fetch: io.fetch }).me();
  const keep = me.workspaces.some((w) => w.slug === ctx.file.workspace);
  const workspace = keep ? ctx.file.workspace : me.workspaces[0]?.slug;
  await writeConfig(ctx.path, { url, token, workspace });
  io.stdout(
    `Signed in to ${url} as ${s.bold(me.name)} (@${me.username}).${workspace ? ` Workspace: ${workspace}.` : ''}\n`,
  );
  if (me.workspaces.length > 1)
    io.stdout(`You're in ${me.workspaces.length} workspaces; switch with "ordo use <slug>".\n`);
}

async function whoami(ctx: Context, args: string[]) {
  const { values } = parse(args, {});
  const me = await ctx.me();
  if (values.json) return ctx.json(me);
  ctx.io.stdout(`${ctx.s.bold(me.name)} (@${me.username}) <${me.email}> on ${ctx.ordo.url}\n`);
}

async function workspaces(ctx: Context, args: string[]) {
  const { values } = parse(args, {});
  const { workspaces: list } = await ctx.me();
  if (values.json) return ctx.json(list);
  ctx.io.stdout(
    `${table(
      list.map((w) => [w.slug === ctx.config.workspace ? '*' : ' ', w.slug, w.role, w.name]),
      ctx.io.width,
    )}\n`,
  );
}

async function use(ctx: Context, args: string[]) {
  const { positionals } = parse(args, {});
  const slug = positionals[0];
  if (!slug) throw new UsageError('which workspace? "ordo use <slug>"');
  const { workspaces: list } = await ctx.me();
  if (!list.some((w) => w.slug === slug))
    throw new NameError(
      `You're not in a workspace "${slug}". Yours: ${list.map((w) => w.slug).join(', ')}`,
    );
  await writeConfig(ctx.path, { ...ctx.file, workspace: slug });
  ctx.io.stdout(`Using ${slug}.\n`);
}

async function teams(ctx: Context, args: string[]) {
  const { values } = parse(args, {});
  const names = await ctx.names(await ctx.workspace(values.workspace));
  const list = names.boot.teams;
  if (values.json) return ctx.json(list);
  ctx.io.stdout(
    `${table(
      list.map((t) => [
        ctx.s.bold(t.key),
        t.name,
        [...t.states]
          .sort((a, b) => a.position - b.position)
          .map((st) => st.name)
          .join(' → '),
      ]),
      ctx.io.width,
    )}\n`,
  );
}

// ─── Issues ──────────────────────────────────────────────────────────

const PRIORITY_SHORT: Record<number, string> = {
  0: '—',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

function issueRows(ctx: Context, names: Names, issues: Issue[]) {
  const states = new Map(names.boot.teams.flatMap((t) => t.states.map((st) => [st.id, st])));
  const people = new Map(names.boot.members.map((m) => [m.id, m]));
  return issues.map((i) => [
    ctx.s.accent(i.identifier),
    states.get(i.stateId)?.name ?? '?',
    PRIORITY_SHORT[i.priority] ?? '—',
    i.assigneeId ? `@${people.get(i.assigneeId)?.username ?? '?'}` : '—',
    i.title,
  ]);
}

async function issueList(ctx: Context, args: string[]) {
  const { values } = parse(args, {
    team: { type: 'string', short: 't' },
    status: { type: 'string', short: 's', multiple: true },
    assignee: { type: 'string', short: 'a', multiple: true },
    mine: { type: 'boolean' },
    label: { type: 'string', short: 'l', multiple: true },
    project: { type: 'string', short: 'p' },
    cycle: { type: 'string' },
    priority: { type: 'string', multiple: true },
    field: { type: 'string', multiple: true },
    query: { type: 'string', short: 'q' },
    all: { type: 'boolean' },
    limit: { type: 'string', short: 'n' },
  });
  const ws = await ctx.workspace(values.workspace);
  const names = await ctx.names(ws);
  const team = values.team ? names.team(values.team) : null;
  const teamsInScope = team ? [team] : names.boot.teams;
  const filter: IssueFilter = {};
  if (team) filter.teamId = team.id;
  if (values.status?.length) {
    const types = values.status.filter((v) => (STATE_TYPES as readonly string[]).includes(v));
    const named = values.status.filter((v) => !types.includes(v));
    if (types.length) filter.stateTypes = types as StateType[];
    if (named.length) {
      const ids = teamsInScope.flatMap((t) =>
        t.states.filter((st) => named.some((n) => n.toLowerCase() === st.name.toLowerCase())),
      );
      if (!ids.length) throw new NameError(`No status named ${named.join(' or ')}`);
      filter.stateIds = ids.map((st) => st.id);
    }
  } else if (!values.all) filter.stateTypes = OPEN_TYPES;
  const assignees = [...(values.assignee ?? []), ...(values.mine ? ['me'] : [])];
  if (assignees.length)
    filter.assigneeIds = assignees.map((a) => (a === 'none' ? 'none' : names.member(a).id));
  if (values.label?.length) {
    filter.labelIds = values.label.flatMap((l) => {
      const ids = names.boot.labels.filter((x) => x.name.toLowerCase() === l.toLowerCase());
      if (!ids.length) names.label(l, team);
      return ids.map((x) => x.id);
    });
  }
  if (values.project)
    filter.projectIds = [values.project === 'none' ? 'none' : names.project(values.project).id];
  if (values.cycle)
    filter.cycleIds =
      values.cycle === 'none'
        ? ['none']
        : teamsInScope.flatMap((t) => {
            try {
              return [names.cycle(t, values.cycle!).id];
            } catch (err) {
              if (team) throw err;
              return [];
            }
          });
  if (values.cycle && !filter.cycleIds?.length) throw new NameError(`No ${values.cycle} cycle`);
  if (values.priority?.length) filter.priorities = values.priority.map(parsePriority);
  if (values.field?.length) {
    filter.customFields = {};
    for (const flag of values.field) {
      const [ref, raw] = splitField(flag);
      const field = names.field(ref, team);
      filter.customFields[field.id] = raw.split(',').flatMap((v) => {
        if (v.trim().toLowerCase() === 'none') return ['none'];
        const value = names.fieldValue(field, v);
        return value === null ? [] : Array.isArray(value) ? value : [String(value)];
      });
      if (!filter.customFields[field.id]!.length)
        throw new UsageError(`--field ${ref}= needs a value, or none`);
    }
  }
  if (values.query) filter.q = values.query;

  const limit = values.limit ? Number(values.limit) : 50;
  if (!Number.isInteger(limit) || limit < 1)
    throw new UsageError('--limit takes a positive number');
  // Most urgent first, then most recently changed; the server's order is the board's.
  const issues = (await ws.issues.list(filter, { limit: 5000 }))
    .sort(
      (a, b) =>
        prioritySortKey(a.priority) - prioritySortKey(b.priority) ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, limit);
  if (values.json) return ctx.json(issues);
  if (!issues.length) {
    ctx.io.stdout('No issues.\n');
    return;
  }
  ctx.io.stdout(`${table(issueRows(ctx, names, issues), ctx.io.width)}\n`);
}

async function issueView(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, {
    comments: { type: 'boolean', short: 'c' },
    web: { type: 'boolean' },
  });
  const id = positionals[0];
  if (!id) throw new UsageError('which issue? "ordo issue view ENG-42"');
  const ws = await ctx.workspace(values.workspace);
  if (values.web) {
    const issue = await ws.issues.get(id);
    ctx.io.openUrl(ctx.issueUrl(ws, issue.identifier));
    return;
  }
  const [issue, names] = await Promise.all([ws.issues.get(id), ctx.names(ws)]);
  const comments = values.comments ? await ws.issues.comments(issue.id) : [];
  if (values.json) return ctx.json(values.comments ? { ...issue, comments } : issue);
  const { s } = ctx;
  const team = names.boot.teams.find((t) => t.id === issue.teamId);
  const state = team?.states.find((st) => st.id === issue.stateId);
  const people = new Map(names.boot.members.map((m) => [m.id, m]));
  const who = (id: string | null) => (id ? `@${people.get(id)?.username ?? 'someone'}` : '—');
  const labels = issue.labelIds
    .map((l) => names.boot.labels.find((x) => x.id === l)?.name)
    .filter(Boolean);
  const project = names.boot.projects.find((p) => p.id === issue.projectId);
  const cycle = names.boot.cycles.find((c) => c.id === issue.cycleId);
  // Custom fields with a value, in field order, after the built-in properties.
  const fields = fieldsForTeam(names.boot.customFields ?? [], issue.teamId)
    .filter((f) => issue.customFields?.[f.id] !== undefined)
    .map((f) => [f.name, names.fieldText(f, issue.customFields[f.id]!)]);
  const facts = [
    ['Status', state?.name ?? '?'],
    ['Priority', PRIORITIES.find((p) => p.value === issue.priority)?.label ?? '—'],
    ['Assignee', who(issue.assigneeId)],
    ['Labels', labels.join(', ')],
    ['Project', project?.name],
    ['Cycle', cycle ? (cycle.name ?? `Cycle ${cycle.number}`) : undefined],
    ['Estimate', issue.estimate?.toString()],
    ['Due', issue.dueDate],
    ...fields,
    ['Parent', issue.parent ? `${issue.parent.identifier} ${issue.parent.title}` : undefined],
    ['Created', `${relative(issue.createdAt)} by ${who(issue.creatorId)}`],
    ['Updated', relative(issue.updatedAt)],
  ].filter((f): f is [string, string] => !!f[1]);
  const out = [
    `${s.accent(issue.identifier)} ${s.bold(issue.title)}`,
    s.dim(ctx.issueUrl(ws, issue.identifier)),
    '',
    table(
      facts.map(([k, v]) => [s.dim(k), v]),
      ctx.io.width,
    ),
  ];
  if (issue.description.trim()) out.push('', issue.description.trim());
  if (issue.subIssues.length) {
    out.push('', s.bold(`Sub-issues (${issue.subIssues.length})`));
    out.push(table(issueRows(ctx, names, issue.subIssues), ctx.io.width));
  }
  if (values.comments) {
    out.push('', s.bold(`Comments (${comments.length})`));
    for (const c of comments)
      out.push('', `${s.bold(who(c.authorId))} ${s.dim(relative(c.createdAt))}`, c.body.trim());
  }
  ctx.io.stdout(`${out.join('\n')}\n`);
}

const issueFields = {
  title: { type: 'string' },
  description: { type: 'string', short: 'd' },
  'description-file': { type: 'string' },
  status: { type: 'string', short: 's' },
  priority: { type: 'string' },
  assignee: { type: 'string', short: 'a' },
  project: { type: 'string', short: 'p' },
  cycle: { type: 'string' },
  parent: { type: 'string' },
  estimate: { type: 'string' },
  due: { type: 'string' },
} as const;

type FieldValues = { [K in keyof typeof issueFields]?: string } & { field?: string[] };

/** `--field "Customer tier=Gold"` as the field and the value. */
function splitField(flag: string): [string, string] {
  const at = flag.indexOf('=');
  if (at < 1) throw new UsageError(`--field takes name=value, like --field "Customer tier=Gold"`);
  return [flag.slice(0, at).trim(), flag.slice(at + 1)];
}

/** The fields shared by create and edit, from names to ids. `none` clears where that makes sense. */
async function fieldsToInput(
  ctx: Context,
  ws: WorkspaceClient,
  names: Names,
  team: Team,
  v: FieldValues,
) {
  const input: UpdateIssueInput = {};
  if (v.title !== undefined) input.title = v.title;
  const description = await textFrom(ctx, v.description, v['description-file']);
  if (description !== undefined) input.description = description;
  if (v.status) input.stateId = names.state(team, v.status).id;
  if (v.priority) input.priority = parsePriority(v.priority);
  if (v.assignee) input.assigneeId = v.assignee === 'none' ? null : names.member(v.assignee).id;
  if (v.project) input.projectId = v.project === 'none' ? null : names.project(v.project).id;
  if (v.cycle) input.cycleId = v.cycle === 'none' ? null : names.cycle(team, v.cycle).id;
  if (v.parent) input.parentId = v.parent === 'none' ? null : (await ws.issues.get(v.parent)).id;
  if (v.estimate) {
    const n = Number(v.estimate);
    if (v.estimate !== 'none' && !Number.isFinite(n))
      throw new UsageError('--estimate takes a number');
    input.estimate = v.estimate === 'none' ? null : n;
  }
  if (v.due) {
    if (v.due !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(v.due))
      throw new UsageError('--due takes a date as YYYY-MM-DD');
    input.dueDate = v.due === 'none' ? null : v.due;
  }
  if (v.field?.length) {
    input.customFields = {};
    for (const flag of v.field) {
      const [ref, raw] = splitField(flag);
      const field = names.field(ref, team);
      input.customFields[field.id] = names.fieldValue(field, raw);
    }
  }
  return input;
}

async function issueCreate(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, {
    ...issueFields,
    field: { type: 'string', multiple: true },
    team: { type: 'string', short: 't' },
    label: { type: 'string', short: 'l', multiple: true },
  });
  const ws = await ctx.workspace(values.workspace);
  const names = await ctx.names(ws);
  const title = values.title ?? positionals.join(' ');
  if (!title.trim())
    throw new UsageError('give the issue a title: ordo issue create "Title" --team ENG');
  const { teams: all, workspace } = names.boot;
  const team = values.team
    ? names.team(values.team)
    : (all.find((t) => t.id === workspace.defaultTeamId) ?? (all.length === 1 ? all[0] : null));
  if (!team) throw new UsageError(`which team? --team ${all.map((t) => t.key).join('|')}`);
  const fields = await fieldsToInput(ctx, ws, names, team, { ...values, title });
  const issue = await ws.issues.create({
    ...fields,
    title,
    teamId: team.id,
    labelIds: (values.label ?? []).map((l) => names.label(l, team).id),
  } as Parameters<typeof ws.issues.create>[0]);
  if (values.json) return ctx.json(issue);
  ctx.io.stdout(
    `Created ${ctx.s.accent(issue.identifier)} ${ctx.issueUrl(ws, issue.identifier)}\n`,
  );
}

async function issueEdit(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, {
    ...issueFields,
    field: { type: 'string', multiple: true },
    'add-label': { type: 'string', multiple: true },
    'remove-label': { type: 'string', multiple: true },
    unassign: { type: 'boolean' },
  });
  const id = positionals[0];
  if (!id) throw new UsageError('which issue? "ordo issue edit ENG-42 --status Done"');
  const ws = await ctx.workspace(values.workspace);
  const [issue, names] = await Promise.all([ws.issues.get(id), ctx.names(ws)]);
  const team = names.team(issue.teamId);
  const patch = await fieldsToInput(ctx, ws, names, team, values);
  if (values.unassign) patch.assigneeId = null;
  if (values['add-label']?.length)
    patch.addLabelIds = values['add-label'].map((l) => names.label(l, team).id);
  if (values['remove-label']?.length)
    patch.removeLabelIds = values['remove-label'].map((l) => names.label(l, team).id);
  if (!Object.keys(patch).length) throw new UsageError('nothing to change; see "ordo --help"');
  const updated = await ws.issues.update(issue.id, patch);
  if (values.json) return ctx.json(updated);
  ctx.io.stdout(`Updated ${ctx.s.accent(issue.identifier)}\n`);
}

async function issueComment(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, {
    'body-file': { type: 'string', short: 'F' },
    attach: { type: 'string', short: 'A', multiple: true },
  });
  const [id, ...words] = positionals;
  if (!id) throw new UsageError('which issue? "ordo issue comment ENG-42 \\"text\\""');
  const text = await textFrom(ctx, words.length ? words.join(' ') : undefined, values['body-file']);
  const files = values.attach ?? [];
  if (!text?.trim() && !files.length) throw new UsageError('the comment is empty');
  const ws = await ctx.workspace(values.workspace);
  // Uploaded first, so a missing file fails before anything is posted.
  const shown = (await uploadFiles(ws, id, files)).map(attachmentMarkdown);
  const body = [text?.trim(), ...shown].filter(Boolean).join('\n\n');
  const comment = await ws.issues.comment(id, { body });
  if (values.json) return ctx.json(comment);
  ctx.io.stdout(`Commented on ${ctx.s.accent(id.toUpperCase())}\n`);
}

async function issueAttach(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, {});
  const [id, ...files] = positionals;
  if (!id || !files.length)
    throw new UsageError('which issue and files? "ordo issue attach ENG-42 shot.png"');
  const ws = await ctx.workspace(values.workspace);
  const attachments = await uploadFiles(ws, id, files);
  if (values.json) return ctx.json(attachments);
  // Just the Markdown, one per line, to paste into a comment, description or run summary.
  ctx.io.stdout(`${attachments.map(attachmentMarkdown).join('\n')}\n`);
}

/** Uploads files to an issue, one at a time. Reads them all first, so a missing file uploads nothing. */
async function uploadFiles(ws: WorkspaceClient, id: string, files: string[]) {
  const bodies = await Promise.all(files.map((file) => readFile(file)));
  const attachments: Attachment[] = [];
  for (const [i, file] of files.entries())
    attachments.push(await ws.issues.attach(id, { filename: basename(file), body: bodies[i]! }));
  return attachments;
}

/** `start`: assign to me and move to the first started status. `close`: the first completed one. */
async function issueMove(ctx: Context, args: string[], how: 'start' | 'close') {
  const { values, positionals } = parse(args, { canceled: { type: 'boolean' } });
  const id = positionals[0];
  if (!id) throw new UsageError(`which issue? "ordo issue ${how} ENG-42"`);
  const ws = await ctx.workspace(values.workspace);
  const [issue, names, me] = await Promise.all([ws.issues.get(id), ctx.names(ws), ctx.me()]);
  const team = names.team(issue.teamId);
  const type: StateType = how === 'start' ? 'started' : values.canceled ? 'canceled' : 'completed';
  const state = names.state(team, type);
  const patch: UpdateIssueInput = { stateId: state.id };
  if (how === 'start' && !issue.assigneeId) patch.assigneeId = me.id;
  const updated = await ws.issues.update(issue.id, patch);
  if (values.json) return ctx.json(updated);
  ctx.io.stdout(`${ctx.s.accent(issue.identifier)} → ${state.name}\n`);
  if (how === 'start')
    ctx.io.stdout(
      `Branch: ${branchName(names.boot.workspace.settings.gitBranchFormat, { identifier: issue.identifier, title: issue.title, username: me.username })}\n`,
    );
}

async function issueBranch(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, {});
  const id = positionals[0];
  if (!id) throw new UsageError('which issue? "ordo issue branch ENG-42"');
  const ws = await ctx.workspace(values.workspace);
  const [issue, names, me] = await Promise.all([ws.issues.get(id), ctx.names(ws), ctx.me()]);
  const name = branchName(names.boot.workspace.settings.gitBranchFormat, {
    identifier: issue.identifier,
    title: issue.title,
    username: me.username,
  });
  if (values.json) return ctx.json({ branch: name });
  ctx.io.stdout(`${name}\n`);
}

async function search(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, {});
  const q = positionals.join(' ').trim();
  if (!q) throw new UsageError('search for what? "ordo search login button"');
  const ws = await ctx.workspace(values.workspace);
  const [results, names] = await Promise.all([ws.search(q), ctx.names(ws)]);
  if (values.json) return ctx.json(results);
  if (!results.issues.length && !results.projects.length) {
    ctx.io.stdout('Nothing found.\n');
    return;
  }
  if (results.issues.length)
    ctx.io.stdout(`${table(issueRows(ctx, names, results.issues), ctx.io.width)}\n`);
  if (results.projects.length)
    ctx.io.stdout(
      `${results.issues.length ? '\n' : ''}${ctx.s.bold('Projects')}\n${results.projects.map((p) => `  ${p.name}`).join('\n')}\n`,
    );
}

// ─── Raw API ─────────────────────────────────────────────────────────

async function api(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, { data: { type: 'string', short: 'd' } });
  const [method, path] = positionals;
  if (!method || !path)
    throw new UsageError('"ordo api GET /auth/me", or "ordo api POST <path> --data <json>"');
  let body: unknown;
  const raw = values.data?.startsWith('@')
    ? await readFile(values.data.slice(1), 'utf8')
    : await textFrom(ctx, values.data, undefined);
  if (raw !== undefined) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new UsageError('--data must be JSON');
    }
  }
  const p = path.startsWith('/') ? path : `/${path}`;
  const result = await ctx.ordo.request(method.toUpperCase(), p.replace(/^\/api(?=\/)/, ''), body);
  ctx.json(result);
}

// ─── Agents ──────────────────────────────────────────────────────────

async function agentSpecs(
  ctx: Context,
  args: string[],
  check: boolean,
): Promise<{ specs: AgentSpec[]; values: Record<string, unknown> }> {
  const { values, positionals } = parse(args, {
    file: { type: 'string', short: 'f', multiple: true },
    only: { type: 'string' },
    key: { type: 'string' },
    url: { type: 'string' },
    repos: { type: 'string' },
    concurrency: { type: 'string' },
    timeout: { type: 'string' },
    name: { type: 'string' },
    once: { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    'no-output': { type: 'boolean' },
  });
  const { io, config } = ctx;
  const fallback = {
    url: (values.url as string | undefined) ?? config.url,
    workspace: (values.workspace as string | undefined) ?? config.workspace,
  };
  let specs: AgentSpec[] = [];
  const files = (values.file as string[] | undefined) ?? [];
  if (files.length) {
    if (positionals.length)
      throw new UsageError('give the command in the runner file, not after --file');
    // A runner file sets these per agent; taking the flag silently would run something else.
    const clash = (['key', 'repos', 'concurrency', 'timeout'] as const).filter(
      (k) => values[k] !== undefined,
    );
    if (clash.length)
      throw new UsageError(
        `--${clash.join(', --')} can't be combined with --file; set ${clash.join(', ')} in the runner file`,
      );
    for (const f of files) {
      const loaded = await loadRunnerFile(runnerFilePath(f, io.env), io.env, fallback);
      for (const w of loaded.warnings) io.stderr(`${ctx.s.error('warning:')} ${w}\n`);
      specs.push(...loaded.agents);
    }
    const labels = specs.map((a) => a.label);
    const dupe = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dupe)
      throw new UsageError(`two agents are labelled "${dupe}"; labels must be unique across files`);
  } else {
    const key = (values.key as string | undefined) ?? io.env.ORDO_AGENT_KEY;
    if (!key)
      throw new UsageError(
        "give the agent's key: --key, ORDO_AGENT_KEY, or a runner file with --file",
      );
    if (!positionals.length && !check)
      throw new UsageError('what should run? "ordo agent run --key … -- claude -p"');
    if (!fallback.url) throw new UsageError('where is Ordo? --url, ORDO_URL, or "ordo login"');
    if (!fallback.workspace) throw new UsageError('which workspace? -w <slug> or ORDO_WORKSPACE');
    const concurrency = Number(values.concurrency ?? 1);
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new UsageError('--concurrency takes a whole number');
    specs = [
      {
        label: 'agent',
        url: fallback.url.replace(/\/+$/, ''),
        workspace: fallback.workspace,
        key,
        command: positionals.length ? positionals : '',
        // Absolute: git and the command run in other directories, where a relative path means
        // something else.
        repos: values.repos
          ? runnerFilePath(values.repos as string, io.env)
          : defaultReposDir(io.env),
        concurrency,
        timeoutMs: parseDuration(values.timeout as string | undefined),
        env: {},
        cwd: 'worktree',
        checkout: true,
        prune: true,
        baseDir: process.cwd(),
        instructions: '',
        output: true,
      },
    ];
  }
  // Off for every agent, whatever the runner files say.
  if (values['no-output']) specs = specs.map((a) => ({ ...a, output: false }));
  if (values.only) {
    const only = (values.only as string).split(',').map((x) => x.trim());
    const unknown = only.filter((l) => !specs.some((a) => a.label === l));
    if (unknown.length) throw new UsageError(`no agent labelled ${unknown.join(', ')}`);
    specs = specs.filter((a) => only.includes(a.label));
  }
  return { specs, values };
}

async function agentRun(ctx: Context, args: string[], opts: { check?: boolean } = {}) {
  const { specs, values } = await agentSpecs(ctx, args, !!opts.check);
  const { io, s } = ctx;
  const stop = new AbortController();
  io.signal?.addEventListener('abort', () => stop.abort());
  // Who each key belongs to, before anything is claimed: a wrong key fails here, not later.
  for (const spec of specs) {
    const { ws } = agentClients(spec, { fetch: io.fetch, signal: stop.signal });
    // A runner started during a deploy waits for Ordo to come back; `check` answers right away.
    const me = await (opts.check
      ? ws.agent.me()
      : untilAvailable(() => ws.agent.me(), {
          signal: stop.signal,
          onRetry: (err, ms) =>
            io.stderr(`${spec.label}: ${err.message}; trying again in ${ms / 1000}s\n`),
        })
    ).catch((err: Error) => {
      throw new RunnerConfigError(`${spec.label}: ${err.message}`);
    });
    const command = typeof spec.command === 'string' ? spec.command : spec.command.join(' ');
    io.stdout(
      `${s.bold(spec.label)} → ${me.name} (@${me.username}) in ${me.workspace.slug}: ${me.teams.map((t) => t.key).join(', ') || 'no teams'}${opts.check ? `\n  runs: ${command}` : ''}\n`,
    );
  }
  if (opts.check) return;
  if (!values.once) io.stdout(s.dim('Waiting for work. Ctrl-C stops taking new runs.\n'));
  const log = (line: string) =>
    io.stdout(`${s.dim(new Date().toTimeString().slice(0, 8))} ${line}\n`);
  stop.signal.addEventListener('abort', () =>
    log('Not taking new runs; running ones finish. Ctrl-C again stops them.'),
  );
  await Promise.all(
    specs.map((spec) =>
      serveAgent(spec, {
        once: !!values.once,
        runnerName: values.name
          ? `${values.name as string}${specs.length > 1 ? `/${spec.label}` : ''}`
          : undefined,
        log,
        signal: stop.signal,
        fetch: io.fetch,
        verbose: !!values.verbose,
      }),
    ),
  );
}

/** Inside a run (`ORDO_RUN_ID`, the agent's key in `ORDO_TOKEN`): asks a person and pauses it. */
async function agentAsk(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, { run: { type: 'string' } });
  const runId = (values.run as string | undefined) ?? ctx.io.env.ORDO_RUN_ID;
  if (!runId) throw new UsageError('no run: use it inside a run (ORDO_RUN_ID) or pass --run <id>');
  const text = positionals.join(' ');
  const question = (text === '-' ? await ctx.io.readStdin() : text).trim();
  if (!question) throw new UsageError('what do you want to ask? "ordo agent ask <question>"');
  const ws = await ctx.workspace(values.workspace as string | undefined);
  const run = await ws.agent.ask(runId, question);
  if (values.json) return ctx.json(run);
  ctx.io.stdout('Asked. Stop working now: the run resumes when someone replies on the issue.\n');
}

/** Inside a run: posts the agent's plan and pauses the run until it's approved or answered. */
async function agentPlan(ctx: Context, args: string[]) {
  const { values, positionals } = parse(args, { run: { type: 'string' } });
  const runId = (values.run as string | undefined) ?? ctx.io.env.ORDO_RUN_ID;
  if (!runId) throw new UsageError('no run: use it inside a run (ORDO_RUN_ID) or pass --run <id>');
  const text = positionals.join(' ');
  const plan = (text === '-' ? await ctx.io.readStdin() : text).trim();
  if (!plan) throw new UsageError('what is the plan? "ordo agent plan <plan>"');
  const ws = await ctx.workspace(values.workspace as string | undefined);
  const run = await ws.agent.plan(runId, plan);
  if (values.json) return ctx.json(run);
  ctx.io.stdout(
    "Plan posted. Stop working now and don't change code: the run resumes when someone approves it or replies.\n",
  );
}
