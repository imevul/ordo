import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Io, run } from '@ordo/cli';
import { NameError, Names, Ordo, OrdoError, parsePriority } from '@ordo/sdk';
import type { Bootstrap } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let ada: Client;
let url: string;
let token: string;
let boot: Bootstrap;

/** Runs `ordo …` in-process with its own config directory; returns exit code and output. */
async function ordo(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  let stdout = '';
  let stderr = '';
  const opened: string[] = [];
  const io: Io = {
    env: { XDG_CONFIG_HOME: configDir, ...opts.env },
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    readStdin: async () => opts.stdin ?? '',
    prompt: async () => '',
    openUrl: (u) => opened.push(u),
    color: false,
    width: 120,
  };
  const code = await run(args, io);
  return { code, stdout, stderr, opened };
}

let configDir: string;

beforeAll(async () => {
  app = await testApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  url = `http://127.0.0.1:${address.port}`;
  ada = (await signup(app, 'Ada Lovelace')).client;
  await ada.patch('/api/me', { username: 'cli-ada' });
  await ada.post('/api/workspaces', { name: 'Kit', slug: 'kit', teamName: 'Eng', teamKey: 'ENG' });
  await ada.post('/api/w/kit/labels', { name: 'Bug', color: '#ef4444' });
  token = (await ada.post('/api/me/api-keys', { name: 'cli' })).data.token;
  boot = (await ada.get('/api/w/kit/bootstrap')).data;
  configDir = mkdtempSync(join(tmpdir(), 'ordo-cli-'));
});

afterAll(() => app.close());

describe('sdk', () => {
  it('reads and writes issues as the key owner', async () => {
    const kit = new Ordo({ url: `${url}/`, token }).workspace('kit');
    const created = await kit.issues.create({ teamId: boot.teams[0]!.id, title: 'From the SDK' });
    expect(created.identifier).toBe('ENG-1');
    await kit.issues.update('ENG-1', { priority: 1 });
    await kit.issues.comment('ENG-1', { body: 'Hello' });
    const detail = await kit.issues.get('ENG-1');
    expect(detail.priority).toBe(1);
    expect((await kit.issues.comments('ENG-1')).map((c) => c.body)).toEqual(['Hello']);
  });

  it('pages through every issue', async () => {
    const kit = new Ordo({ url, token }).workspace('kit');
    for (const n of [2, 3, 4])
      await kit.issues.create({ teamId: boot.teams[0]!.id, title: `Paged ${n}` });
    const seen: string[] = [];
    for await (const issue of kit.issues.all({}, { pageSize: 2 })) seen.push(issue.identifier);
    expect(seen.sort()).toEqual(['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4']);
  });

  it('throws OrdoError with the status and code', async () => {
    const bad = new Ordo({ url, token: 'ordo_nope' });
    await expect(bad.me()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    const err = await new Ordo({ url, token })
      .workspace('kit')
      .issues.get('ENG-999')
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrdoError);
    expect(err.status).toBe(404);
  });

  it('runs GraphQL, with errors as OrdoError', async () => {
    const kit = new Ordo({ url, token }).workspace('kit');
    const data = await kit.graphql<{ issue: { title: string } }>(
      'query($id: ID!) { issue(id: $id) { title } }',
      { id: 'ENG-1' },
    );
    expect(data.issue.title).toBe('From the SDK');
    await expect(kit.graphql('{ nope }')).rejects.toMatchObject({ status: 400 });
    await expect(
      kit.graphql('mutation { issueUpdate(id: "ENG-999", input: { title: "x" }) { id } }'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resolves names', async () => {
    const me = await new Ordo({ url, token }).me();
    const names = new Names(boot, me.id);
    const team = names.team('eng');
    expect(names.state(team, 'started').type).toBe('started');
    expect(names.state(team, 'in progress').name).toBe('In Progress');
    expect(names.member('@cli-ada').id).toBe(me.id);
    expect(names.member('me').id).toBe(me.id);
    expect(names.label('bug', team).name).toBe('Bug');
    expect(parsePriority('urgent')).toBe(1);
    expect(parsePriority('none')).toBe(0);
    expect(() => names.team('XYZ')).toThrow(NameError);
    expect(() => names.state(team, 'Nope')).toThrow(/Statuses: Triage/);
  });
});

describe('cli', () => {
  it('logs in and keeps the key private', async () => {
    const res = await ordo(['login', url, '--token', token]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('as Ada Lovelace (@cli-ada). Workspace: kit.');
    const file = join(configDir, 'ordo', 'config.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ url, token, workspace: 'kit' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await ordo(['whoami'])).stdout).toContain('Ada Lovelace (@cli-ada)');
  });

  it("prints a command's own usage for --help", async () => {
    const global = await ordo(['--help']);
    expect(global.stdout).toContain('Usage: ordo <command>');

    const create = await ordo(['issue', 'create', '--help']);
    expect(create.code).toBe(0);
    expect(create.stdout).toContain('Usage: ordo issue create');
    expect(create.stdout).toContain('--description-file');
    expect(create.stdout).not.toContain('Usage: ordo <command>');
    // Aliases, -h, `ordo help …`, and help that comes after other arguments.
    expect((await ordo(['issue', 'ls', '-h'])).stdout).toContain('Usage: ordo issue list');
    expect((await ordo(['issues', '--help'])).stdout).toContain('Usage: ordo issue list');
    expect((await ordo(['help', 'issue', 'comment'])).stdout).toContain(
      'Usage: ordo issue comment',
    );
    expect((await ordo(['issue', 'view', 'ENG-1', '--help'])).stdout).toContain(
      'Usage: ordo issue view',
    );
    expect((await ordo(['issue', '--help'])).stdout).toContain('Usage: ordo issue <command>');
    expect((await ordo(['agent', 'run', '--help'])).stdout).toContain('--concurrency');

    // After `--`, --help belongs to the agent's command, not to ordo.
    const passed = await ordo(['agent', 'run', '--', 'claude', '--help'], {
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'ordo-cli-')) },
    });
    expect(passed.stdout).not.toContain('Usage:');
    expect(passed.stderr).toContain("agent's key");

    const unknown = await ordo(['issue', 'nope', '--help']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown issue command "nope"');
    expect((await ordo(['help', 'nope'])).code).toBe(2);
  });

  it('refuses a wrong key at login', async () => {
    const res = await ordo(['login', url, '--token', 'ordo_wrong'], {
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'ordo-cli-')) },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('ordo login');
  });

  it('creates, edits, comments, starts and closes an issue by name', async () => {
    const created = await ordo([
      'issue',
      'create',
      'CLI issue',
      '--team',
      'eng',
      '--priority',
      'high',
      '--label',
      'bug',
      '-d',
      'Body text',
    ]);
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toContain(`Created ENG-5 ${url}/kit/issue/ENG-5`);

    expect(
      (await ordo(['issue', 'edit', 'ENG-5', '--status', 'Todo', '--due', '2030-01-31'])).code,
    ).toBe(0);
    const comment = await ordo(['issue', 'comment', 'ENG-5', '-'], { stdin: 'From stdin' });
    expect(comment.code, comment.stderr).toBe(0);

    const started = await ordo(['issue', 'start', 'ENG-5']);
    expect(started.stdout).toContain('ENG-5 → In Progress');
    expect(started.stdout).toContain('Branch: cli-ada/eng-5-cli-issue');

    const view = await ordo(['issue', 'view', 'eng-5', '--comments']);
    expect(view.stdout).toMatch(/Status\s+In Progress/);
    expect(view.stdout).toMatch(/Assignee\s+@cli-ada/);
    expect(view.stdout).toMatch(/Labels\s+Bug/);
    expect(view.stdout).toMatch(/Due\s+2030-01-31/);
    expect(view.stdout).toContain('From stdin');

    expect((await ordo(['issue', 'close', 'ENG-5'])).stdout).toContain('ENG-5 → Done');
    const json = JSON.parse((await ordo(['issue', 'view', 'ENG-5', '--json'])).stdout);
    expect(json.completedAt).toBeTruthy();
  });

  it('attaches files to an issue and its comments, also as an agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordo-attach-'));
    // 1×1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(join(dir, 'shot.png'), png);
    writeFileSync(join(dir, 'notes.txt'), 'plain text');
    const issue = (
      await ada.post('/api/w/kit/issues', { teamId: boot.teams[0]!.id, title: 'Screenshots' })
    ).data;

    const attached = await ordo([
      'issue',
      'attach',
      issue.identifier,
      join(dir, 'shot.png'),
      join(dir, 'notes.txt'),
    ]);
    expect(attached.code, attached.stderr).toBe(0);
    const [image, link] = attached.stdout.trim().split('\n');
    expect(image).toMatch(/^!\[shot\.png\]\(\/api\/attachments\/[0-9a-f-]{36}\)$/);
    expect(link).toMatch(/^\[notes\.txt\]\(\/api\/attachments\/[0-9a-f-]{36}\)$/);

    // An agent's key, the way a runner's command uses it.
    const agent = (
      await ada.post('/api/w/kit/agents', { name: 'Shooter', teamIds: [boot.teams[0]!.id] })
    ).data;
    const key = (await ada.post(`/api/w/kit/agents/${agent.id}/keys`, { name: 'run' })).data.token;
    const commented = await ordo(
      ['issue', 'comment', issue.identifier, 'Checked at 375px', '--attach', join(dir, 'shot.png')],
      { env: { ORDO_URL: url, ORDO_TOKEN: key, ORDO_WORKSPACE: 'kit' } },
    );
    expect(commented.code, commented.stderr).toBe(0);
    const [comment] = (await ada.get(`/api/w/kit/issues/${issue.id}/comments`)).data;
    expect(comment.body).toMatch(
      /^Checked at 375px\n\n!\[shot\.png\]\(\/api\/attachments\/[0-9a-f-]{36}\)$/,
    );

    const detail = (await ada.get(`/api/w/kit/issues/${issue.id}`)).data;
    expect(detail.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      'shot.png',
      'notes.txt',
      'shot.png',
    ]);
    const shown = /\((\/api\/attachments\/[^)]+)\)/.exec(comment.body)![1]!;
    const file = await ada.get(shown);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');

    const missing = await ordo([
      'issue',
      'comment',
      issue.identifier,
      'x',
      '-A',
      join(dir, 'nope.png'),
    ]);
    expect(missing.code).toBe(1);
    expect((await ada.get(`/api/w/kit/issues/${issue.id}/comments`)).data).toHaveLength(1);
  });

  it('lists open issues with filters, most urgent first', async () => {
    const all = await ordo(['issues']);
    expect(all.code, all.stderr).toBe(0);
    const ids = all.stdout
      .trim()
      .split('\n')
      .map((l) => l.split(/\s+/)[0]);
    // ENG-1 is urgent; ENG-5 is done, so it isn't listed.
    expect(ids[0]).toBe('ENG-1');
    expect(ids).not.toContain('ENG-5');
    expect((await ordo(['issues', '--all'])).stdout).toContain('ENG-5');
    expect(
      (await ordo(['issues', '--status', 'completed'])).stdout.trim().split('\n'),
    ).toHaveLength(1);
    expect((await ordo(['issues', '--mine'])).stdout).toBe('No issues.\n');
    expect(
      (await ordo(['issues', '-q', 'Paged', '-n', '2'])).stdout.trim().split('\n'),
    ).toHaveLength(2);
  });

  it('explains names that match nothing, and bad usage', async () => {
    const team = await ordo(['issues', '--team', 'nope']);
    expect(team.code).toBe(1);
    expect(team.stderr).toContain('No team "nope". Teams: ENG');
    const usage = await ordo(['issue', 'frobnicate']);
    expect(usage.code).toBe(2);
    expect((await ordo(['issues', '--bogus'])).code).toBe(2);
  });

  it('switches workspaces and takes the environment over the saved login', async () => {
    expect((await ordo(['use', 'missing'])).code).toBe(1);
    const res = await ordo(['whoami'], { env: { ORDO_TOKEN: 'ordo_bad' } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('ORDO_TOKEN');
  });

  it('calls any endpoint with api', async () => {
    const res = await ordo([
      'api',
      'POST',
      '/w/kit/issues/query',
      '--data',
      '{"filter":{"q":"ENG-2"}}',
    ]);
    expect(JSON.parse(res.stdout)[0].identifier).toBe('ENG-2');
    const web = await ordo(['issue', 'view', 'ENG-2', '--web']);
    expect(web.opened).toEqual([`${url}/kit/issue/ENG-2`]);
  });
});
