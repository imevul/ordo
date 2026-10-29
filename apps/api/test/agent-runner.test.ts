// biome-ignore-all lint/suspicious/noTemplateCurlyInString: runner files spell variables as ${VAR}
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Io, run } from '@ordo/cli';
import { expandVars, loadRunnerFile, parseDotenv } from '@ordo/cli/agent';
import type { AgentRun, AgentRunContext, Comment } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let url: string;
let dir: string;
let eng: string;
const keys: Record<string, string> = {};
const agents: Record<string, string> = {};
const slug = 'runner';
const ws = `/api/w/${slug}`;

async function ordo(args: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    env: { XDG_CONFIG_HOME: join(dir, 'config'), HOME: dir, ...env },
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    readStdin: async () => '',
    prompt: async () => '',
    openUrl: () => {},
    color: false,
    width: 120,
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

function write(name: string, text: string) {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, 0o600);
  return path;
}

beforeAll(async () => {
  app = await testApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'ordo-runner-'));

  // A repository with a main branch, as a runner would clone it.
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '--quiet', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), '# Seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'Initial');
  const bare = join(dir, 'origin.git');
  execFileSync('git', ['clone', '--quiet', '--bare', seed, bare]);

  owner = (await signup(app, 'Rita Runner')).client;
  await owner.post('/api/workspaces', { name: 'Runner', slug, teamName: 'Eng', teamKey: 'ENG' });
  eng = (await owner.get(`${ws}/bootstrap`)).data.teams[0].id;
  const repo = (await owner.post(`${ws}/repositories`, { name: 'app', url: bare })).data;
  await owner.patch(`${ws}/teams/${eng}`, { defaultRepositoryId: repo.id });
  for (const name of ['Claude', 'Docs']) {
    agents[name] = (
      await owner.post(`${ws}/agents`, { name: `Runner ${name}`, teamIds: [eng] })
    ).data.id;
    keys[name] = (
      await owner.post(`${ws}/agents/${agents[name]}/keys`, { name: 'test' })
    ).data.token;
  }
});
afterAll(() => app.close());

const assign = async (title: string, agent = 'Claude') =>
  (await owner.post(`${ws}/issues`, { teamId: eng, title, assigneeId: agents[agent] })).data as {
    id: string;
    identifier: string;
  };
const runsOf = async (id: string) =>
  (await owner.get(`${ws}/issues/${id}/agent-runs`)).data as AgentRun[];
const lastComment = async (id: string) =>
  ((await owner.get(`${ws}/issues/${id}/comments`)).data as Comment[]).at(-1);

describe('runner files', () => {
  it('parse .env files', () => {
    expect(
      parseDotenv('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=plain # note\n\nbad line\n'),
    ).toEqual({ A: '1', B: 'two words', C: 'x', D: 'plain' });
  });

  it('expand ${VAR} and ${VAR:-default}, and leave $VAR for the shell', () => {
    expect(
      expandVars(
        { a: '${X}', b: ['${Y:-fallback}'], c: 'cat "$ORDO_PROMPT_FILE" ${X}' },
        { X: 'x' },
      ),
    ).toEqual({ a: 'x', b: ['fallback'], c: 'cat "$ORDO_PROMPT_FILE" x' });
    expect(() => expandVars({ agents: { a: { key: '${NOPE}' } } }, {})).toThrow(
      'agents.a.key: ${NOPE} is not set',
    );
  });

  it('read one agent, or a team with defaults', async () => {
    write('.env', 'ONE_KEY=from-dotenv\nTWO_KEY=from-dotenv\n');
    write('extra.env', 'TWO_KEY=from-env-file\n');
    const single = write(
      'single.yaml',
      'url: https://ordo.example.com\nworkspace: acme\nkey: ${ONE_KEY}\ncommand: [./bin/go, --fast]\n',
    );
    const one = await loadRunnerFile(single, {});
    expect(one.agents).toEqual([
      expect.objectContaining({
        label: 'single',
        key: 'from-dotenv',
        command: [join(dir, 'bin/go'), '--fast'],
        concurrency: 1,
        cwd: 'worktree',
        checkout: true,
      }),
    ]);

    const team = write(
      'team.yaml',
      [
        'url: https://ordo.example.com',
        'workspace: acme',
        'env_file: extra.env',
        'defaults:',
        '  repos: ./repos',
        '  timeout: 2h',
        '  env: { SHARED: "1", CONFIG: ./conf.json }',
        '  instructions: Keep pull requests small.',
        'agents:',
        '  one:',
        '    key: ${ONE_KEY}',
        '    command: claude -p',
        '  two:',
        '    key: ${TWO_KEY}',
        '    command: [opencode, run]',
        '    concurrency: 2',
        '    instructions: |',
        '      Only touch docs/.',
        '    env: { OWN: "yes" }',
      ].join('\n'),
    );
    const {
      agents: [a, b],
    } = await loadRunnerFile(team, { ONE_KEY: 'from-process' });
    // The real environment beats env files, which beat a sibling .env.
    expect(a).toMatchObject({ label: 'one', key: 'from-process', command: 'claude -p' });
    expect(b).toMatchObject({ label: 'two', key: 'from-env-file', concurrency: 2 });
    expect(a!.repos).toBe(join(dir, 'repos'));
    expect(a!.timeoutMs).toBe(2 * 3_600_000);
    expect(b!.env).toEqual({ SHARED: '1', CONFIG: join(dir, 'conf.json'), OWN: 'yes' });
    // Instructions add up: the defaults', then the agent's own.
    expect(a!.instructions).toBe('Keep pull requests small.');
    expect(b!.instructions).toBe('Keep pull requests small.\n\nOnly touch docs/.\n');
  });

  it('name the field that is wrong', async () => {
    const bad = write('bad.yaml', 'agents:\n  x:\n    key: k\n    commnd: oops\n');
    await expect(loadRunnerFile(bad, {})).rejects.toThrow('agents.x: unknown field commnd');
    const missing = write(
      'missing.yaml',
      'url: https://o.example.com\nworkspace: w\nagents:\n  x:\n    key: k\n',
    );
    await expect(loadRunnerFile(missing, {})).rejects.toThrow('agents.x.command: required');
  });
});

describe('ordo agent', () => {
  it('checks a runner file against Ordo, and runs a subset with --only', async () => {
    write('.env', `CLAUDE_KEY=${keys.Claude}\nDOCS_KEY=${keys.Docs}\n`);
    const file = write(
      'factory.yaml',
      [
        `url: ${url}`,
        `workspace: ${slug}`,
        'defaults:',
        '  repos: ./repos',
        'agents:',
        '  claude:',
        '    key: ${CLAUDE_KEY}',
        '    command: [sh, -c, "exit 0"]',
        '  docs:',
        '    key: ${DOCS_KEY}',
        '    command: "true"',
      ].join('\n'),
    );
    const all = await ordo(['agent', 'check', '--file', file]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain('claude → Runner Claude (@runner-claude) in runner: ENG');
    expect(all.stdout).toContain('docs → Runner Docs (@runner-docs) in runner: ENG');
    const some = await ordo(['agent', 'check', '--file', file, '--only', 'docs']);
    expect(some.stdout).not.toContain('claude →');

    const wrong = write(
      'wrong.yaml',
      `url: ${url}\nworkspace: ${slug}\nkey: ordo_nope\ncommand: "true"\n`,
    );
    const refused = await ordo(['agent', 'check', '--file', wrong]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('wrong:');
  });

  it('runs the command in a worktree, as the launch contract says', async () => {
    const issue = await assign('Add a greeting');
    const script = write(
      'work.sh',
      [
        '#!/bin/sh',
        'set -e',
        'cat > "$ORDO_RUNNER_DIR/prompt-copy.md"',
        'cp "$ORDO_RUN_FILE" "$ORDO_RUNNER_DIR/run-copy.json"',
        'cp "$ORDO_MCP_CONFIG" "$ORDO_RUNNER_DIR/mcp-copy.json"',
        'echo "$ORDO_ISSUE $ORDO_WORKSPACE $(git rev-parse --abbrev-ref HEAD)" > "$ORDO_RUNNER_DIR/env-copy.txt"',
        'echo hello > greeting.txt',
        'echo "ORDO_SESSION_URL=https://agents.example.com/s/42"',
        'echo "noise on stdout"',
        'printf "Added greeting.txt for %s." "$ORDO_ISSUE" > "$ORDO_SUMMARY_FILE"',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    const file = write(
      'one.yaml',
      `url: ${url}\nworkspace: ${slug}\nkey: ${keys.Claude}\ncommand: [./work.sh]\nrepos: ./repos\ninstructions: Say hello in Swedish.\n`,
    );
    const res = await ordo(['agent', 'run', '--file', file, '--once', '--name', 'ci']);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`${issue.identifier} succeeded`);

    const [runRow] = await runsOf(issue.id);
    expect(runRow).toMatchObject({
      status: 'succeeded',
      runnerName: 'ci',
      sessionUrl: 'https://agents.example.com/s/42',
      summary: `Added greeting.txt for ${issue.identifier}.`,
    });
    expect(await lastComment(issue.id)).toMatchObject({
      authorId: agents.Claude,
      body: `Added greeting.txt for ${issue.identifier}.`,
    });

    // The prompt came on stdin, the run file is the claimed context, and the env is set.
    expect(readFileSync(join(dir, 'prompt-copy.md'), 'utf8')).toContain('Add a greeting');
    expect(readFileSync(join(dir, 'prompt-copy.md'), 'utf8')).toContain(
      '## Instructions\nSay hello in Swedish.',
    );
    const ctx = JSON.parse(readFileSync(join(dir, 'run-copy.json'), 'utf8')) as AgentRunContext;
    expect(ctx.run.id).toBe(runRow!.id);
    // A ready MCP config: the workspace's MCP endpoint with the agent's key.
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp-copy.json'), 'utf8'));
    expect(mcp.mcpServers.ordo).toEqual({
      type: 'http',
      url: `${url}/api/w/${slug}/mcp`,
      headers: { Authorization: `Bearer ${keys.Claude}` },
    });
    const branch = ctx.repositories[0]!.suggestedBranch;
    expect(branch).toMatch(/^runner-claude\/eng-\d+-add-a-greeting$/);
    expect(readFileSync(join(dir, 'env-copy.txt'), 'utf8').trim()).toBe(
      `${issue.identifier} ${slug} ${branch}`,
    );
    // The work stays in the worktree, on the run's branch.
    const tree = join(
      dir,
      'repos',
      `app-${ctx.repositories[0]!.id.slice(0, 8)}.worktrees`,
      branch.replace('/', '_'),
    );
    expect(existsSync(join(tree, 'greeting.txt'))).toBe(true);
  });

  it('reports a failing command with the end of its stderr', async () => {
    const issue = await assign('This will fail');
    const res = await ordo(
      [
        'agent',
        'run',
        '--once',
        '-w',
        slug,
        '--url',
        url,
        '--repos',
        join(dir, 'repos'),
        '--',
        'sh',
        '-c',
        'echo "it broke" >&2; exit 3',
      ],
      { ORDO_AGENT_KEY: keys.Claude },
    );
    expect(res.code).toBe(0);
    const [runRow] = await runsOf(issue.id);
    expect(runRow!.status).toBe('failed');
    expect(runRow!.error).toContain('it broke');
    expect(runRow!.error).toContain('exit code 3');
    expect((await lastComment(issue.id))!.body).toContain('This run failed');

    // Silent on stderr: what it said on stdout is the error instead.
    const quiet = await assign('Not logged in');
    await ordo(
      [
        'agent',
        'run',
        '--once',
        '-w',
        slug,
        '--url',
        url,
        '--repos',
        join(dir, 'repos'),
        '--',
        'sh',
        '-c',
        'echo "Please log in first"; exit 1',
      ],
      { ORDO_AGENT_KEY: keys.Claude },
    );
    expect((await runsOf(quiet.id))[0]!.error).toBe('Please log in first\n(exit code 1)');
  });

  it('works without a repository when checkout is off', async () => {
    const issue = await assign('No checkout', 'Docs');
    const file = write(
      'docs.yaml',
      `url: ${url}\nworkspace: ${slug}\nkey: ${keys.Docs}\ncheckout: false\ncommand: 'test ! -d .git && echo "in $(basename "$PWD")"'\n`,
    );
    expect((await ordo(['agent', 'run', '--file', file, '--once'])).code).toBe(0);
    const [runRow] = await runsOf(issue.id);
    expect(runRow).toMatchObject({ status: 'succeeded' });
    expect(runRow!.summary).toMatch(/^in ordo-run-/);
  });

  it('leaves a run waiting when the agent asks, and resumes it with the token after a reply', async () => {
    const issue = await assign('Pick a colour');
    const script = write(
      'ask.sh',
      [
        '#!/bin/sh',
        'if [ -z "$ORDO_QUESTION" ]; then',
        '  echo "ORDO_RESUME=sess-42"',
        `  node -e 'fetch(process.env.ORDO_URL + "/api/w/" + process.env.ORDO_WORKSPACE + "/agent/runs/" + process.env.ORDO_RUN_ID, { method: "PATCH", headers: { authorization: "Bearer " + process.env.ORDO_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ status: "waiting", question: "Which colour?" }) }).then((r) => process.exit(r.ok ? 0 : 1))'`,
        'else',
        '  printf "Resumed %s after: %s" "$ORDO_RESUME" "$ORDO_QUESTION" > "$ORDO_SUMMARY_FILE"',
        'fi',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    const file = write(
      'asker.yaml',
      `url: ${url}\nworkspace: ${slug}\nkey: ${keys.Claude}\ncommand: [./ask.sh]\ncheckout: false\n`,
    );
    const first = await ordo(['agent', 'run', '--file', file, '--once']);
    expect(first.stdout).toContain(`${issue.identifier} is waiting for an answer`);
    expect((await runsOf(issue.id))[0]).toMatchObject({ status: 'waiting', resume: 'sess-42' });
    // Nothing to do until someone answers.
    expect((await ordo(['agent', 'run', '--file', file, '--once'])).stdout).not.toContain(
      'claimed',
    );

    await owner.post(`${ws}/issues/${issue.id}/comments`, { body: 'Pink, obviously.' });
    const second = await ordo(['agent', 'run', '--file', file, '--once']);
    expect(second.stdout).toContain(`${issue.identifier} resumed after a reply`);
    expect((await runsOf(issue.id))[0]).toMatchObject({
      status: 'succeeded',
      summary: 'Resumed sess-42 after: Which colour?',
    });
  });

  it('asks from inside a run with ordo agent ask', async () => {
    const issue = await assign('Ask from the CLI');
    const claim = await app.inject({
      method: 'POST',
      url: `${ws}/agent/claim`,
      headers: { authorization: `Bearer ${keys.Claude}` },
    });
    const runId = claim.json().run.id as string;
    const env = { ORDO_URL: url, ORDO_WORKSPACE: slug, ORDO_TOKEN: keys.Claude };
    expect((await ordo(['agent', 'ask', 'Which one?'], env)).code).toBe(2);
    const asked = await ordo(['agent', 'ask', 'Which', 'one?'], { ...env, ORDO_RUN_ID: runId });
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain('Stop working now');
    expect((await runsOf(issue.id))[0]).toMatchObject({
      status: 'waiting',
      question: 'Which one?',
    });
    await owner.patch(`${ws}/issues/${issue.id}`, { assigneeId: null });
  });

  it("says so when Ordo doesn't take the final report", async () => {
    const issue = await assign('Cancelled while running');
    const running = ordo(
      [
        'agent',
        'run',
        '--once',
        '-w',
        slug,
        '--url',
        url,
        '--repos',
        join(dir, 'repos'),
        '--',
        'sh',
        '-c',
        'sleep 1; echo done',
      ],
      { ORDO_AGENT_KEY: keys.Claude },
    );
    // Cancel it in Ordo while the command is still going.
    for (let i = 0; i < 50; i++) {
      const [r] = await runsOf(issue.id);
      if (r && r.status !== 'queued') {
        await owner.post(`${ws}/agent-runs/${r.id}/cancel`);
        break;
      }
      await new Promise((ok) => setTimeout(ok, 50));
    }
    const res = await running;
    expect(res.stdout).toContain(
      `${issue.identifier} finished (succeeded), but Ordo didn't take the report: This run is cancelled`,
    );
    expect(res.stdout).not.toContain(`${issue.identifier} succeeded`);
  });
});
