import type { Bootstrap } from '@ordo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthUser, authorizeWorkspace } from '../src/lib/auth.ts';
import { buildGraphqlSchema, queryDepth, runGraphql } from '../src/services/graphql/index.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let key: string;
let boot: Bootstrap;
const ws = '/api/w/gql';

/** One GraphQL request; with `token` it authenticates by API key, else by `who`'s session. */
async function gql(
  query: string,
  variables?: Record<string, unknown>,
  opts: { who?: Client; token?: string } = {},
) {
  if (opts.who) {
    const res = await opts.who.post(`${ws}/graphql`, { query, variables });
    return res;
  }
  const res = await app.inject({
    method: 'POST',
    url: `${ws}/graphql`,
    headers: { authorization: `Bearer ${opts.token ?? key}`, 'content-type': 'application/json' },
    payload: { query, variables },
  });
  return Object.assign(res, { data: res.json() });
}

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Grace Hopper')).client;
  await owner.patch('/api/me', { username: 'gql-grace' });
  await owner.post('/api/workspaces', {
    name: 'GQL',
    slug: 'gql',
    teamName: 'Core',
    teamKey: 'COR',
  });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mel Member', { inviteToken: invite })).client;
  // A private team the member isn't in.
  await owner.post(`${ws}/teams`, { name: 'Secret', key: 'SEC', private: true });
  await owner.post(`${ws}/labels`, { name: 'Bug', color: '#ef4444' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  key = (await owner.post('/api/me/api-keys', { name: 'gql' })).data.token;
  const core = boot.teams.find((t) => t.key === 'COR')!;
  const sec = boot.teams.find((t) => t.key === 'SEC')!;
  const parent = (await owner.post(`${ws}/issues`, { teamId: core.id, title: 'Parent issue' }))
    .data;
  await owner.post(`${ws}/issues`, {
    teamId: core.id,
    title: 'Child issue',
    parentId: parent.id,
    priority: 1,
    labelIds: [boot.labels[0]!.id],
  });
  await owner.post(`${ws}/issues`, { teamId: sec.id, title: 'Secret issue' });
  await owner.post(`${ws}/issues/COR-1/comments`, { body: 'First comment' });
});

afterAll(() => app.close());

describe('queries', () => {
  it('reads issues with their relations', async () => {
    const res = await gql(`{
      viewer { username }
      workspace { slug url }
      issue(id: "COR-2") {
        identifier title priority priorityLabel url branchName
        team { key states { name type } }
        state { name type }
        creator { username }
        labels { name }
        parent { identifier comments { body author { username } } }
      }
    }`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data.errors).toBeUndefined();
    const { viewer, workspace, issue } = res.data.data;
    expect(viewer.username).toBe('gql-grace');
    expect(workspace.url).toBe(`${app.env.publicUrl}/gql`);
    expect(issue).toMatchObject({
      identifier: 'COR-2',
      priority: 1,
      priorityLabel: 'Urgent',
      url: `${app.env.publicUrl}/gql/issue/COR-2`,
      branchName: 'gql-grace/cor-2-child-issue',
      team: { key: 'COR' },
      creator: { username: 'gql-grace' },
      labels: [{ name: 'Bug' }],
      parent: {
        identifier: 'COR-1',
        comments: [{ body: 'First comment', author: { username: 'gql-grace' } }],
      },
    });
    expect(issue.team.states[0].type).toBe('triage');
  });

  it('pages issue connections with cursors', async () => {
    const page = `query($after: String) {
      issues(first: 2, after: $after) { nodes { identifier } pageInfo { hasNextPage endCursor } }
    }`;
    const one = (await gql(page)).data.data.issues;
    expect(one.nodes).toHaveLength(2);
    expect(one.pageInfo.hasNextPage).toBe(true);
    const two = (await gql(page, { after: one.pageInfo.endCursor })).data.data.issues;
    expect(two.nodes).toHaveLength(1);
    expect(two.pageInfo.hasNextPage).toBe(false);
    const all = [...one.nodes, ...two.nodes].map((n: { identifier: string }) => n.identifier);
    expect(all.sort()).toEqual(['COR-1', 'COR-2', 'SEC-1']);
  });

  it('filters like the REST API', async () => {
    const res = await gql(`{
      urgent: issues(filter: { priorities: [1] }) { nodes { identifier } }
      byText: issues(filter: { query: "child" }) { nodes { identifier } }
      team(key: "cor") { issues(filter: { stateTypes: [triage, backlog, unstarted] }) { nodes { identifier } } }
    }`);
    expect(res.data.errors).toBeUndefined();
    expect(res.data.data.urgent.nodes).toEqual([{ identifier: 'COR-2' }]);
    expect(res.data.data.byText.nodes).toEqual([{ identifier: 'COR-2' }]);
    expect(res.data.data.team.issues.nodes).toHaveLength(2);
  });

  it("answers from the caller's point of view", async () => {
    const res = await gql(
      `{ teams { key } issue(id: "SEC-1") { title } issues { nodes { identifier } } }`,
      undefined,
      { who: member },
    );
    expect(res.data.data.teams.map((t: { key: string }) => t.key)).toEqual(['COR']);
    expect(res.data.data.issue).toBeNull();
    expect(
      res.data.data.issues.nodes.map((n: { identifier: string }) => n.identifier).sort(),
    ).toEqual(['COR-1', 'COR-2']);
  });
});

describe('mutations', () => {
  it('creates, updates, comments, archives and trashes through the services', async () => {
    const core = boot.teams.find((t) => t.key === 'COR')!;
    const created = await gql(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { identifier title } }`,
      { input: { teamId: core.id, title: 'Made in GraphQL', priority: 2 } },
    );
    expect(created.data.errors, created.body).toBeUndefined();
    const id = created.data.data.issueCreate.identifier;
    expect(id).toBe('COR-3');

    const done = core.states.find((s) => s.type === 'completed')!;
    const updated = await gql(
      `mutation($id: ID!, $state: ID!) {
        issueUpdate(id: $id, input: { stateId: $state, assigneeId: null, estimate: 3 }) { state { type } estimate completedAt }
        commentCreate(issueId: $id, body: "Shipped") { body author { username } }
      }`,
      { id, state: done.id },
    );
    expect(updated.data.errors, updated.body).toBeUndefined();
    expect(updated.data.data.issueUpdate).toMatchObject({
      state: { type: 'completed' },
      estimate: 3,
    });
    expect(updated.data.data.issueUpdate.completedAt).toBeTruthy();
    expect(updated.data.data.commentCreate.author.username).toBe('gql-grace');

    // Changes made with an API key are attributed to the API, like REST.
    const history = (await owner.get(`${ws}/issues/${id}/history`)).data;
    expect(history.length).toBeGreaterThan(0);

    const archived = await gql(`mutation { issueArchive(id: "${id}") { archivedAt } }`);
    expect(archived.data.data.issueArchive.archivedAt).toBeTruthy();
    expect((await gql(`mutation { issueTrash(id: "${id}") }`)).data.data.issueTrash).toBe(true);
    expect(
      (await gql(`{ issue(id: "${id}") { trashedAt } }`)).data.data.issue.trashedAt,
    ).toBeTruthy();
  });

  it('reports invalid input and missing issues with codes', async () => {
    const bad = await gql(`mutation { issueUpdate(id: "COR-1", input: { title: "" }) { id } }`);
    expect(bad.statusCode).toBe(200);
    expect(bad.data.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    const missing = await gql(
      `mutation { issueUpdate(id: "COR-99", input: { title: "x" }) { id } }`,
    );
    expect(missing.data.errors[0].extensions.code).toBe('NOT_FOUND');
    // A member can't touch a private team's issue: it doesn't exist for them.
    const hidden = await gql(`mutation { issueTrash(id: "SEC-1") }`, undefined, { who: member });
    expect(hidden.data.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

describe('protocol', () => {
  it('refuses requests without credentials, in GraphQL form', async () => {
    const res = await gql('{ viewer { id } }', undefined, { token: 'ordo_nope' });
    expect(res.statusCode).toBe(401);
    expect(res.data.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('answers syntax and validation errors with 400', async () => {
    expect((await gql('{ viewer { ')).statusCode).toBe(400);
    const invalid = await gql('{ viewer { nope } }');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.data.errors[0].message).toContain('nope');
  });

  it('limits depth, not counting introspection', async () => {
    const deep = `{ issue(id: "COR-2") { ${'parent { '.repeat(9)}id${' }'.repeat(9)} } }`;
    expect(queryDepth(parse(deep))).toBe(11);
    const res = await gql(deep);
    expect(res.statusCode).toBe(400);
    expect(res.data.errors[0].extensions.code).toBe('QUERY_TOO_DEEP');
    const introspection = await gql(
      `{ __schema { types { name fields { type { ofType { ofType { ofType { name } } } } } } } }`,
    );
    expect(introspection.statusCode).toBe(200);
    expect(introspection.data.data.__schema.types.length).toBeGreaterThan(10);
  });

  it('caps how much one request loads', async () => {
    // first is capped at 250 per page.
    const res = await gql('{ issues(first: 100000) { nodes { id } } }');
    expect(res.data.data.issues.nodes).toHaveLength(3);
    // Thousands of aliases run into the token limit before they run.
    const wide = `{ ${Array.from({ length: 3000 }, (_, i) => `a${i}: viewer { id }`).join(' ')} }`;
    expect((await gql(wide)).statusCode).toBe(400);
    // And every issue and comment loaded counts against a budget.
    const me = (await owner.get('/api/auth/me')).data;
    const user = { ...me, avatarFileId: null, isInstanceAdmin: false } as AuthUser;
    const wsCtx = await authorizeWorkspace(app.db, user, 'gql', { method: 'session', sso: null });
    const out = await runGraphql(
      buildGraphqlSchema(),
      { query: '{ a: issues { nodes { id } } b: issues { nodes { id } } }' },
      { app, req: {} as FastifyRequest, access: wsCtx.access, ws: wsCtx, user },
      { budget: 4 },
    );
    expect(out.body.errors?.[0]?.extensions.code).toBe('QUERY_TOO_LARGE');
  });

  it('only takes POST', async () => {
    const res = await app.inject({
      url: `${ws}/graphql`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(405);
  });
});
