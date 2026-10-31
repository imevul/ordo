import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Ordo, OrdoError, type WorkspaceClient } from '@ordo/sdk';
import type { AgentRunContext, AgentRunRepository } from '@ordo/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * `ordo agent run`: a generic runner for Ordo agents. It claims an agent's runs, checks out the
 * run's repositories, and launches whatever command you give it with the run described in files
 * and environment variables (the launch contract, docs/agents.md). What the command is — Claude
 * Code, OpenCode, a script of your own — is entirely the runner's business, not Ordo's.
 */

const run = promisify(execFile);

/** One agent the runner serves: who it is (the key), where, and what to launch for each run. */
export interface AgentSpec {
  /** Local name, for logs and the runner name; not the agent's name in Ordo. */
  label: string;
  url: string;
  workspace: string;
  key: string;
  /** An argv list (no shell), or a string run with `sh -c`. */
  command: string | string[];
  /** Where clones and worktrees go. */
  repos: string;
  concurrency: number;
  /** Kill the command and fail the run after this long; 0 for never. */
  timeoutMs: number;
  /** Extra environment for the command. */
  env: Record<string, string>;
  /** Start the command in the first repository's worktree, or in an empty directory. */
  cwd: 'worktree' | 'tmp';
  /** Clone and check out the run's repositories. Off: the command does it from the run file. */
  checkout: boolean;
  /** Remove worktrees of done and canceled issues every half hour. */
  prune: boolean;
  /** The runner file's directory; relative paths resolve against it. */
  baseDir: string;
  /** Added before the agent's own instructions (from Ordo) in every run's prompt. */
  instructions: string;
}

export class RunnerConfigError extends Error {}

// ─── runner files ────────────────────────────────────────────────────

const commandSchema = z.union([
  z.string().trim().min(1),
  z.array(z.union([z.string(), z.number()]).transform(String)).min(1),
]);
const fieldsSchema = z
  .object({
    url: z.string().min(1),
    workspace: z.string().min(1),
    key: z.string().min(1),
    command: commandSchema,
    repos: z.string().min(1),
    concurrency: z.number().int().min(1).max(50),
    timeout: z.union([z.string(), z.number()]),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)),
    cwd: z.enum(['worktree', 'tmp']),
    checkout: z.boolean(),
    prune: z.boolean(),
    instructions: z.string().max(20_000),
  })
  .partial()
  .strict();
const fileSchema = fieldsSchema
  .extend({
    env_file: z.union([z.string(), z.array(z.string())]).optional(),
    defaults: fieldsSchema.optional(),
    agents: z
      .record(z.string().regex(/^[\w.-]+$/, 'Use letters, digits, . _ -'), fieldsSchema)
      .optional(),
  })
  .strict();

/** `.env` text as variables: KEY=value lines, optional `export`, quotes and # comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else value = value.replace(/\s+#.*$/, '');
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Expands `${VAR}` and `${VAR:-default}` in every string. Plain `$VAR` is left alone, so a shell
 * command can still use the launch contract's variables (`$ORDO_PROMPT_FILE`).
 *
 * With `keepUnknown` (for `command` and `instructions`), a variable that isn't set when the file
 * loads is kept as written for the shell, and `${ORDO_…}` always is: the launch contract sets
 * those per run, and the runner's own `ORDO_TOKEN` or `ORDO_URL` must not stand in for them.
 */
export function expandVars(
  value: unknown,
  vars: Record<string, string | undefined>,
  path = '',
  opts: { keepUnknown?: boolean } = {},
): unknown {
  if (typeof value === 'string')
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (match, name: string, fallback: string | undefined) => {
        const v = vars[name];
        if (opts.keepUnknown && (v === undefined || name.startsWith('ORDO_'))) return match;
        if (v !== undefined && v !== '') return v;
        if (fallback !== undefined) return fallback;
        if (opts.keepUnknown) return '';
        throw new RunnerConfigError(`${path || 'value'}: \${${name}} is not set`);
      },
    );
  if (Array.isArray(value)) return value.map((v, i) => expandVars(v, vars, `${path}[${i}]`, opts));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        expandVars(v, vars, path ? `${path}.${k}` : k, opts),
      ]),
    );
  return value;
}

/** "90s", "30m", "2h", "1d", or a number of seconds. */
export function parseDuration(value: string | number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === 'number') return value * 1000;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new RunnerConfigError(`timeout: "${value}" is not a duration like 30m or 2h`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 's']!;
  return Number(m[1]) * unit;
}

export function defaultReposDir(env: Record<string, string | undefined>) {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  return join(base, 'ordo', 'repos');
}

const expandHome = (p: string, env: Record<string, string | undefined>) =>
  p === '~' || p.startsWith('~/') ? join(env.HOME || homedir(), p.slice(1)) : p;
const isRelativePath = (p: string) => p.startsWith('./') || p.startsWith('../');

/**
 * Reads a runner file: one agent at the top level, or several under `agents:`, with `defaults`
 * for all of them. `fallback` fills in the address and workspace from the saved login.
 */
export async function loadRunnerFile(
  path: string,
  env: Record<string, string | undefined>,
  fallback: { url?: string; workspace?: string } = {},
): Promise<{ agents: AgentSpec[]; warnings: string[] }> {
  const file = resolve(path);
  const baseDir = dirname(file);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new RunnerConfigError(`can't read ${path}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    throw new RunnerConfigError(`${path}: ${(err as Error).message}`);
  }
  const shape = fileSchema.safeParse(raw);
  if (!shape.success) throw new RunnerConfigError(formatIssues(path, shape.error));

  // Variables: a sibling .env, then env_file entries in order, then the real environment.
  const vars: Record<string, string | undefined> = {};
  const sibling = join(baseDir, '.env');
  const listed = [shape.data.env_file ?? []].flat().map((f) => resolve(baseDir, f));
  if (!listed.includes(sibling) && existsSync(sibling))
    Object.assign(vars, parseDotenv(await readFile(sibling, 'utf8')));
  for (const f of listed) {
    if (!existsSync(f)) throw new RunnerConfigError(`env_file: ${f} doesn't exist`);
    Object.assign(vars, parseDotenv(await readFile(f, 'utf8')));
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) vars[k] = v;

  // In `command` and `instructions`, only what's known now is expanded: `${ORDO_MCP_CONFIG}` and
  // the rest of the launch contract only exist when a run starts, so the shell expands them then.
  // `.env` and `env_file` values don't reach the command's environment, so they must go in here.
  type Fields = z.infer<typeof fieldsSchema>;
  const expandFields = <T extends Fields>(fields: T, where: string): T => {
    const { command, instructions, ...rest } = fields;
    const at = (k: string) => (where ? `${where}.${k}` : k);
    const keep = { keepUnknown: true };
    return {
      ...(expandVars(rest, vars, where) as T),
      ...(command !== undefined && { command: expandVars(command, vars, at('command'), keep) }),
      ...(instructions !== undefined && {
        instructions: expandVars(instructions, vars, at('instructions'), keep),
      }),
    };
  };
  const { agents: rawAgents, defaults: rawDefaults, env_file: _, ...rawTop } = shape.data;
  const top = expandFields(rawTop, '');
  const defaults = rawDefaults ? expandFields(rawDefaults, 'defaults') : {};
  const agents =
    rawAgents &&
    Object.fromEntries(
      Object.entries(rawAgents).map(([l, f]) => [l, expandFields(f, `agents.${l}`)]),
    );
  const entries: [string, z.infer<typeof fieldsSchema>][] = agents
    ? Object.entries(agents)
    : [[basename(file).replace(/\.ya?ml$/i, '') || 'agent', {}]];
  if (agents && (top.key || top.command))
    throw new RunnerConfigError(
      `${path}: put key and command under agents.<label>, or drop agents:`,
    );
  if (entries.length === 0) throw new RunnerConfigError(`${path}: agents: is empty`);

  const warnings: string[] = [];
  if (/\bordo_[A-Za-z0-9_-]{16,}/.test(text) && ((await stat(file)).mode & 0o004) !== 0)
    warnings.push(`${path} holds an API key and anyone on this machine can read it (chmod 600)`);

  const specs = entries.map(([label, own]): AgentSpec => {
    const merged = { ...top, ...defaults, ...own, env: { ...defaults.env, ...own.env } };
    const where = agents ? `agents.${label}` : path;
    const url = merged.url ?? fallback.url;
    const workspace = merged.workspace ?? fallback.workspace;
    for (const [field, value] of [
      ['key', merged.key],
      ['command', merged.command],
      ['url', url],
      ['workspace', workspace],
    ] as const)
      if (!value) throw new RunnerConfigError(`${where}.${field}: required`);
    const command =
      Array.isArray(merged.command) && isRelativePath(merged.command[0]!)
        ? [resolve(baseDir, merged.command[0]!), ...merged.command.slice(1)]
        : merged.command!;
    return {
      label,
      url: url!.replace(/\/+$/, ''),
      workspace: workspace!,
      key: merged.key!,
      command,
      repos: resolve(baseDir, expandHome(merged.repos ?? defaultReposDir(env), env)),
      concurrency: merged.concurrency ?? 1,
      timeoutMs: parseDuration(merged.timeout),
      env: Object.fromEntries(
        Object.entries(merged.env ?? {}).map(([k, v]) => [
          k,
          isRelativePath(v) ? resolve(baseDir, v) : v,
        ]),
      ),
      cwd: merged.cwd ?? 'worktree',
      checkout: merged.checkout ?? true,
      prune: merged.prune ?? true,
      baseDir,
      // Instructions add up rather than override: shared conventions first, then this agent's.
      instructions: [top.instructions, defaults.instructions, own.instructions]
        .filter((x): x is string => !!x?.trim())
        .join('\n\n'),
    };
  });
  return { agents: specs, warnings };
}

function formatIssues(path: string, error: z.ZodError) {
  return error.issues
    .map((i) => {
      const at = i.path.join('.');
      const what =
        i.code === 'unrecognized_keys' ? `unknown field ${i.keys.join(', ')}` : i.message;
      return `${path}${at ? `: ${at}` : ''}: ${what}`;
    })
    .join('\n');
}

// ─── checkouts ───────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();
/** One git operation per clone at a time; concurrent runs share clones. */
function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  return next;
}

const git = (args: string[], cwd?: string) =>
  run('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

async function refExists(clone: string, ref: string) {
  try {
    await git(['rev-parse', '--verify', '--quiet', ref], clone);
    return true;
  } catch {
    return false;
  }
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_');

/**
 * Before one branch per issue, each agent had its own (`claude-coder/eng-5-…`). The newest such
 * local branch for this issue's branch name, so work in flight carries on where it was.
 */
async function legacyBranch(clone: string, branch: string) {
  const { stdout } = await git(
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      `refs/heads/*/${branch}`,
    ],
    clone,
  );
  return stdout.split('\n').find(Boolean) ?? null;
}

/** The worktree `branch` is checked out in, if any (git allows only one). */
async function worktreeOf(clone: string, branch: string) {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], clone);
  let path: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && path !== clone) return path;
  }
  return null;
}

/** Worktree paths a run on this machine is using right now; pruning leaves them alone. */
const inUse = new Set<string>();

/**
 * A worktree of each repository on the run's branch: an existing local branch is reused (a
 * second run continues the first's work), then the remote's, else a new one from the default
 * branch. Clones live in `reposDir` and are fetched before each run.
 */
export async function checkout(
  repos: AgentRunRepository[],
  reposDir: string,
): Promise<{ name: string; path: string }[]> {
  await mkdir(reposDir, { recursive: true });
  const out: { name: string; path: string }[] = [];
  for (const repo of repos) {
    const clone = join(reposDir, `${safeName(repo.name)}-${repo.id.slice(0, 8)}`);
    let branch = repo.suggestedBranch;
    let tree = join(`${clone}.worktrees`, safeName(branch));
    await locked(clone, async () => {
      if (!existsSync(join(clone, '.git'))) await git(['clone', '--quiet', repo.url, clone]);
      else await git(['fetch', '--quiet', '--prune', 'origin'], clone);
      if (existsSync(tree)) return;
      if (
        !(await refExists(clone, `refs/heads/${branch}`)) &&
        !(await refExists(clone, `refs/remotes/origin/${branch}`))
      ) {
        const legacy = await legacyBranch(clone, branch);
        if (legacy) {
          branch = legacy;
          tree = join(`${clone}.worktrees`, safeName(branch));
          if (existsSync(tree)) return;
        }
      }
      await git(['worktree', 'prune'], clone);
      // An agent may have switched another worktree to this branch (say, one named the old way):
      // the work is there, and git won't check the branch out twice.
      const current = await worktreeOf(clone, branch);
      if (current) {
        tree = current;
        return;
      }
      if (await refExists(clone, `refs/heads/${branch}`))
        await git(['worktree', 'add', '--quiet', tree, branch], clone);
      else if (await refExists(clone, `refs/remotes/origin/${branch}`))
        await git(['worktree', 'add', '--quiet', '-b', branch, tree, `origin/${branch}`], clone);
      else if (await refExists(clone, `refs/remotes/origin/${repo.defaultBranch}`))
        await git(
          [
            'worktree',
            'add',
            '--quiet',
            '--no-track',
            '-b',
            branch,
            tree,
            `origin/${repo.defaultBranch}`,
          ],
          clone,
        );
      else throw new Error(`${repo.name} has no branch "${repo.defaultBranch}"`);
    });
    out.push({ name: repo.name, path: tree });
  }
  return out;
}

// ─── the launch contract ─────────────────────────────────────────────

export interface LaunchResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  summary: string | null;
  error: string | null;
  /** When the runner knows why it failed; otherwise Ordo reads the error. */
  failureReason?: 'timeout';
  sessionUrl: string | null;
}

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

// Commands run in their own process group (POSIX), so the terminal's Ctrl-C reaches only the
// runner, and stopping a run stops everything it started (shells, pnpm, browsers).
const groups = process.platform !== 'win32';
const running = new Set<ChildProcess>();

/** Signals a command and everything it started; false when nothing was left to signal. */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals | 0) {
  if (!child.pid) return false;
  try {
    if (groups) process.kill(-child.pid, sig);
    else if (sig) child.kill(sig);
    else return child.exitCode === null && child.signalCode === null;
    return true;
  } catch {
    return false;
  }
}

/** Signals every running command's process group (for a forced stop of the runner). */
export function signalRunning(sig: NodeJS.Signals) {
  for (const child of running) signalGroup(child, sig);
}

const SESSION_LINE = /^ORDO_SESSION_URL=(\S+)\s*$/;
const RESUME_LINE = /^ORDO_RESUME=(\S+)\s*$/;

/**
 * Runs the command for one run, as the launch contract says: the run in `ORDO_RUN_FILE`, the
 * prompt in `ORDO_PROMPT_FILE` and on stdin, a summary from `ORDO_SUMMARY_FILE` (or the end of
 * stdout), `ORDO_SESSION_URL=` lines reported as they appear, and the exit code as the outcome.
 */
export async function launch(
  spec: Pick<AgentSpec, 'command' | 'env' | 'timeoutMs' | 'url' | 'workspace' | 'key' | 'baseDir'>,
  context: AgentRunContext,
  opts: {
    workdir: string | null;
    repoPaths: { name: string; path: string }[];
    onStart?: (pid: number | undefined) => void;
    onSessionUrl?: (url: string) => void;
    /** An `ORDO_RESUME=` line: the command's handle on its session, for the next pickup. */
    onResume?: (token: string) => void;
    onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
    /** Resolves when the run should stop (cancelled in Ordo). */
    cancelled?: Promise<void>;
    /** How long a stopped command gets between SIGTERM and SIGKILL (default 10s). */
    graceMs?: number;
  },
): Promise<LaunchResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ordo-run-'));
  try {
    const runFile = join(dir, 'run.json');
    const promptFile = join(dir, 'prompt.md');
    const summaryFile = join(dir, 'summary.md');
    const mcpFile = join(dir, 'mcp.json');
    await writeFile(runFile, `${JSON.stringify(context, null, 2)}\n`);
    await writeFile(promptFile, context.prompt);
    // The Ordo MCP server as the agent, in the `mcpServers` format MCP clients read (e.g.
    // `claude --mcp-config`). It holds the key, so only its owner may read it.
    await writeFile(
      mcpFile,
      `${JSON.stringify(
        {
          mcpServers: {
            ordo: {
              type: 'http',
              url: `${spec.url}/api/w/${encodeURIComponent(spec.workspace)}/mcp`,
              headers: { Authorization: `Bearer ${spec.key}` },
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const workdir = opts.workdir ?? dir;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...spec.env,
      ORDO_URL: spec.url,
      ORDO_WORKSPACE: spec.workspace,
      // The CLI and SDK inside the run act as the agent.
      ORDO_TOKEN: spec.key,
      ORDO_AGENT_KEY: spec.key,
      ORDO_RUN_ID: context.run.id,
      ORDO_ISSUE: context.issue.identifier,
      ORDO_ISSUE_URL: context.issue.url,
      ORDO_WORKDIR: workdir,
      ORDO_RUN_FILE: runFile,
      ORDO_MCP_CONFIG: mcpFile,
      ORDO_PROMPT_FILE: promptFile,
      ORDO_SUMMARY_FILE: summaryFile,
      ORDO_REPO_PATHS: JSON.stringify(
        Object.fromEntries(opts.repoPaths.map((r) => [r.name, r.path])),
      ),
      ORDO_RUNNER_DIR: spec.baseDir,
      // A pickup after a question: what was asked, and how to continue the session.
      ORDO_QUESTION: context.run.question ?? '',
      ORDO_RESUME: context.run.resume ?? '',
    };
    const [cmd, args] =
      typeof spec.command === 'string'
        ? ['sh', ['-c', spec.command]]
        : [spec.command[0]!, spec.command.slice(1)];
    const child = spawn(cmd, args, {
      cwd: workdir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: groups,
    });
    running.add(child);
    opts.onStart?.(child.pid);
    child.stdin.on('error', () => {}); // commands that don't read stdin close it early
    child.stdin.end(context.prompt);

    let stdout = '';
    let stderr = '';
    let sessionUrl: string | null = null;
    const lines = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop()!;
        for (const line of parts) {
          const m = stream === 'stdout' ? SESSION_LINE.exec(line) : null;
          if (m) {
            sessionUrl = m[1]!;
            opts.onSessionUrl?.(sessionUrl);
            continue;
          }
          const r = stream === 'stdout' ? RESUME_LINE.exec(line) : null;
          if (r) {
            opts.onResume?.(r[1]!);
            continue;
          }
          if (stream === 'stdout') stdout = tail(`${stdout}${line}\n`, 64 * 1024);
          else stderr = tail(`${stderr}${line}\n`, 64 * 1024);
          opts.onOutput?.(line, stream);
        }
      };
    };
    child.stdout.on('data', lines('stdout'));
    child.stderr.on('data', lines('stderr'));

    let closed = false;
    let stopped: 'cancelled' | 'timeout' | null = null;
    let force: NodeJS.Timeout | undefined;
    const kill = (why: 'cancelled' | 'timeout') => {
      if (stopped || closed) return;
      stopped = why;
      signalGroup(child, 'SIGTERM');
      // The whole group, even if the command itself is already gone: what it started may not be.
      force = setTimeout(() => signalGroup(child, 'SIGKILL'), opts.graceMs ?? 10_000);
    };
    const timer = spec.timeoutMs ? setTimeout(() => kill('timeout'), spec.timeoutMs) : undefined;
    void opts.cancelled?.then(() => kill('cancelled'));

    const code = await new Promise<number | null>((resolveExit) => {
      child.on('error', (err) => {
        stderr += `${err.message}\n`;
        resolveExit(127);
      });
      child.on('close', (c) => resolveExit(c));
    });
    closed = true;
    running.delete(child);
    clearTimeout(timer);
    // Nothing left in the group: no SIGKILL to send (and nothing to hold the runner for).
    if (!signalGroup(child, 0)) clearTimeout(force);

    let summary: string | null = null;
    try {
      summary = (await readFile(summaryFile, 'utf8')).trim() || null;
    } catch {}
    summary ??= tail(stdout.trim(), 4096) || null;
    if (stopped === 'cancelled') return { status: 'cancelled', summary, error: null, sessionUrl };
    if (stopped === 'timeout')
      return {
        status: 'failed',
        summary,
        error: `Timed out after ${Math.round(spec.timeoutMs / 60_000)} minutes`,
        failureReason: 'timeout',
        sessionUrl,
      };
    if (code === 0) return { status: 'succeeded', summary, error: null, sessionUrl };
    return {
      status: 'failed',
      summary,
      error: tail(
        // Some tools say what went wrong on stdout (e.g. "not logged in"), so that's next best.
        `${stderr.trim() || stdout.trim() || 'No output.'}\n(exit code ${code ?? 'signal'})`,
        4000,
      ),
      sessionUrl,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── serving an agent ────────────────────────────────────────────────

export interface ServeOptions {
  /** Work through what's queued now, then return. */
  once?: boolean;
  /** What the runner calls itself in Ordo (default host/label). */
  runnerName?: string;
  log: (line: string) => void;
  /** Stop claiming; running commands finish (or are killed if the runner is forced to quit). */
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** Echo the command's output into the log. */
  verbose?: boolean;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      r();
    });
  });

/** Ordo restarting or unreachable for a moment (a deploy, a proxy), as opposed to a real answer. */
export const isTransient = (err: unknown) =>
  !(err instanceof OrdoError) || [429, 502, 503, 504].includes(err.status);

/**
 * Calls `fn` until it answers, while failures are transient (see `isTransient`), backing off
 * from one second to `maxDelayMs`, for at most `forMs`. Other errors, and the last transient one,
 * are thrown.
 */
export async function untilAvailable<T>(
  fn: () => Promise<T>,
  opts: {
    signal: AbortSignal;
    onRetry?: (err: Error, delayMs: number) => void;
    forMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  const until = Date.now() + (opts.forMs ?? 5 * 60_000);
  let delay = 1000;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || Date.now() + delay > until || opts.signal.aborted) throw err;
      opts.onRetry?.(err as Error, delay);
      await sleep(delay, opts.signal);
      delay = Math.min(delay * 2, opts.maxDelayMs ?? 30_000);
    }
  }
}

/** Clients for one agent: one whose claims are cut off by the stop signal, one that isn't. */
export function agentClients(spec: AgentSpec, opts: Pick<ServeOptions, 'fetch' | 'signal'>) {
  const base = opts.fetch ?? globalThis.fetch;
  const ws = new Ordo({ url: spec.url, token: spec.key, fetch: base }).workspace(spec.workspace);
  const claims = new Ordo({
    url: spec.url,
    token: spec.key,
    fetch: (input, init) => base(input, { ...init, signal: opts.signal }),
  }).workspace(spec.workspace);
  return { ws, claims };
}

/** How often a long-running runner clears out worktrees of finished issues. */
const PRUNE_EVERY_MS = 30 * 60_000;
const ISSUE_IN_BRANCH = /(?:^|\/)([a-z][a-z0-9]{0,6}-\d+)(?:-|$)/i;

/**
 * Removes worktrees whose issue is done or canceled, so they don't pile up (each is a full
 * checkout, often with installed dependencies). Branches stay; worktrees in use, of issues this
 * agent can't see, or whose branch names no issue are left alone.
 */
export function pruneWorktrees(
  ws: Pick<WorkspaceClient, 'issues'>,
  reposDir: string,
  log: (line: string) => void,
): Promise<number> {
  // Agents of one runner usually share a repos directory: one sweep at a time does for all.
  const running = sweeps.get(reposDir);
  if (running) return running;
  const sweep = sweepWorktrees(ws, reposDir, log).finally(() => sweeps.delete(reposDir));
  sweeps.set(reposDir, sweep);
  return sweep;
}

const sweeps = new Map<string, Promise<number>>();

async function sweepWorktrees(
  ws: Pick<WorkspaceClient, 'issues'>,
  reposDir: string,
  log: (line: string) => void,
) {
  if (!existsSync(reposDir)) return 0;
  let removed = 0;
  for (const entry of await readdir(reposDir)) {
    if (!entry.endsWith('.worktrees')) continue;
    const clone = join(reposDir, entry.slice(0, -'.worktrees'.length));
    if (!existsSync(join(clone, '.git'))) continue;
    for (const name of await readdir(join(reposDir, entry))) {
      const tree = join(reposDir, entry, name);
      if (inUse.has(tree)) continue;
      let branch: string;
      try {
        branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], tree)).stdout.trim();
      } catch {
        continue;
      }
      const identifier = branch.match(ISSUE_IN_BRANCH)?.[1]?.toUpperCase();
      if (!identifier) continue;
      const issue = await ws.issues.get(identifier).catch(() => null);
      if (!issue || (!issue.completedAt && !issue.canceledAt)) continue;
      await locked(clone, async () => {
        if (inUse.has(tree) || !existsSync(tree)) return false;
        await git(['worktree', 'remove', '--force', tree], clone);
        return true;
      }).then(
        (done) => {
          if (!done) return;
          removed++;
          log(
            `removed the worktree of ${identifier} (${issue.completedAt ? 'done' : 'canceled'}): ${tree}`,
          );
        },
        (err: Error) => log(`couldn't remove ${tree}: ${err.message}`),
      );
    }
  }
  return removed;
}

/** Claims and works on one agent's runs until stopped (or, with `once`, until the queue is empty). */
export async function serveAgent(spec: AgentSpec, opts: ServeOptions) {
  const { ws, claims } = agentClients(spec, opts);
  const runner = opts.runnerName ?? `${hostname()}/${spec.label}`;
  const log = (line: string) => opts.log(`[${spec.label}] ${line}`);
  if (spec.checkout && spec.prune && !opts.once) {
    const sweep = () => pruneWorktrees(ws, spec.repos, log).catch(() => 0);
    void sweep();
    const timer = setInterval(sweep, PRUNE_EVERY_MS);
    opts.signal.addEventListener('abort', () => clearInterval(timer));
  }
  // Said once per pause, by whichever worker notices it.
  let pausedUntil: string | null = null;
  const notePause = async () => {
    const me = await claims.agent.me().catch(() => null);
    if (!me || me.pausedUntil === pausedUntil) return;
    pausedUntil = me.pausedUntil;
    if (pausedUntil)
      log(
        `paused until ${new Date(pausedUntil).toLocaleString()}${me.pauseReason === 'usage_limit' ? ' (the agent hit its usage limit)' : ''}; claiming nothing until then`,
      );
    else log('no longer paused');
  };
  const worker = async () => {
    let backoff = 1000;
    while (!opts.signal.aborted) {
      let context: AgentRunContext | null;
      try {
        context = await claims.agent.claim({
          wait: opts.once ? 0 : 30,
          runner,
          instructions: spec.instructions || undefined,
        });
        backoff = 1000;
      } catch (err) {
        if (opts.signal.aborted) return;
        if (err instanceof OrdoError && (err.status === 401 || err.status === 403)) {
          log(`the key was refused (${err.message}); stopping`);
          return;
        }
        log(`can't claim: ${(err as Error).message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff, opts.signal);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      if (!context) {
        if (opts.once) return;
        await notePause();
        continue;
      }
      await work(ws, spec, context, { ...opts, log });
    }
  };
  await Promise.all(Array.from({ length: spec.concurrency }, worker));
}

async function work(
  ws: WorkspaceClient,
  spec: AgentSpec,
  context: AgentRunContext,
  opts: ServeOptions,
) {
  const id = context.issue.identifier;
  const runId = context.run.id;
  opts.log(
    `${id} ${context.run.question ? 'resumed after a reply' : 'claimed'} (attempt ${context.run.attempts}): ${context.issue.title}`,
  );
  let cancel = () => {};
  const cancelled = new Promise<void>((r) => {
    cancel = r;
  });
  const beat = setInterval(async () => {
    try {
      if ((await ws.agent.heartbeat(runId)).cancelled) {
        opts.log(`${id} was cancelled in Ordo; stopping it`);
        cancel();
      }
    } catch (err) {
      opts.log(`${id} heartbeat failed: ${(err as Error).message}`);
    }
  }, 60_000);
  let refused: string | null = null;
  const report = (input: Parameters<WorkspaceClient['agent']['report']>[1]) =>
    ws.agent.report(runId, input).catch((err: Error) => {
      refused = err.message;
      opts.log(`${id} report failed: ${err.message}`);
      return undefined;
    });
  const held: string[] = [];
  try {
    let repoPaths: { name: string; path: string }[] = [];
    if (spec.checkout && context.repositories.length) {
      try {
        repoPaths = await checkout(context.repositories, spec.repos);
        for (const r of repoPaths) {
          inUse.add(r.path);
          held.push(r.path);
        }
      } catch (err) {
        const message = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
        opts.log(`${id} checkout failed: ${message}`);
        await report({
          status: 'failed',
          error: `Checkout failed on ${hostname()}: ${message}`,
          failureReason: 'checkout',
        });
        return;
      }
    }
    const workdir = spec.cwd === 'worktree' && repoPaths[0] ? repoPaths[0].path : null;
    const pending: Promise<unknown>[] = [];
    const result = await launch(spec, context, {
      workdir,
      repoPaths,
      cancelled,
      onStart: () => {
        pending.push(report({ status: 'running' }));
        opts.log(`${id} running in ${workdir ?? 'a temporary directory'}`);
      },
      onSessionUrl: (url) => {
        pending.push(report({ sessionUrl: url }));
      },
      onResume: (token) => {
        pending.push(report({ resume: token }));
      },
      onOutput: opts.verbose ? (line) => opts.log(`${id} │ ${line}`) : undefined,
    });
    await Promise.all(pending);
    if (result.status === 'cancelled') return;
    const saved = await report({
      status: result.status,
      summary: result.summary,
      error: result.error,
      ...(result.failureReason && { failureReason: result.failureReason }),
      ...(result.sessionUrl && { sessionUrl: result.sessionUrl }),
    });
    // The agent asked a question: the run waits for a reply, whatever the command's exit said.
    if (saved?.status === 'waiting') opts.log(`${id} is waiting for an answer`);
    else if (!saved)
      opts.log(
        `${id} finished (${result.status}), but Ordo didn't take the report: ${refused ?? 'unknown error'}`,
      );
    else
      opts.log(`${id} ${result.status}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`);
  } finally {
    clearInterval(beat);
    for (const path of held) inUse.delete(path);
  }
}

/** For `--file` and `--repos`: relative to the current directory, and `~`. */
export const runnerFilePath = (p: string, env: Record<string, string | undefined>) =>
  isAbsolute(p) ? p : resolve(expandHome(p, env));
