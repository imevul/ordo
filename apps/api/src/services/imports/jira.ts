import { guessStateType, type ImportSummary, parsePriority, type StateType } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiCallError, callApi, trimUrl } from '../../integrations/http.ts';
import { jiraToMarkdown } from './jira-markup.ts';
import { importSecrets } from './secrets.ts';
import {
  ImportAbort,
  type ImportAdapter,
  ImportRetryLater,
  type Page,
  type SourceComment,
  type SourceContext,
  type SourceIssue,
  type SourceRelation,
} from './types.ts';

/**
 * Jira, Cloud or Data Center, read through REST API v2 (which both have). Projects become source
 * teams; epics become projects, and their issues belong to them; sub-tasks become sub-issues;
 * issue types (Bug, Story…) and components become labels; issue links become relations.
 * Descriptions and comments are turned from Jira's wiki markup into Markdown.
 *
 * Cloud signs in with an account's email and an API token; Data Center with a personal access
 * token. Cloud pages searches with tokens, Data Center with offsets.
 */

interface JiraConfig {
  siteUrl: string;
  projects: string[];
  projectNames: Record<string, string>;
  cloud: boolean;
  /** Custom fields found during analysis. */
  fields?: { estimate?: string; epicLink?: string };
}

interface JiraSecrets extends Record<string, string> {
  token: string;
}

const cfg = (sctx: SourceContext) => sctx.row.config as unknown as JiraConfig;
const PAGE_SIZE = 100;

const authorization = (s: { token: string; email?: string }) =>
  s.email
    ? `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`
    : `Bearer ${s.token}`;

async function jira<T>(
  app: FastifyInstance,
  siteUrl: string,
  secrets: { token: string; email?: string },
  path: string,
) {
  try {
    const { data } = await callApi<T>(app, `${siteUrl}${path}`, {
      headers: { authorization: authorization(secrets) },
      timeoutMs: 30_000,
    });
    return data;
  } catch (err) {
    if (err instanceof ApiCallError) {
      if (err.status === 429 || /rate limit/i.test(err.message)) {
        throw new ImportRetryLater(
          "Waiting for Jira's rate limit; the import carries on by itself",
          new Date(Date.now() + 10 * 60_000),
        );
      }
      if (err.status === 401) {
        throw new ImportAbort('Jira refused the credentials: check them and start a new import');
      }
    }
    throw err;
  }
}

const call = <T>(sctx: SourceContext, path: string) =>
  jira<T>(sctx.app, cfg(sctx).siteUrl, importSecrets<JiraSecrets>(sctx), path);

// ─── the issues we read ───────────────────────────────────────────────────

interface JiraUser {
  accountId?: string;
  name?: string;
  key?: string;
  displayName: string;
  emailAddress?: string;
}

interface JiraType {
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}

interface JiraComment {
  id: string;
  body: string;
  created: string;
  author?: JiraUser;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary: string;
    description?: string | null;
    status: { name: string; statusCategory?: { key: string } };
    priority?: { name: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    creator?: JiraUser | null;
    labels?: string[];
    components?: { name: string }[];
    issuetype: JiraType;
    parent?: { key: string; fields?: { summary?: string; issuetype?: JiraType } } | null;
    created: string;
    updated: string;
    resolutiondate?: string | null;
    duedate?: string | null;
    comment?: { comments: JiraComment[]; total: number };
    issuelinks?: {
      id: string;
      type: { name: string };
      outwardIssue?: { key: string };
    }[];
  };
}

const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'priority',
  'assignee',
  'reporter',
  'creator',
  'labels',
  'components',
  'issuetype',
  'parent',
  'created',
  'updated',
  'resolutiondate',
  'duedate',
];

/** One page of the projects' issues, oldest first. */
async function search(
  sctx: SourceContext,
  cursor: string | null,
  fields: string[],
): Promise<{ issues: JiraIssue[]; next: string | null }> {
  const { projects, cloud } = cfg(sctx);
  const query = new URLSearchParams({
    jql: `project in (${projects.map((p) => `"${p}"`).join(', ')}) ORDER BY created ASC, key ASC`,
    maxResults: String(PAGE_SIZE),
    fields: fields.join(','),
  });
  if (cloud) {
    if (cursor) query.set('nextPageToken', cursor);
    const res = await call<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(
      sctx,
      `/rest/api/2/search/jql?${query}`,
    );
    return { issues: res.issues, next: res.isLast ? null : (res.nextPageToken ?? null) };
  }
  const startAt = Number(cursor ?? 0);
  query.set('startAt', String(startAt));
  const res = await call<{ issues: JiraIssue[]; total: number }>(
    sctx,
    `/rest/api/2/search?${query}`,
  );
  const end = startAt + res.issues.length;
  return { issues: res.issues, next: res.issues.length && end < res.total ? String(end) : null };
}

async function allIssues(sctx: SourceContext, fields: string[]) {
  const out: JiraIssue[] = [];
  let cursor: string | null = null;
  do {
    const page: { issues: JiraIssue[]; next: string | null } = await search(sctx, cursor, fields);
    out.push(...page.issues);
    cursor = page.next;
  } while (cursor);
  return out;
}

const userId = (u: JiraUser | null | undefined) => u && (u.accountId ?? u.name ?? u.key);
const labelKey = (name: string) => `label:${name.trim().toLowerCase()}`;
const isEpic = (t: JiraType | undefined) => !!t && (t.hierarchyLevel === 1 || t.name === 'Epic');
const teamOf = (key: string) => key.slice(0, key.lastIndexOf('-'));

/** Jira writes offsets without a colon ("+0000"), which not every parser takes. */
function date(value: string | null | undefined) {
  if (!value) return undefined;
  const d = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const CATEGORY_TYPES: Record<string, StateType> = {
  new: 'unstarted',
  indeterminate: 'started',
  done: 'completed',
};

function stateType(status: JiraIssue['fields']['status']): StateType | null {
  return guessStateType(status.name) ?? CATEGORY_TYPES[status.statusCategory?.key ?? ''] ?? null;
}

/** Labels for an issue: its own, its components, and its type (unless that's structural). */
function labelsOf(f: JiraIssue['fields']) {
  return [
    ...(f.labels ?? []),
    ...(f.components ?? []).map((c) => c.name),
    ...(f.issuetype.subtask || isEpic(f.issuetype) ? [] : [f.issuetype.name]),
  ];
}

function toIssue(config: JiraConfig, i: JiraIssue): SourceIssue | null {
  const f = i.fields;
  if (isEpic(f.issuetype)) return null;
  const type = stateType(f.status);
  const resolved = f.status.statusCategory?.key === 'done' ? date(f.resolutiondate) : undefined;
  const epicLink = config.fields?.epicLink ? (f[config.fields.epicLink] as string | null) : null;
  const estimate = config.fields?.estimate ? Number(f[config.fields.estimate]) : Number.NaN;
  const parentIsEpic = isEpic(f.parent?.fields?.issuetype);
  return {
    id: i.key,
    ref: i.key,
    teamId: teamOf(i.key),
    number: Number(i.key.slice(i.key.lastIndexOf('-') + 1)),
    title: f.summary,
    description: f.description ? jiraToMarkdown(f.description) : undefined,
    status: f.status.name,
    priority: f.priority ? (parsePriority(f.priority.name) ?? undefined) : undefined,
    assigneeId: userId(f.assignee) ?? undefined,
    creatorId: userId(f.reporter ?? f.creator) ?? undefined,
    labelIds: [...new Set(labelsOf(f).map(labelKey))],
    projectId: (parentIsEpic ? f.parent!.key : epicLink) ?? undefined,
    parentId: f.parent && !parentIsEpic ? f.parent.key : undefined,
    estimate:
      Number.isFinite(estimate) && estimate >= 0 && estimate <= 100
        ? Math.round(estimate)
        : undefined,
    dueDate: f.duedate ?? undefined,
    createdAt: date(f.created),
    updatedAt: date(f.updated),
    completedAt: type === 'completed' ? resolved : undefined,
    canceledAt: type === 'canceled' ? resolved : undefined,
    url: `${config.siteUrl}/browse/${i.key}`,
  };
}

/** All of an issue's comments: search results carry the first ones, the rest are fetched. */
async function commentsOf(sctx: SourceContext, i: JiraIssue) {
  const first = i.fields.comment ?? { comments: [], total: 0 };
  const all = [...first.comments];
  while (all.length < first.total) {
    const more = await call<{ comments: JiraComment[] }>(
      sctx,
      `/rest/api/2/issue/${i.key}/comment?startAt=${all.length}&maxResults=${PAGE_SIZE}`,
    );
    if (!more.comments.length) break;
    all.push(...more.comments);
  }
  return all;
}

// ─── the source ───────────────────────────────────────────────────────────

export const jiraSource: ImportAdapter = {
  key: 'jira',

  async start(app, input) {
    if (input.source !== 'jira') throw new Error('Not a Jira import');
    const siteUrl = trimUrl(input.siteUrl);
    const secrets = { token: input.token, ...(input.email && { email: input.email }) };
    await jira(app, siteUrl, secrets, '/rest/api/2/myself');
    const visible = await jira<{ key: string; name: string }[]>(
      app,
      siteUrl,
      secrets,
      '/rest/api/2/project',
    );
    for (const key of input.projects ?? []) {
      if (!visible.some((p) => p.key === key)) {
        throw new ImportAbort(`Can't see the project ${key} with these credentials`);
      }
    }
    const projects = input.projects?.length
      ? [...new Set(input.projects)]
      : visible.map((p) => p.key);
    if (!projects.length) throw new ImportAbort("These credentials can't see any projects");
    const shown = projects.slice(0, 3).join(', ');
    return {
      name: `Jira: ${shown}${projects.length > 3 ? ` and ${projects.length - 3} more` : ''}`,
      config: {
        siteUrl,
        projects,
        projectNames: Object.fromEntries(visible.map((p) => [p.key, p.name])),
        cloud: !!input.email,
      },
      secrets,
    };
  },

  async analyze(sctx) {
    const config = cfg(sctx);
    const fieldList = await call<{ id: string; name: string }[]>(sctx, '/rest/api/2/field');
    const fieldNamed = (...names: string[]) =>
      fieldList.find((f) => names.includes(f.name.toLowerCase()))?.id;
    const fields = {
      estimate: fieldNamed('story points', 'story point estimate'),
      epicLink: fieldNamed('epic link'),
    };

    const teams = new Map(
      config.projects.map((key) => [
        key,
        {
          count: 0,
          statuses: new Map<string, StateType | null>(),
          used: new Map<string, number>(),
        },
      ]),
    );
    const users = new Map<string, { name: string; email: string | null; count: number }>();
    const labels = new Map<string, { name: string; count: number }>();
    const summary: ImportSummary = {
      teams: [],
      users: [],
      labels: [],
      projects: [],
      counts: { issues: 0, comments: 0 },
      warnings: [],
    };
    const person = (u: JiraUser | null | undefined) => {
      const id = userId(u);
      if (!u || !id) return;
      const entry = users.get(id) ?? {
        name: u.displayName,
        email: u.emailAddress ?? null,
        count: 0,
      };
      entry.count++;
      users.set(id, entry);
    };

    const scanned = await allIssues(sctx, [
      ...ISSUE_FIELDS,
      'comment',
      ...(fields.epicLink ? [fields.epicLink] : []),
    ]);
    const epicIssues = new Map<string, number>();
    for (const i of scanned) {
      const f = i.fields;
      if (isEpic(f.issuetype)) {
        // Its assignee leads the project, so they need mapping too.
        person(f.assignee);
        summary.projects.push({
          id: i.key,
          name: f.summary,
          count: 0,
          teamIds: [teamOf(i.key)],
          description: f.description ? jiraToMarkdown(f.description) : null,
          status:
            f.status.statusCategory?.key === 'done'
              ? 'completed'
              : f.status.statusCategory?.key === 'indeterminate'
                ? 'started'
                : 'planned',
          leadId: userId(f.assignee) ?? null,
          targetDate: f.duedate ?? null,
        });
        continue;
      }
      const team = teams.get(teamOf(i.key));
      if (!team) continue;
      team.count++;
      team.statuses.set(f.status.name, stateType(f.status));
      team.used.set(f.status.name, (team.used.get(f.status.name) ?? 0) + 1);
      person(f.assignee);
      person(f.reporter ?? f.creator);
      // Search results carry the first comments; busy issues need the rest for their authors.
      for (const c of await commentsOf(sctx, i)) person(c.author);
      summary.counts.comments += f.comment?.total ?? 0;
      for (const name of labelsOf(f)) {
        const id = labelKey(name);
        const entry = labels.get(id) ?? { name, count: 0 };
        entry.count++;
        labels.set(id, entry);
      }
      const epic = isEpic(f.parent?.fields?.issuetype)
        ? f.parent!.key
        : fields.epicLink
          ? (f[fields.epicLink] as string | null)
          : null;
      if (epic) epicIssues.set(epic, (epicIssues.get(epic) ?? 0) + 1);
    }

    for (const [key, t] of teams) {
      summary.counts.issues += t.count;
      summary.teams.push({
        id: key,
        name: config.projectNames[key] ?? key,
        key,
        issueCount: t.count,
        statuses: [...t.statuses].map(([name, type]) => ({
          name,
          type,
          count: t.used.get(name) ?? 0,
        })),
      });
    }
    for (const p of summary.projects) p.count = epicIssues.get(p.id) ?? 0;
    summary.users = [...users].map(([id, u]) => ({ id, ...u }));
    summary.labels = [...labels].map(([id, l]) => ({ id, ...l }));
    return { summary, config: { ...sctx.row.config, fields } };
  },

  async issues(sctx, cursor) {
    const config = cfg(sctx);
    const extra = [config.fields?.estimate, config.fields?.epicLink].filter(
      (f): f is string => !!f,
    );
    const page = await search(sctx, cursor, [...ISSUE_FIELDS, ...extra]);
    return {
      items: page.issues.map((i) => toIssue(config, i)).filter((i): i is SourceIssue => !!i),
      next: page.next,
    };
  },

  async children(sctx, cursor) {
    const page = await search(sctx, cursor, ['parent', 'issuetype']);
    return {
      items: page.issues
        .filter((i) => i.fields.parent && !isEpic(i.fields.parent.fields?.issuetype))
        .map((i) => ({
          id: i.key,
          ref: i.key,
          teamId: teamOf(i.key),
          title: '',
          parentId: i.fields.parent!.key,
        })),
      next: page.next,
    };
  },

  async relations(sctx, cursor): Promise<Page<SourceRelation>> {
    const page = await search(sctx, cursor, ['issuelinks']);
    const items: SourceRelation[] = [];
    for (const i of page.issues) {
      // Every link shows up on both issues; the outward side is enough.
      for (const link of i.fields.issuelinks ?? []) {
        if (!link.outwardIssue) continue;
        const name = link.type.name.toLowerCase();
        items.push({
          id: link.id,
          issueId: i.key,
          relatedIssueId: link.outwardIssue.key,
          type: name.startsWith('block')
            ? 'blocks'
            : name.startsWith('duplicat')
              ? 'duplicate'
              : 'related',
        });
      }
    }
    return { items, next: page.next };
  },

  async comments(sctx, cursor): Promise<Page<SourceComment>> {
    const page = await search(sctx, cursor, ['comment']);
    const items: SourceComment[] = [];
    for (const i of page.issues) {
      for (const c of await commentsOf(sctx, i)) {
        items.push({
          id: c.id,
          issueId: i.key,
          authorId: userId(c.author) ?? undefined,
          body: jiraToMarkdown(c.body),
          createdAt: date(c.created),
        });
      }
    }
    return { items, next: page.next };
  },
};
