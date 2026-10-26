import {
  guessStateType,
  type ImportSummary,
  PROJECT_STATUSES,
  type ProjectStatus,
  STATE_TYPES,
  type StateType,
} from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiCallError, callApi } from '../../integrations/http.ts';
import {
  ImportAbort,
  type ImportAdapter,
  ImportRetryLater,
  type SourceContext,
  type SourceIssue,
} from './types.ts';

/**
 * Linear, read through its GraphQL API with a personal API key. Teams keep their keys and issue
 * numbers; labels with the same name (Linear has them per team) become one; label groups are left
 * out. Archived issues aren't imported.
 */

// Overridable for tests (a mock Linear) and nothing else.
const apiUrl = () => process.env.ORDO_LINEAR_API_URL ?? 'https://api.linear.app/graphql';
const PAGE_SIZE = 100;

export const linearSecretsAad = (importId: string) => `imports:${importId}:secrets`;

interface GqlError {
  message: string;
  extensions?: { code?: string; type?: string };
}

const isAuthError = (text: string) => /authenticat|unauthori[sz]ed|forbidden/i.test(text);
const isRateLimit = (text: string) => /rate ?limit/i.test(text);

/** One GraphQL request. Auth problems end the import; rate limits pause it. */
export async function linearQuery<T>(
  app: FastifyInstance,
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let res: { data?: T; errors?: GqlError[] };
  try {
    ({ data: res } = await callApi(app, apiUrl(), {
      method: 'POST',
      headers: { authorization: apiKey },
      body: { query, variables },
      timeoutMs: 30_000,
    }));
  } catch (err) {
    if (err instanceof ApiCallError) {
      if (err.status === 429 || isRateLimit(err.message)) throw rateLimited();
      if (err.status === 401 || err.status === 403 || isAuthError(err.message)) throw badKey();
    }
    throw err;
  }
  const error = res?.errors?.[0];
  if (error) {
    const code = `${error.extensions?.code ?? ''} ${error.message}`;
    if (isRateLimit(code)) throw rateLimited();
    if (isAuthError(code)) throw badKey();
    throw new Error(`Linear: ${error.message}`);
  }
  return res.data as T;
}

const badKey = () => new ImportAbort('Linear refused the API key: check it and start a new import');
const rateLimited = () =>
  new ImportRetryLater(
    "Waiting for Linear's rate limit; the import carries on by itself",
    new Date(Date.now() + 10 * 60_000),
  );

function apiKey(sctx: SourceContext) {
  const { row, app } = sctx;
  if (!row.secrets) throw new ImportAbort('The import has no Linear API key');
  return (
    JSON.parse(app.keyring.decrypt(row.secrets, linearSecretsAad(row.id))) as { apiKey: string }
  ).apiKey;
}

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function page<T>(
  sctx: SourceContext,
  query: string,
  field: string,
  after: string | null,
): Promise<{ items: T[]; next: string | null }> {
  const data = await linearQuery<Record<string, Connection<T>>>(sctx.app, apiKey(sctx), query, {
    first: PAGE_SIZE,
    after,
  });
  const conn = data[field]!;
  return {
    items: conn.nodes,
    next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
  };
}

async function all<T>(sctx: SourceContext, query: string, field: string) {
  const out: T[] = [];
  let after: string | null = null;
  do {
    const p: { items: T[]; next: string | null } = await page<T>(sctx, query, field, after);
    out.push(...p.items);
    after = p.next;
  } while (after);
  return out;
}

const conn = (fields: string) => `nodes { ${fields} } pageInfo { hasNextPage endCursor }`;
const list = (field: string, fields: string, args = '') =>
  `query List($first: Int, $after: String) { ${field}(first: $first, after: $after${args}) { ${conn(fields)} } }`;

export const ORGANIZATION = 'query Organization { organization { id name urlKey } }';
const TEAMS = list(
  'teams',
  'id name key issueCount states(first: 100) { nodes { id name type position } }',
);
const USERS = list('users', 'id name displayName email');
const LABELS = list('issueLabels', 'id name isGroup');
const PROJECTS = list(
  'projects',
  'id name description state startDate targetDate lead { id } teams(first: 50) { nodes { id } }',
);
const CYCLES = list('cycles', 'id number name startsAt endsAt team { id }');
const ISSUES = list(
  'issues',
  `id identifier number title description priority estimate dueDate url
   createdAt updatedAt startedAt completedAt canceledAt
   team { id } state { name } assignee { id } creator { id } project { id } cycle { id } parent { id }
   labels(first: 50) { nodes { id } } attachments(first: 20) { nodes { url title } }`,
  ', orderBy: createdAt',
);
const CHILDREN = list(
  'issues',
  'id identifier parent { id }',
  ', orderBy: createdAt, filter: { parent: { null: false } }',
);
const RELATIONS = list('issueRelations', 'id type issue { id } relatedIssue { id }');
const COMMENTS = list(
  'comments',
  'id body createdAt user { id } issue { id } parent { id }',
  ', orderBy: createdAt',
);

interface LinearLabel {
  id: string;
  name: string;
  isGroup: boolean;
}

// Labels are merged by name; issues need the Linear id → merged id map on every page.
let labelCache: { importId: string; byId: Map<string, string> } | null = null;

const labelKey = (name: string) => `label:${name.trim().toLowerCase()}`;

async function labelIds(sctx: SourceContext) {
  if (labelCache?.importId !== sctx.row.id) {
    const labels = await all<LinearLabel>(sctx, LABELS, 'issueLabels');
    labelCache = {
      importId: sctx.row.id,
      byId: new Map(labels.filter((l) => !l.isGroup).map((l) => [l.id, labelKey(l.name)])),
    };
  }
  return labelCache.byId;
}

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

interface LinearIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  team: { id: string };
  state: { name: string } | null;
  assignee: { id: string } | null;
  creator: { id: string } | null;
  project: { id: string } | null;
  cycle: { id: string } | null;
  parent: { id: string } | null;
  labels: { nodes: { id: string }[] };
  attachments: { nodes: { url: string; title: string | null }[] };
}

function toIssue(i: LinearIssue, labels: Map<string, string>): SourceIssue {
  const estimate = i.estimate == null ? undefined : Math.round(i.estimate);
  return {
    id: i.id,
    ref: i.identifier,
    teamId: i.team.id,
    number: i.number,
    title: i.title,
    description: i.description ?? undefined,
    status: i.state?.name,
    priority: i.priority,
    assigneeId: i.assignee?.id,
    creatorId: i.creator?.id,
    labelIds: [
      ...new Set(i.labels.nodes.map((l) => labels.get(l.id)).filter((l): l is string => !!l)),
    ],
    projectId: i.project?.id,
    cycleId: i.cycle?.id,
    parentId: i.parent?.id,
    estimate: estimate != null && estimate >= 0 && estimate <= 100 ? estimate : undefined,
    dueDate: i.dueDate ?? undefined,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    startedAt: i.startedAt ?? undefined,
    completedAt: i.completedAt ?? undefined,
    canceledAt: i.canceledAt ?? undefined,
    url: i.url,
    links: i.attachments.nodes.map((a) => ({ url: a.url, title: a.title ?? a.url })),
  };
}

export const linearSource: ImportAdapter = {
  key: 'linear',

  async analyze(sctx) {
    const [teams, users, labels, projects, cycles] = await Promise.all([
      all<{
        id: string;
        name: string;
        key: string;
        issueCount: number;
        states: { nodes: { name: string; type: string; position: number }[] };
      }>(sctx, TEAMS, 'teams'),
      all<{ id: string; name: string; displayName: string; email: string }>(sctx, USERS, 'users'),
      all<LinearLabel>(sctx, LABELS, 'issueLabels'),
      all<{
        id: string;
        name: string;
        description: string | null;
        state: string;
        startDate: string | null;
        targetDate: string | null;
        lead: { id: string } | null;
        teams: { nodes: { id: string }[] };
      }>(sctx, PROJECTS, 'projects'),
      all<{
        id: string;
        number: number;
        name: string | null;
        startsAt: string;
        endsAt: string;
        team: { id: string };
      }>(sctx, CYCLES, 'cycles'),
    ]);

    const merged = new Map<string, { id: string; name: string; count: number }>();
    for (const l of labels) {
      if (l.isGroup) continue;
      const id = labelKey(l.name);
      if (!merged.has(id)) merged.set(id, { id, name: l.name, count: 0 });
    }

    const summary: ImportSummary = {
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        issueCount: t.issueCount,
        statuses: [...t.states.nodes]
          .sort((a, b) => a.position - b.position)
          .map((s) => ({
            name: s.name,
            type: (STATE_TYPES as readonly string[]).includes(s.type)
              ? (s.type as StateType)
              : guessStateType(s.name),
            count: 0,
          })),
      })),
      users: users.map((u) => ({
        id: u.id,
        name: u.name || u.displayName,
        email: u.email,
        count: 0,
      })),
      labels: [...merged.values()],
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        count: 0,
        teamIds: p.teams.nodes.map((t) => t.id),
        description: p.description,
        status: (PROJECT_STATUSES as readonly string[]).includes(p.state)
          ? (p.state as ProjectStatus)
          : undefined,
        leadId: p.lead?.id ?? null,
        startDate: day(p.startDate),
        targetDate: day(p.targetDate),
      })),
      cycles: cycles
        .sort((a, b) => a.number - b.number)
        .map((c) => ({
          id: c.id,
          teamId: c.team.id,
          number: c.number,
          name: c.name,
          startsAt: day(c.startsAt)!,
          endsAt: day(c.endsAt)!,
        })),
      // Linear doesn't count comments up front; progress counts them as they come.
      counts: { issues: teams.reduce((n, t) => n + t.issueCount, 0), comments: 0 },
      warnings: [],
    };
    labelCache = null;
    return { summary };
  },

  async issues(sctx, cursor) {
    const labels = await labelIds(sctx);
    const p = await page<LinearIssue>(sctx, ISSUES, 'issues', cursor);
    return { items: p.items.map((i) => toIssue(i, labels)), next: p.next };
  },

  async children(sctx, cursor) {
    const p = await page<{ id: string; identifier: string; parent: { id: string } | null }>(
      sctx,
      CHILDREN,
      'issues',
      cursor,
    );
    return {
      items: p.items.map((i) => ({
        id: i.id,
        ref: i.identifier,
        teamId: '',
        title: '',
        parentId: i.parent?.id,
      })),
      next: p.next,
    };
  },

  async relations(sctx, cursor) {
    const p = await page<{
      id: string;
      type: string;
      issue: { id: string };
      relatedIssue: { id: string };
    }>(sctx, RELATIONS, 'issueRelations', cursor);
    return {
      // "similar" is Linear's own suggestion, not something people said.
      items: p.items
        .filter((r) => r.type === 'blocks' || r.type === 'related' || r.type === 'duplicate')
        .map((r) => ({
          id: r.id,
          issueId: r.issue.id,
          relatedIssueId: r.relatedIssue.id,
          type: r.type as 'blocks' | 'related' | 'duplicate',
        })),
      next: p.next,
    };
  },

  async comments(sctx, cursor) {
    const p = await page<{
      id: string;
      body: string;
      createdAt: string;
      user: { id: string } | null;
      issue: { id: string } | null;
      parent: { id: string } | null;
    }>(sctx, COMMENTS, 'comments', cursor);
    return {
      // Oldest first within the page, so replies come after what they answer.
      items: p.items
        .filter((c) => c.issue)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((c) => ({
          id: c.id,
          issueId: c.issue!.id,
          authorId: c.user?.id,
          body: c.body,
          createdAt: c.createdAt,
          parentId: c.parent?.id,
        })),
      next: p.next,
    };
  },
};
