import {
  branchName,
  type Comment,
  type Cycle,
  createCommentSchema,
  createIssueSchema,
  type Issue,
  type IssueFilter,
  issueFilterSchema,
  type Label,
  type Milestone,
  type Project,
  priorityLabel,
  type Team,
  updateIssueSchema,
} from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GraphQLError } from 'graphql';
import { users, workspaces } from '../../db/schema.ts';
import type { AuthUser, WorkspaceCtx } from '../../lib/auth.ts';
import { HttpError, parse } from '../../lib/errors.ts';
import { mutate } from '../../lib/mutate.ts';
import type { Access } from '../access.ts';
import { createComment, listComments } from '../comments.ts';
import { listCycles } from '../cycles.ts';
import { signedFileUrl } from '../files.ts';
import {
  createIssue,
  getIssue,
  queryIssuePage,
  queryIssues,
  setArchived,
  trashIssue,
  updateIssue,
} from '../issues.ts';
import { listLabels } from '../labels.ts';
import { listProjects } from '../projects.ts';
import { listTeams } from '../teams.ts';
import { listMembers, workspaceSettings } from '../workspaces.ts';

/** How many issues and comments one request may load, across every list in it. */
export const NODE_BUDGET = 5000;
const MAX_PAGE = 250;

export interface GqlUser {
  id: string;
  name: string;
  username: string;
  email: string;
  avatarUrl: string | null;
  role: string | null;
}

export interface GqlContext {
  app: FastifyInstance;
  req: FastifyRequest;
  access: Access;
  ws: WorkspaceCtx;
  user: AuthUser;
  budget: { left: number };
  cache: Map<string, Promise<unknown>>;
}

type Args = Record<string, unknown>;
type Resolver<S = unknown> = (source: S, args: Args, ctx: GqlContext) => unknown;

/** Loads something once per request. */
function once<T>(ctx: GqlContext, key: string, load: () => Promise<T>): Promise<T> {
  let hit = ctx.cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    ctx.cache.set(key, hit);
  }
  return hit;
}

function charge(ctx: GqlContext, n: number) {
  ctx.budget.left -= n;
  if (ctx.budget.left < 0)
    throw new GraphQLError(
      `This query loads more than ${NODE_BUDGET} issues and comments; ask for fewer at once`,
      { extensions: { code: 'QUERY_TOO_LARGE' } },
    );
}

const teams = (ctx: GqlContext) => once(ctx, 'teams', () => listTeams(ctx.app.db, ctx.access));
const labels = (ctx: GqlContext) => once(ctx, 'labels', () => listLabels(ctx.app.db, ctx.access));
const projects = (ctx: GqlContext) =>
  once(ctx, 'projects', () => listProjects(ctx.app.db, ctx.access));
const cycles = (ctx: GqlContext) => once(ctx, 'cycles', () => listCycles(ctx.app.db, ctx.access));
const settings = (ctx: GqlContext) =>
  once(ctx, 'settings', async () => {
    const [row] = await ctx.app.db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.ws.id));
    return workspaceSettings(row ?? { settings: null });
  });

const members = (ctx: GqlContext) =>
  once(ctx, 'members', async () =>
    (await listMembers(ctx.app.db, ctx.access)).map(
      ({ avatarFileId, avatarColor: _color, joinedAt: _joined, suspended: _s, ...m }) => ({
        ...m,
        avatarUrl: signedFileUrl(ctx.app, avatarFileId),
      }),
    ),
  );

/** A person by id: a member, or someone who left, a bot or a placeholder (no email, no role). */
function userById(ctx: GqlContext, id: string | null | undefined): Promise<GqlUser | null> {
  if (!id) return Promise.resolve(null);
  return once(ctx, `user:${id}`, async () => {
    const member = (await members(ctx)).find((m) => m.id === id);
    if (member) return member;
    const [row] = await ctx.app.db
      .select({ id: users.id, name: users.name, username: users.username })
      .from(users)
      .where(eq(users.id, id));
    return row ? { ...row, email: '', avatarUrl: null, role: null } : null;
  });
}

/** An issue by id or identifier, or null when the caller can't see it. */
function issueById(ctx: GqlContext, id: string | null | undefined): Promise<Issue | null> {
  if (!id) return Promise.resolve(null);
  return once(ctx, `issue:${id}`, () =>
    getIssue(ctx.app.db, ctx.access, id).catch((err) => {
      if (err instanceof HttpError && err.statusCode === 404) return null;
      throw err;
    }),
  );
}

async function teamById(ctx: GqlContext, id: string | null) {
  return (await teams(ctx)).find((t) => t.id === id) ?? null;
}

interface FilterInput {
  query?: string | null;
  subscribedByMe?: boolean | null;
  [key: string]: unknown;
}

/** The GraphQL filter as the REST IssueFilter, validated the same way. */
function toFilter(input: FilterInput | null | undefined, extra: IssueFilter = {}): IssueFilter {
  const { query, subscribedByMe, ...rest } = input ?? {};
  const raw = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null));
  return parse(issueFilterSchema, {
    ...raw,
    ...(query ? { q: query } : {}),
    ...(subscribedByMe ? { subscribedBy: 'me' } : {}),
    ...extra,
  });
}

async function issueConnection(ctx: GqlContext, args: Args, extra: IssueFilter = {}) {
  const first = Math.min(Math.max(Number(args.first ?? 50), 1), MAX_PAGE);
  const after = typeof args.after === 'string' && args.after ? args.after : null;
  if (after && !/^[0-9a-f-]{36}$/i.test(after))
    throw new GraphQLError('after must be an endCursor from a previous page', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  const filter = toFilter(args.filter as FilterInput, extra);
  const rows = await queryIssuePage(ctx.app.db, ctx.access, filter, after, first + 1);
  const nodes = rows.slice(0, first);
  charge(ctx, nodes.length);
  return {
    nodes,
    pageInfo: { hasNextPage: rows.length > first, endCursor: nodes.at(-1)?.id ?? null },
  };
}

/** Inputs as the REST schemas expect them: fields GraphQL left out are absent, not null. */
const defined = (input: unknown) =>
  Object.fromEntries(Object.entries((input ?? {}) as Args).filter(([, v]) => v !== undefined));

const run = <T>(ctx: GqlContext, fn: Parameters<typeof mutate<T>>[2]) =>
  mutate(ctx.app, ctx.req, fn);

export const resolvers: Record<string, Record<string, Resolver<never>>> = {
  Query: {
    viewer: (_s, _a, ctx) => userById(ctx, ctx.user.id),
    workspace: (_s, _a, ctx) => ({
      id: ctx.ws.id,
      name: ctx.ws.name,
      slug: ctx.ws.slug,
      url: `${ctx.app.env.publicUrl}/${ctx.ws.slug}`,
    }),
    teams: (_s, _a, ctx) => teams(ctx),
    team: async (_s, { key }, ctx) => {
      const k = String(key).toLowerCase();
      return (await teams(ctx)).find((t) => t.id === key || t.key.toLowerCase() === k) ?? null;
    },
    members: async (_s, _a, ctx) => members(ctx),
    labels: (_s, _a, ctx) => labels(ctx),
    projects: (_s, _a, ctx) => projects(ctx),
    project: async (_s, { id }, ctx) => (await projects(ctx)).find((p) => p.id === id) ?? null,
    cycles: async (_s, { teamKey }, ctx) => {
      const all = await cycles(ctx);
      if (!teamKey) return all;
      const k = String(teamKey).toLowerCase();
      const team = (await teams(ctx)).find((t) => t.key.toLowerCase() === k || t.id === teamKey);
      return team ? all.filter((c) => c.teamId === team.id) : [];
    },
    issue: (_s, { id }, ctx) => issueById(ctx, String(id)),
    issues: (_s, args, ctx) => issueConnection(ctx, args),
    search: async (_s, { query, first }, ctx) => {
      const q = String(query).trim();
      if (!q) return [];
      const limit = Math.min(Math.max(Number(first ?? 20), 1), 100);
      const found = await queryIssues(
        ctx.app.db,
        ctx.access,
        toFilter({ query: q }),
        limit,
        'relevance',
      );
      charge(ctx, found.length);
      return found;
    },
  },

  Mutation: {
    issueCreate: (_s, { input }, ctx) => {
      const data = parse(createIssueSchema, defined(input));
      return run(ctx, (c) => createIssue(c, data));
    },
    issueUpdate: async (_s, { id, input }, ctx) => {
      const issue = await getIssue(ctx.app.db, ctx.access, String(id));
      const patch = parse(updateIssueSchema, defined(input));
      return run(ctx, (c) => updateIssue(c, issue.id, patch));
    },
    issueArchive: (_s, { id }, ctx) => run(ctx, (c) => setArchived(c, String(id), true)),
    issueUnarchive: (_s, { id }, ctx) => run(ctx, (c) => setArchived(c, String(id), false)),
    issueTrash: async (_s, { id }, ctx) => {
      const issue = await getIssue(ctx.app.db, ctx.access, String(id));
      await run(ctx, (c) => trashIssue(c, issue.id));
      return true;
    },
    commentCreate: (_s, { issueId, body, parentId }, ctx) => {
      const input = parse(createCommentSchema, defined({ body, parentId }));
      return run(ctx, (c) => createComment(c, String(issueId), input));
    },
  },

  Team: {
    states: (t: Team) => [...t.states].sort((a, b) => a.position - b.position),
    members: async (t: Team, _a, ctx) => {
      const ids = new Set(t.memberIds);
      return (await members(ctx)).filter((m) => ids.has(m.id));
    },
    issues: (t: Team, args, ctx) => issueConnection(ctx, args, { teamId: t.id }),
  },

  Label: {
    team: (l: Label, _a, ctx) => teamById(ctx, l.teamId),
  },

  Project: {
    lead: (p: Project, _a, ctx) => userById(ctx, p.leadId),
    teams: async (p: Project, _a, ctx) =>
      (await teams(ctx)).filter((t) => p.teamIds.includes(t.id)),
    issues: (p: Project, args, ctx) => issueConnection(ctx, args, { projectIds: [p.id] }),
  },

  Cycle: {
    team: (c: Cycle, _a, ctx) => teamById(ctx, c.teamId),
  },

  Issue: {
    priorityLabel: (i: Issue) => priorityLabel(i.priority),
    trashedAt: (i: Issue) => i.deletedAt,
    team: (i: Issue, _a, ctx) => teamById(ctx, i.teamId),
    state: async (i: Issue, _a, ctx) =>
      (await teams(ctx)).flatMap((t) => t.states).find((s) => s.id === i.stateId),
    assignee: (i: Issue, _a, ctx) => userById(ctx, i.assigneeId),
    creator: (i: Issue, _a, ctx) => userById(ctx, i.creatorId),
    labels: async (i: Issue, _a, ctx) => {
      const ids = new Set(i.labelIds);
      return (await labels(ctx)).filter((l) => ids.has(l.id));
    },
    project: async (i: Issue, _a, ctx) =>
      (await projects(ctx)).find((p) => p.id === i.projectId) ?? null,
    milestone: async (i: Issue, _a, ctx): Promise<Milestone | null> =>
      (await projects(ctx))
        .find((p) => p.id === i.projectId)
        ?.milestones.find((m) => m.id === i.milestoneId) ?? null,
    cycle: async (i: Issue, _a, ctx) => (await cycles(ctx)).find((c) => c.id === i.cycleId) ?? null,
    parent: (i: Issue, _a, ctx) => issueById(ctx, i.parentId),
    children: async (i: Issue, _a, ctx) => {
      if (!i.subIssueCount) return [];
      const rows = await queryIssues(ctx.app.db, ctx.access, { parentId: i.id });
      charge(ctx, rows.length);
      return rows;
    },
    comments: async (i: Issue, _a, ctx) => {
      const rows = await listComments(ctx.app.db, ctx.access, i.id);
      charge(ctx, rows.length);
      return rows;
    },
    branchName: async (i: Issue, _a, ctx) =>
      branchName((await settings(ctx)).gitBranchFormat, {
        identifier: i.identifier,
        title: i.title,
        username: ctx.user.username,
      }),
    url: (i: Issue, _a, ctx) => `${ctx.app.env.publicUrl}/${ctx.ws.slug}/issue/${i.identifier}`,
  },

  Comment: {
    author: (c: Comment, _a, ctx) => userById(ctx, c.authorId),
    reactions: (c: Comment, _a, ctx) =>
      Promise.all(
        c.reactions.map(async (r) => ({
          emoji: r.emoji,
          users: (await Promise.all(r.userIds.map((id) => userById(ctx, id)))).filter(Boolean),
        })),
      ),
  },
};
