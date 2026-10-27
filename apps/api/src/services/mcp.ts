import {
  type Cycle,
  createCommentSchema,
  createIssueSchema,
  type Issue,
  type IssueFilter,
  MCP_TOOLS,
  type McpToolArgs,
  type McpToolName,
  mcpToolSchemas,
  priorityLabel,
  STATE_TYPES,
  type Team,
  updateIssueSchema,
} from '@ordo/shared';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema.ts';
import { badRequest, parse } from '../lib/errors.ts';
import type { Access } from './access.ts';
import { createComment, listComments } from './comments.ts';
import type { Ctx } from './context.ts';
import { listCycles } from './cycles.ts';
import { createIssue, getIssue, getIssueDetail, queryIssues, updateIssue } from './issues.ts';
import { listLabels } from './labels.ts';
import { listProjects } from './projects.ts';
import { listTeams } from './teams.ts';
import { listMembers } from './workspaces.ts';

/**
 * The tools behind the MCP endpoint. They call the same services as the REST API, with the
 * caller's access, and speak in names an agent can use: team keys, issue identifiers, status
 * and label names, usernames. Errors are thrown as HttpErrors and shown to the agent.
 */

export interface McpCaller {
  app: FastifyInstance;
  access: Access;
  workspace: { id: string; slug: string; name: string };
  /** Runs a change as the caller (source `mcp`), like `mutate` does for a request. */
  run: <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>;
}

/** Enough of a caller to read: AI assistance shows models issues the same way. */
export type McpReader = Omit<McpCaller, 'run'>;

const same = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
const PRIORITY_NAMES = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 } as const;
const OPEN_TYPES = STATE_TYPES.filter((t) => t !== 'completed' && t !== 'canceled');

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= load());
}

/** What the caller can see, loaded on first use and resolved by name. */
class Directory {
  constructor(private readonly c: McpReader) {}
  private get db() {
    return this.c.app.db;
  }
  teams = once(() => listTeams(this.db, this.c.access));
  labels = once(() => listLabels(this.db, this.c.access));
  projects = once(() => listProjects(this.db, this.c.access));
  cycles = once(() => listCycles(this.db, this.c.access));
  members = once(() => listMembers(this.db, this.c.access));

  async team(ref: string): Promise<Team> {
    const teams = await this.teams();
    const t = teams.find((t) => t.id === ref || same(t.key, ref) || same(t.name, ref));
    if (t) return t;
    throw badRequest(
      `Unknown team "${ref}". Teams: ${teams.map((t) => `${t.key} (${t.name})`).join(', ') || 'none'}`,
    );
  }

  async teamById(id: string) {
    return (await this.teams()).find((t) => t.id === id);
  }

  async status(team: Team, ref: string) {
    const s = team.states.find((s) => s.id === ref || same(s.name, ref));
    if (s) return s;
    throw badRequest(
      `Unknown status "${ref}" in ${team.key}. Statuses: ${team.states.map((s) => s.name).join(', ')}`,
    );
  }

  /** Statuses by name across teams (search without a team). */
  async statusIds(refs: string[], team?: Team) {
    const teams = team ? [team] : await this.teams();
    return refs.flatMap((ref) => {
      const ids = teams.flatMap((t) =>
        t.states.filter((s) => s.id === ref || same(s.name, ref)).map((s) => s.id),
      );
      if (!ids.length) throw badRequest(`Unknown status "${ref}"`);
      return ids;
    });
  }

  async person(ref: string): Promise<string> {
    if (ref === 'me') return this.c.access.userId;
    const members = await this.members();
    const handle = ref.replace(/^@/, '');
    const m = members.find(
      (m) =>
        m.id === ref ||
        same(m.username, handle) ||
        (m.email && same(m.email, ref)) ||
        same(m.name, ref),
    );
    if (m) return m.id;
    throw badRequest(`Unknown person "${ref}". Use list_members to find usernames.`);
  }

  /** Label ids by name; a team's own label wins over a workspace label of the same name. */
  async labelIds(refs: string[], teamId?: string) {
    const usable = (await this.labels()).filter((l) => !teamId || !l.teamId || l.teamId === teamId);
    return refs.map((ref) => {
      const matches = usable.filter((l) => l.id === ref || same(l.name, ref));
      const l = matches.find((l) => l.teamId) ?? matches[0];
      if (l) return l.id;
      throw badRequest(
        `Unknown label "${ref}". Labels: ${usable.map((l) => l.name).join(', ') || 'none'}`,
      );
    });
  }

  async project(ref: string) {
    const projects = await this.projects();
    const p = projects.find((p) => p.id === ref || same(p.name, ref));
    if (p) return p;
    throw badRequest(`Unknown project "${ref}". Use list_projects to see them.`);
  }

  /** Cycles matching `ref`: "current", a number, a name or an id, within one team or all. */
  async cycleIds(ref: string, teamId?: string): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const cycles = (await this.cycles()).filter((c) => !teamId || c.teamId === teamId);
    const match = (c: Cycle) =>
      ref === 'current'
        ? c.startsAt <= today && c.endsAt > today
        : c.id === ref || String(c.number) === ref || (!!c.name && same(c.name, ref));
    const ids = cycles.filter(match).map((c) => c.id);
    if (ids.length) return ids;
    throw badRequest(
      ref === 'current' ? 'No cycle is running right now' : `Unknown cycle "${ref}"`,
    );
  }

  async cycle(ref: string, teamId: string) {
    const ids = await this.cycleIds(ref, teamId);
    if (ids.length > 1) throw badRequest(`"${ref}" matches several cycles; use its number or id`);
    return ids[0]!;
  }

  async issueId(ref: string) {
    return (await getIssue(this.db, this.c.access, ref)).id;
  }

  /** Display names for people who aren't necessarily members (bots, deleted members). */
  async people(ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map<string, Person>();
    const rows = await this.db
      .select({ id: users.id, name: users.name, username: users.username })
      .from(users)
      .where(inArray(users.id, wanted));
    return new Map(rows.map((r) => [r.id, { username: r.username, name: r.name }]));
  }
}

interface Person {
  username: string;
  name: string;
}

const priorityOf = (p: string | number) =>
  typeof p === 'number' ? p : PRIORITY_NAMES[p as keyof typeof PRIORITY_NAMES];

/** Issues as an agent reads them: names instead of ids. */
async function summarize(c: McpReader, dir: Directory, list: Issue[]) {
  const [teams, labels, projects, cycles, people] = await Promise.all([
    dir.teams(),
    dir.labels(),
    dir.projects(),
    dir.cycles(),
    dir.people(list.flatMap((i) => [i.assigneeId, i.creatorId])),
  ]);
  return list.map((i) => {
    const team = teams.find((t) => t.id === i.teamId);
    const state = team?.states.find((s) => s.id === i.stateId);
    const cycle = cycles.find((x) => x.id === i.cycleId);
    return {
      identifier: i.identifier,
      title: i.title,
      url: `${c.app.env.publicUrl}/${c.workspace.slug}/issue/${i.identifier}`,
      team: team?.key ?? null,
      status: state?.name ?? null,
      statusType: state?.type ?? null,
      priority: priorityLabel(i.priority),
      assignee: (i.assigneeId && people.get(i.assigneeId)) || null,
      creator: (i.creatorId && people.get(i.creatorId)) || null,
      labels: i.labelIds.map((id) => labels.find((l) => l.id === id)?.name).filter(Boolean),
      project: projects.find((p) => p.id === i.projectId)?.name ?? null,
      cycle: cycle ? { number: cycle.number, name: cycle.name } : null,
      estimate: i.estimate,
      dueDate: i.dueDate,
      subIssues: i.subIssueCount
        ? { total: i.subIssueCount, done: i.completedSubIssueCount }
        : undefined,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      completedAt: i.completedAt ?? undefined,
      canceledAt: i.canceledAt ?? undefined,
    };
  });
}

async function issueResult(c: McpReader, dir: Directory, ref: string, withComments: boolean) {
  const detail = await getIssueDetail(c.app.db, c.access, ref);
  const [summary] = await summarize(c, dir, [detail]);
  const [subIssues, comments] = await Promise.all([
    summarize(c, dir, detail.subIssues),
    withComments ? listComments(c.app.db, c.access, detail.id) : Promise.resolve([]),
  ]);
  const authors = await dir.people(comments.map((x) => x.authorId));
  return {
    id: detail.id,
    ...summary,
    description: detail.description,
    parent: detail.parent && { identifier: detail.parent.identifier, title: detail.parent.title },
    subIssues: subIssues.map((s) => ({
      identifier: s.identifier,
      title: s.title,
      status: s.status,
      assignee: s.assignee?.username ?? null,
    })),
    relations: detail.relations.map((r) => ({
      type: r.type,
      identifier: r.issue.identifier,
      title: r.issue.title,
    })),
    links: detail.links.map((l) => ({ title: l.title, url: l.url, kind: l.kind, state: l.state })),
    attachments: detail.attachments.map((a) => ({
      filename: a.filename,
      size: a.size,
      url: `${c.app.env.publicUrl}${a.url}`,
    })),
    comments: withComments
      ? comments.map((x) => ({
          id: x.id,
          author: (x.authorId && authors.get(x.authorId)) || null,
          body: x.body,
          replyTo: x.parentId ?? undefined,
          createdAt: x.createdAt,
          edited: !!x.editedAt || undefined,
          reactions: x.reactions.length
            ? x.reactions.map((r) => `${r.emoji} ${r.userIds.length}`).join('  ')
            : undefined,
        }))
      : undefined,
  };
}

/** An issue with its comments, sub-issues and relations, by name, as the MCP tools return it. */
export const readIssue = (c: McpReader, ref: string) => issueResult(c, new Directory(c), ref, true);

/** Issues as the MCP tools list them. */
export const describeIssues = (c: McpReader, list: Issue[]) => summarize(c, new Directory(c), list);

async function search(
  c: McpCaller,
  dir: Directory,
  filter: IssueFilter,
  limit: number,
  order: 'recent' | 'priority' | 'relevance',
) {
  // One extra row tells the agent there is more.
  const rows = await queryIssues(c.app.db, c.access, filter, limit + 1, order);
  const issues = await summarize(c, dir, rows.slice(0, limit));
  return { count: issues.length, truncated: rows.length > limit, issues };
}

type Handlers = { [K in McpToolName]: (args: McpToolArgs<K>) => Promise<unknown> };

function handlers(c: McpCaller): Handlers {
  const dir = new Directory(c);

  /** Issue fields shared by create and update, resolved within `team`. */
  async function fields(
    args: McpToolArgs<'create_issue'> | McpToolArgs<'update_issue'>,
    team: Team,
  ) {
    const out: Record<string, unknown> = {};
    if (args.description !== undefined) out.description = args.description;
    if (args.status !== undefined) out.stateId = (await dir.status(team, args.status)).id;
    if (args.priority !== undefined) out.priority = priorityOf(args.priority);
    if (args.assignee !== undefined)
      out.assigneeId = args.assignee === null ? null : await dir.person(args.assignee);
    if (args.labels !== undefined) out.labelIds = await dir.labelIds(args.labels, team.id);
    if (args.project !== undefined)
      out.projectId = args.project === null ? null : (await dir.project(args.project)).id;
    if (args.cycle !== undefined)
      out.cycleId = args.cycle === null ? null : await dir.cycle(args.cycle, team.id);
    if (args.parent !== undefined)
      out.parentId = args.parent === null ? null : await dir.issueId(args.parent);
    if (args.estimate !== undefined) out.estimate = args.estimate;
    if (args.dueDate !== undefined) out.dueDate = args.dueDate;
    return out;
  }

  return {
    list_teams: async () =>
      (await dir.teams()).map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        private: t.private,
        member: t.memberIds.includes(c.access.userId),
        cyclesEnabled: t.cyclesEnabled,
        statuses: t.states.map((s) => ({ name: s.name, type: s.type })),
        defaultStatus: t.states.find((s) => s.id === t.defaultStateId)?.name ?? null,
      })),

    list_statuses: async ({ team }) =>
      (await dir.team(team)).states.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        description: s.description,
      })),

    list_members: async ({ query }) => {
      const q = query?.trim().toLowerCase();
      return (await dir.members())
        .filter((m) => !m.suspended)
        .filter(
          (m) =>
            !q ||
            m.name.toLowerCase().includes(q) ||
            m.username.includes(q) ||
            m.email.toLowerCase().includes(q),
        )
        .map((m) => ({
          username: m.username,
          name: m.name,
          email: m.email || undefined,
          role: m.role,
          me: m.id === c.access.userId || undefined,
        }));
    },

    list_labels: async ({ team }) => {
      const teamId = team ? (await dir.team(team)).id : undefined;
      const teams = await dir.teams();
      return (await dir.labels())
        .filter((l) => !teamId || !l.teamId || l.teamId === teamId)
        .map((l) => ({
          name: l.name,
          team: l.teamId ? (teams.find((t) => t.id === l.teamId)?.key ?? null) : null,
          color: l.color,
        }));
    },

    list_projects: async ({ team }) => {
      const teamId = team ? (await dir.team(team)).id : undefined;
      const teams = await dir.teams();
      const projects = (await dir.projects()).filter((p) => !teamId || p.teamIds.includes(teamId));
      const leads = await dir.people(projects.map((p) => p.leadId));
      return projects.map((p) => ({
        name: p.name,
        status: p.status,
        health: p.health,
        lead: (p.leadId && leads.get(p.leadId)) || null,
        teams: p.teamIds.map((id) => teams.find((t) => t.id === id)?.key).filter(Boolean),
        startDate: p.startDate,
        targetDate: p.targetDate,
        progress: p.progress,
        description: p.description,
      }));
    },

    list_cycles: async ({ team, includePast }) => {
      const teamId = team ? (await dir.team(team)).id : undefined;
      const today = new Date().toISOString().slice(0, 10);
      const teams = await dir.teams();
      return (await dir.cycles())
        .filter((x) => (!teamId || x.teamId === teamId) && (includePast || x.endsAt > today))
        .map((x) => ({
          team: teams.find((t) => t.id === x.teamId)?.key ?? null,
          number: x.number,
          name: x.name,
          startsAt: x.startsAt,
          endsAt: x.endsAt,
          current: x.startsAt <= today && x.endsAt > today,
          progress: x.progress,
        }));
    },

    search_issues: async (a) => {
      const team = a.team ? await dir.team(a.team) : undefined;
      const filter: IssueFilter = { teamId: team?.id, q: a.query };
      if (a.status?.length) filter.stateIds = await dir.statusIds(a.status, team);
      if (a.statusType?.length) filter.stateTypes = a.statusType;
      else if (!a.status?.length && !a.includeClosed) filter.stateTypes = [...OPEN_TYPES];
      if (a.assignee?.length)
        filter.assigneeIds = await Promise.all(
          a.assignee.map((p) => (p === 'none' ? 'none' : dir.person(p))),
        );
      if (a.creator?.length) filter.creatorIds = await Promise.all(a.creator.map(dir.person, dir));
      if (a.labels?.length) filter.labelIds = await dir.labelIds(a.labels, team?.id);
      if (a.project)
        filter.projectIds = [a.project === 'none' ? 'none' : (await dir.project(a.project)).id];
      if (a.cycle)
        filter.cycleIds = a.cycle === 'none' ? ['none'] : await dir.cycleIds(a.cycle, team?.id);
      if (a.priority?.length) filter.priorities = a.priority.map(priorityOf);
      if (a.subscribed) filter.subscribedBy = 'me';
      return search(c, dir, filter, a.limit, a.query?.trim() ? 'relevance' : 'recent');
    },

    my_issues: async ({ includeClosed, limit }) =>
      search(
        c,
        dir,
        { assigneeIds: ['me'], stateTypes: includeClosed ? undefined : [...OPEN_TYPES] },
        limit,
        'priority',
      ),

    get_issue: ({ issue, comments }) => issueResult(c, dir, issue, comments),

    create_issue: async (a) => {
      const team = await dir.team(a.team);
      const input = parse(createIssueSchema, {
        teamId: team.id,
        title: a.title,
        ...(await fields(a, team)),
      });
      const created = await c.run((ctx) => createIssue(ctx, input));
      return issueResult(c, dir, created.id, false);
    },

    update_issue: async (a) => {
      const current = await getIssue(c.app.db, c.access, a.issue);
      const team = a.team ? await dir.team(a.team) : await dir.teamById(current.teamId);
      if (!team) throw badRequest('Unknown team').as('unknown_team');
      const patch = parse(updateIssueSchema, {
        ...(a.title !== undefined && { title: a.title }),
        ...(team.id !== current.teamId && { teamId: team.id }),
        ...(await fields(a, team)),
        ...(a.addLabels && { addLabelIds: await dir.labelIds(a.addLabels, team.id) }),
        ...(a.removeLabels && { removeLabelIds: await dir.labelIds(a.removeLabels, team.id) }),
      });
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      await c.run((ctx) => updateIssue(ctx, current.id, patch));
      return issueResult(c, dir, current.id, false);
    },

    add_comment: async ({ issue, body, replyTo }) => {
      const input = parse(createCommentSchema, { body, parentId: replyTo });
      const target = await getIssue(c.app.db, c.access, issue);
      const comment = await c.run((ctx) => createComment(ctx, target.id, input));
      return {
        id: comment.id,
        issue: target.identifier,
        url: `${c.app.env.publicUrl}/${c.workspace.slug}/issue/${target.identifier}`,
        createdAt: comment.createdAt,
      };
    },
  };
}

/** The `tools/list` entries. */
export function mcpToolList() {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(mcpToolSchemas[t.name], { io: 'input' }),
    annotations: {
      title: t.title,
      readOnlyHint: t.readOnly,
      destructiveHint: false,
      idempotentHint: t.readOnly || t.name === 'update_issue',
      openWorldHint: false,
    },
  }));
}

export const isMcpTool = (name: unknown): name is McpToolName =>
  typeof name === 'string' && Object.hasOwn(mcpToolSchemas, name);

/** Validates the arguments and runs the tool. Throws HttpErrors for the agent to read. */
export async function callMcpTool(c: McpCaller, name: McpToolName, args: unknown) {
  const input = parse(mcpToolSchemas[name], args);
  const run = handlers(c)[name] as (a: unknown) => Promise<unknown>;
  return run(input);
}
