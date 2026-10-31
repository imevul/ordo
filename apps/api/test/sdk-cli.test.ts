import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { chmod, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Io, run } from '@ordo/cli';
import { NameError, Names, Ordo, OrdoError, parsePriority } from '@ordo/sdk';
import type { Bootstrap } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
    // A file and directory others can already read are locked down on the next write.
    await chmod(file, 0o644);
    await chmod(dirname(file), 0o755);
    expect((await ordo(['login', url, '--token', token])).code).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
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

  it('sets, shows and filters custom fields by name', async () => {
    const add = (body: Record<string, unknown>) => ada.post('/api/w/kit/custom-fields', body);
    await add({
      name: 'Customer tier',
      type: 'select',
      options: [{ name: 'Gold' }, { name: 'Silver' }],
    });
    await add({
      name: 'Areas',
      type: 'multi_select',
      options: [{ name: 'API' }, { name: 'Web' }],
    });
    await add({ name: 'Points', type: 'number' });
    await add({ name: 'Reviewer', type: 'person' });

    const created = await ordo([
      'issue',
      'create',
      'Fielded',
      '--team',
      'ENG',
      '--field',
      'customer tier=gold',
      '--field',
      'Areas=web, api',
      '--field',
      'Points=5',
    ]);
    expect(created.code, created.stderr).toBe(0);
    const id = /Created (ENG-\d+)/.exec(created.stdout)![1]!;
    const edited = await ordo([
      'issue',
      'update',
      id,
      '--field',
      'Reviewer=me',
      '--field',
      'Points=none',
    ]);
    expect(edited.code, edited.stderr).toBe(0);

    const view = await ordo(['issue', 'view', id]);
    expect(view.stdout).toMatch(/Customer tier\s+Gold/);
    expect(view.stdout).toMatch(/Areas\s+API, Web/);
    expect(view.stdout).toMatch(/Reviewer\s+@cli-ada/);
    expect(view.stdout).not.toContain('Points');

    const listed = await ordo(['issues', '--field', 'Customer tier=Gold,Silver']);
    expect(
      listed.stdout
        .trim()
        .split('\n')
        .map((l) => l.split(/\s+/)[0]),
    ).toEqual([id]);
    expect((await ordo(['issues', '--field', 'Customer tier=none'])).stdout).not.toContain(id);

    const option = await ordo(['issue', 'edit', id, '--field', 'Customer tier=Bronze']);
    expect(option.code).toBe(1);
    expect(option.stderr).toContain('No option "Bronze" for Customer tier. Options: Gold, Silver');
    const field = await ordo(['issue', 'edit', id, '--field', 'Severity=High']);
    expect(field.stderr).toContain('No field "Severity" in ENG. Fields: Customer tier, Areas');
    expect((await ordo(['issue', 'edit', id, '--field', 'Gold'])).code).toBe(2);

    // The SDK resolves the same way.
    const me = await new Ordo({ url, token }).me();
    const names = new Names((await ada.get('/api/w/kit/bootstrap')).data, me.id);
    const tier = names.field('customer TIER', names.team('ENG'));
    expect(names.fieldText(tier, names.fieldValue(tier, 'silver')!)).toBe('Silver');
    expect(names.fieldValue(names.field('Points'), ' 2.5 ')).toBe(2.5);
    expect(names.fieldValue(tier, 'none')).toBeNull();
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

/** People to resolve, in the order they joined Kit. */
let grace: Client;
let graceId: string;

async function joinKit(name: string, username: string) {
  const invite = (await ada.post('/api/w/kit/invites', {})).data[0].token;
  const { client } = await signup(app, name, { inviteToken: invite });
  await client.patch('/api/me', { username });
  return { client, id: (await client.get('/api/auth/me')).data.id as string };
}

describe('sdk resources', () => {
  const kit = () => new Ordo({ url, token }).workspace('kit');
  let ops: Bootstrap['teams'][number];

  beforeAll(async () => {
    ({ client: grace, id: graceId } = await joinKit('Grace Hopper', 'cli-grace'));
    // The same full name twice, so a name alone is ambiguous.
    await joinKit('Grace Hopper', 'cli-grace2');
    ops = (await ada.post('/api/w/kit/teams', { name: 'Ops', key: 'OPS' })).data;
    await ada.post('/api/w/kit/labels', { name: 'Infra', color: '#22c55e', teamId: ops.id });
  });

  it('archives, links, trashes and keeps the history of an issue', async () => {
    const ws = kit();
    const issue = await ws.issues.create({ teamId: boot.teams[0]!.id, title: 'Lifecycle' });
    expect(await ws.issues.list({}, { limit: 2 })).toHaveLength(2);

    await ws.issues.update(issue.identifier, { priority: 2 });
    await ws.issues.link(issue.identifier, { url: 'https://example.com/spec', title: 'Spec' });
    await ws.issues.archive(issue.identifier);
    expect((await ws.issues.get(issue.identifier)).archivedAt).toBeTruthy();
    expect((await ws.issues.list({ q: 'Lifecycle' })).map((i) => i.id)).not.toContain(issue.id);
    await ws.issues.unarchive(issue.identifier);
    const detail = await ws.issues.get(issue.identifier);
    expect(detail.archivedAt).toBeNull();
    expect(detail.links).toContainEqual(
      expect.objectContaining({ url: 'https://example.com/spec', title: 'Spec', provider: 'web' }),
    );
    const fields = (await ws.issues.history(issue.identifier)).flatMap((h) =>
      h.changes.map((c) => c.field),
    );
    expect(fields).toEqual(expect.arrayContaining(['priority', 'archived']));

    expect(await ws.issues.trash(issue.identifier)).toEqual({ ok: true });
    expect((await ws.issues.list({ q: 'Lifecycle' })).map((i) => i.id)).not.toContain(issue.id);
    expect((await ws.issues.list({ trashed: true })).map((i) => i.id)).toContain(issue.id);
  });

  it('reads teams, projects, cycles, labels, search, notifications and health', async () => {
    const ws = kit();
    const eng = boot.teams[0]!;
    await ada.post('/api/w/kit/projects', { name: 'Widget launch', teamIds: [eng.id] });
    await ada.post(`/api/w/kit/teams/${eng.id}/cycles`, {
      startsAt: '2030-01-03',
      endsAt: '2030-01-11',
    });
    await ada.post(`/api/w/kit/teams/${eng.id}/cycles`, {
      startsAt: '2030-01-11',
      endsAt: '2030-01-18',
    });
    const widget = await ws.issues.create({ teamId: eng.id, title: 'Widget polish' });

    expect((await ws.teams()).map((t) => t.key).sort()).toEqual(['ENG', 'OPS']);
    expect((await ws.projects()).map((p) => p.name)).toEqual(['Widget launch']);
    expect((await ws.cycles()).map((c) => [c.teamId, c.number])).toEqual(
      expect.arrayContaining([
        [eng.id, 1],
        [eng.id, 2],
      ]),
    );
    expect((await ws.labels()).map((l) => l.name).sort()).toEqual(['Bug', 'Infra']);
    const found = await ws.search('widget');
    expect(found.issues.map((i) => i.id)).toContain(widget.id);
    expect(found.projects.map((p) => p.name)).toEqual(['Widget launch']);

    // Grace hands Ada an issue; Ada's inbox says so.
    const handed = (
      await grace.post('/api/w/kit/issues', {
        teamId: eng.id,
        title: 'Over to you',
        assigneeId: (await new Ordo({ url, token }).me()).id,
      })
    ).data;
    await app.jobs.drain();
    expect(await ws.notifications()).toContainEqual(
      expect.objectContaining({ type: 'issue_assigned', issueId: handed.id }),
    );

    const health = await new Ordo({ url, token }).health();
    expect(health).toMatchObject({ ok: true, version: expect.any(String) });
  });

  it('resolves projects, team-only labels and ambiguous people', async () => {
    const me = await new Ordo({ url, token }).me();
    const names = new Names(await kit().bootstrap(), me.id);
    expect(names.project('widget LAUNCH').name).toBe('Widget launch');
    expect(() => names.project('Nope')).toThrow('No project "Nope". Projects: Widget launch');

    // A team's own label only exists in that team.
    const eng = names.team('ENG');
    expect(names.label('infra', names.team('ops')).name).toBe('Infra');
    expect(names.label('bug', names.team('ops')).name).toBe('Bug');
    expect(() => names.label('Infra', eng)).toThrow('No label "Infra". Labels: Bug');
    expect(() => names.label('Infra')).toThrow(NameError);

    expect(names.member('cli-grace').id).toBe(graceId);
    expect(() => names.member('Grace Hopper')).toThrow(
      '"Grace Hopper" matches @cli-grace, @cli-grace2; use a username',
    );
    expect(() => names.member('nobody@example.com')).toThrow('No member "nobody@example.com"');

    expect(parsePriority(2)).toBe(2);
    expect(parsePriority(' High ')).toBe(2);
    for (const bad of ['5', 'critical', '', -1])
      expect(() => parsePriority(bad)).toThrow(
        /No priority .*Use urgent, high, medium, low or none/,
      );
  });

  it("finds the current and next cycle by the workspace's day, not UTC's", async () => {
    const me = await new Ordo({ url, token }).me();
    expect(
      (await ada.patch('/api/w/kit', { settings: { timezone: 'Pacific/Kiritimati' } })).statusCode,
    ).toBe(200);
    const boot = await kit().bootstrap();
    await ada.patch('/api/w/kit', { settings: { timezone: null } });
    expect(boot.workspace.settings.timezone).toBe('Pacific/Kiritimati');
    const utc = {
      ...boot,
      workspace: { ...boot.workspace, settings: { ...boot.workspace.settings, timezone: null } },
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 20:00 UTC on 10 January is already 10:00 on the 11th at UTC+14, when cycle 2 begins.
      vi.setSystemTime(new Date('2030-01-10T20:00:00Z'));
      const inZone = new Names(boot, me.id);
      const eng = inZone.team('ENG');
      expect(inZone.cycle(eng, 'current').number).toBe(2);
      expect(() => inZone.cycle(eng, 'next')).toThrow('No next cycle in ENG');
      const inUtc = new Names(utc, me.id);
      expect(inUtc.cycle(eng, 'current').number).toBe(1);
      expect(inUtc.cycle(eng, 'next').number).toBe(2);
      expect(inUtc.cycle(eng, '#2').number).toBe(2);
      expect(() => inUtc.cycle(inUtc.team('OPS'), 'current')).toThrow('No current cycle in OPS');
      expect(() => inUtc.cycle(eng, '9')).toThrow('No "9" cycle in ENG');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cli, more', () => {
  const issueOf = async (identifier: string) =>
    (await ada.get(`/api/w/kit/issues/${identifier}`)).data;
  const fresh = () => mkdtempSync(join(tmpdir(), 'ordo-cli-'));
  const create = async (title: string) =>
    (await ada.post('/api/w/kit/issues', { teamId: boot.teams[0]!.id, title })).data as {
      id: string;
      identifier: string;
    };

  it('signs out by deleting the saved login', async () => {
    const env = { XDG_CONFIG_HOME: fresh() };
    expect((await ordo(['login', url, '--token', token], { env })).code).toBe(0);
    const file = join(env.XDG_CONFIG_HOME, 'ordo', 'config.json');
    expect(existsSync(file)).toBe(true);
    const out = await ordo(['logout'], { env });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Signed out');
    expect(existsSync(file)).toBe(false);
    const after = await ordo(['whoami'], { env });
    expect(after.code).toBe(1);
    expect(after.stderr).toContain('not signed in; run "ordo login" first');
    // Signing out twice is fine.
    expect((await ordo(['logout'], { env })).code).toBe(0);
  });

  it('lists workspaces and switches the default with use', async () => {
    await ada.post('/api/workspaces', { name: 'Kit Two', slug: 'kit2', teamKey: 'TWO' });
    const file = join(configDir, 'ordo', 'config.json');
    const listed = await ordo(['workspaces']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/^\*\s+kit\s+owner\s+Kit$/m);
    expect(listed.stdout).toMatch(/^\s+kit2\s+owner\s+Kit Two$/m);
    try {
      const used = await ordo(['use', 'kit2']);
      expect(used.code, used.stderr).toBe(0);
      expect(used.stdout).toBe('Using kit2.\n');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ url, token, workspace: 'kit2' });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await ordo(['workspaces'])).stdout).toMatch(/^\*\s+kit2\s/m);
      expect((await ordo(['teams'])).stdout).toContain('TWO');
      const refused = await ordo(['use', 'nope']);
      expect(refused.stderr).toContain('You\'re not in a workspace "nope". Yours: kit, kit2');
      expect(JSON.parse(await readFile(file, 'utf8')).workspace).toBe('kit2');
    } finally {
      await ordo(['use', 'kit']);
    }
    expect(JSON.parse(await readFile(file, 'utf8')).workspace).toBe('kit');
  });

  it('picks the only workspace by itself, and asks when there are several', async () => {
    const solo = (await signup(app, 'Solo Sam')).client;
    await solo.post('/api/workspaces', { name: 'Solo', slug: 'solo', teamKey: 'SOL' });
    const key = (await solo.post('/api/me/api-keys', { name: 'cli' })).data.token;
    const env = { XDG_CONFIG_HOME: fresh(), ORDO_URL: url, ORDO_TOKEN: key };
    const one = await ordo(['issue', 'create', 'Alone here'], { env });
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout).toContain(`${url}/solo/issue/SOL-1`);
    expect((await solo.get('/api/w/solo/issues/SOL-1')).data.title).toBe('Alone here');

    await solo.post('/api/workspaces', { name: 'Duo', slug: 'duo', teamKey: 'DUO' });
    const several = await ordo(['teams'], { env });
    expect(several.code).toBe(2);
    expect(several.stderr).toContain('which workspace? Pass -w <slug>');
    expect((await ordo(['teams', '-w', 'duo'], { env })).stdout).toContain('DUO');
    expect((await ordo(['teams'], { env: { ...env, ORDO_WORKSPACE: 'solo' } })).stdout).toContain(
      'SOL',
    );
  });

  it('lists teams with their statuses', async () => {
    const res = await ordo(['teams']);
    expect(res.code, res.stderr).toBe(0);
    const eng = res.stdout.split('\n').find((l) => l.startsWith('ENG'))!;
    expect(eng).toMatch(/^ENG\s+Eng\s+/);
    expect(eng).toContain('Todo → In Progress');
    expect(res.stdout).toMatch(/^OPS\s+Ops\s+/m);
    const json = JSON.parse((await ordo(['teams', '--json'])).stdout);
    expect(json.map((t: { key: string }) => t.key).sort()).toEqual(['ENG', 'OPS']);
  });

  it('searches issues and projects', async () => {
    const res = await ordo(['search', 'widget']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/ENG-\d+\s+\S.*Widget polish/);
    expect(res.stdout).toContain('Projects\n  Widget launch');
    expect((await ordo(['search', 'zzqxv'])).stdout).toBe('Nothing found.\n');
    expect((await ordo(['search'])).code).toBe(2);
  });

  it('prints the branch name and cancels with close --canceled', async () => {
    const branch = await ordo(['issue', 'branch', 'ENG-5']);
    expect(branch.code, branch.stderr).toBe(0);
    expect(branch.stdout).toBe('cli-ada/eng-5-cli-issue\n');
    expect(JSON.parse((await ordo(['issue', 'branch', 'eng-5', '--json'])).stdout)).toEqual({
      branch: 'cli-ada/eng-5-cli-issue',
    });

    const issue = await create('Not doing this');
    const closed = await ordo(['issue', 'close', issue.identifier, '--canceled']);
    expect(closed.code, closed.stderr).toBe(0);
    expect(closed.stdout).toBe(`${issue.identifier} → Canceled\n`);
    const after = await issueOf(issue.identifier);
    expect(after.canceledAt).toBeTruthy();
    expect(after.completedAt).toBeNull();
    expect(boot.teams[0]!.states.find((st) => st.id === after.stateId)?.type).toBe('canceled');
  });

  it('edits every field by name, and clears them with none', async () => {
    const parent = await create('Parent epic');
    const issue = await create('Edit me');
    const dir = mkdtempSync(join(tmpdir(), 'ordo-edit-'));
    writeFileSync(join(dir, 'desc.md'), '# From a file\n\nWith *Markdown*.\n');
    const edited = await ordo([
      'issue',
      'edit',
      issue.identifier,
      '--assignee',
      'cli-grace',
      '--project',
      'widget launch',
      '--cycle',
      '2',
      '--parent',
      parent.identifier.toLowerCase(),
      '--estimate',
      '3',
      '--due',
      '2031-02-03',
      '--add-label',
      'bug',
      '--description-file',
      join(dir, 'desc.md'),
    ]);
    expect(edited.code, edited.stderr).toBe(0);
    expect(edited.stdout).toBe(`Updated ${issue.identifier}\n`);
    const kitBoot = (await ada.get('/api/w/kit/bootstrap')).data as Bootstrap;
    const bug = kitBoot.labels.find((l) => l.name === 'Bug')!.id;
    const cycle2 = kitBoot.cycles.find((c) => c.teamId === boot.teams[0]!.id && c.number === 2)!;
    expect(await issueOf(issue.identifier)).toMatchObject({
      assigneeId: graceId,
      projectId: kitBoot.projects.find((p) => p.name === 'Widget launch')!.id,
      cycleId: cycle2.id,
      parentId: parent.id,
      estimate: 3,
      dueDate: '2031-02-03',
      labelIds: [bug],
      description: '# From a file\n\nWith *Markdown*.\n',
    });

    const cleared = await ordo([
      'issue',
      'edit',
      issue.identifier,
      '--project',
      'none',
      '--cycle',
      'none',
      '--parent',
      'none',
      '--estimate',
      'none',
      '--due',
      'none',
      '--remove-label',
      'Bug',
      '--unassign',
    ]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(await issueOf(issue.identifier)).toMatchObject({
      assigneeId: null,
      projectId: null,
      cycleId: null,
      parentId: null,
      estimate: null,
      dueDate: null,
      labelIds: [],
    });

    await ordo(['issue', 'edit', issue.identifier, '--assignee', 'me']);
    expect((await issueOf(issue.identifier)).assigneeId).toBe(
      (await new Ordo({ url, token }).me()).id,
    );
    await ordo(['issue', 'edit', issue.identifier, '--assignee', 'none']);
    expect((await issueOf(issue.identifier)).assigneeId).toBeNull();

    // Bad values are refused before anything changes.
    const bad = await ordo(['issue', 'edit', issue.identifier, '--estimate', 'lots']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--estimate takes a number');
    // The test cycles are in 2030: none is current today.
    const noCycle = await ordo(['issue', 'edit', issue.identifier, '--cycle', 'current']);
    expect(noCycle.code).toBe(1);
    expect(noCycle.stderr).toContain('No current cycle in ENG');
    expect((await issueOf(issue.identifier)).cycleId).toBeNull();
    expect((await ordo(['issue', 'edit', issue.identifier])).code).toBe(2);
  });

  it('comments from a file', async () => {
    const issue = await create('File comment');
    const dir = mkdtempSync(join(tmpdir(), 'ordo-comment-'));
    writeFileSync(join(dir, 'body.md'), 'Line one\n\nLine two\n');
    const res = await ordo([
      'issue',
      'comment',
      issue.identifier,
      '--body-file',
      join(dir, 'body.md'),
    ]);
    expect(res.code, res.stderr).toBe(0);
    const comments = (await ada.get(`/api/w/kit/issues/${issue.id}/comments`)).data;
    expect(comments.map((c: { body: string }) => c.body)).toEqual(['Line one\n\nLine two']);
    expect(
      (await ordo(['issue', 'comment', issue.identifier, '-F', join(dir, 'nope.md')])).code,
    ).toBe(1);
  });

  it('sends a JSON body from a file with api --data @file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordo-api-'));
    writeFileSync(
      join(dir, 'issue.json'),
      JSON.stringify({ teamId: boot.teams[0]!.id, title: 'Made with api', priority: 4 }),
    );
    const res = await ordo([
      'api',
      'post',
      'api/w/kit/issues',
      '--data',
      `@${join(dir, 'issue.json')}`,
    ]);
    expect(res.code, res.stderr).toBe(0);
    const made = JSON.parse(res.stdout);
    expect(await issueOf(made.identifier)).toMatchObject({ title: 'Made with api', priority: 4 });

    writeFileSync(join(dir, 'bad.json'), '{nope');
    const bad = await ordo(['api', 'POST', '/w/kit/issues', '--data', `@${join(dir, 'bad.json')}`]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--data must be JSON');
  });
});
