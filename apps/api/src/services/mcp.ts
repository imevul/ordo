import {
  type AgentRun,
  type CustomField,
  type CustomFieldValue,
  type Cycle,
  createCommentSchema,
  createCycleSchema,
  createIssueSchema,
  createMilestoneSchema,
  fieldsForTeam,
  type Issue,
  type IssueFilter,
  isCycleCurrent,
  MCP_TOOLS,
  type McpToolArgs,
  type McpToolName,
  type Milestone,
  mcpToolSchemas,
  type Project,
  priorityLabel,
  STATE_TYPES,
  type Team,
  updateCycleSchema,
  updateIssueSchema,
  updateMilestoneSchema,
} from '@ordo/shared';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema.ts';
import { badRequest, parse } from '../lib/errors.ts';
import type { Access } from './access.ts';
import {
  askQuestion,
  cancelRun,
  dismissRun,
  heldRuns,
  listRuns,
  listWorkspaceRuns,
  reportProgress,
  reportRun,
  requestRun,
  restartRun,
} from './agents.ts';
import { createComment, listComments } from './comments.ts';
import type { Ctx } from './context.ts';
import { listCustomFields } from './customFields.ts';
import { workspaceToday } from './cycle-automation.ts';
import { createCycle, listCycles, updateCycle } from './cycles.ts';
import { createIssue, getIssue, getIssueDetail, queryIssues, updateIssue } from './issues.ts';
import { listLabels } from './labels.ts';
import { createMilestone, listProjects, updateMilestone } from './projects.ts';
import { createRelation, deleteRelation } from './relations.ts';
import { listTeams } from './teams.ts';
import { listMembers } from './workspaces.ts';

/**
 * The tools behind the MCP endpoint. They call the same services as the REST API, with the
 * caller's access, and speak in names an agent can use: team keys, issue identifiers, status
 * and label names, usernames. Errors are thrown as HttpErrors and shown to the agent.
 */

export interface McpCaller {
  app: FastifyInstance;
  /** The key belongs to an agent: its own-run tools are available. */
  agent?: boolean;
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
  customFields = once(() => listCustomFields(this.db, this.c.access));
  projects = once(() => listProjects(this.db, this.c.access));
  cycles = once(() => listCycles(this.db, this.c.access));
  members = once(() => listMembers(this.db, this.c.access));
  /** "Today" as cycle automation sees it, so "current" means the same cycle everywhere. */
  today = once(() => workspaceToday(this.db, this.c.access.workspaceId));

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

  /**
   * The custom fields named in `refs`, among those of `team`'s issues, or among all fields the
   * caller sees. Names are unique within a team, so only a search across teams can be ambiguous.
   */
  async fieldsNamed(refs: string[], team?: Team): Promise<CustomField[]> {
    const all = await this.customFields();
    const usable = team ? fieldsForTeam(all, team.id) : all;
    return refs.map((ref) => {
      const matches = usable.filter((f) => f.id === ref || same(f.name, ref));
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1)
        throw badRequest(`Several teams have a field "${ref}"; say which team.`);
      throw badRequest(
        `Unknown custom field "${ref}"${team ? ` in ${team.key}` : ''}. Fields: ${usable.map((f) => f.name).join(', ') || 'none'}`,
      );
    });
  }

  option(field: CustomField, ref: string) {
    const o = field.options.find((o) => o.id === ref || same(o.name, ref));
    if (o) return o.id;
    throw badRequest(
      `Unknown option "${ref}" for ${field.name}. Options: ${field.options.map((o) => o.name).join(', ') || 'none'}`,
    );
  }

  /** A value as written by an agent (names, a person like `assignee`) as the API stores it. */
  async fieldValue(
    field: CustomField,
    raw: string | number | string[] | null,
  ): Promise<CustomFieldValue | null> {
    if (raw === null) return null;
    const wrong = (what: string) => badRequest(`${field.name}: ${what}`);
    switch (field.type) {
      case 'select':
        if (typeof raw !== 'string') throw wrong('expected one option name');
        return this.option(field, raw);
      case 'multi_select': {
        const refs = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
        if (!refs) throw wrong('expected a list of option names');
        return refs.map((r) => this.option(field, r));
      }
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        if (!Number.isFinite(n) || (typeof raw === 'string' && !raw.trim()))
          throw wrong('expected a number');
        return n;
      }
      case 'date':
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw))
          throw wrong('expected a date like 2026-01-31');
        return raw;
      case 'text':
        if (Array.isArray(raw)) throw wrong('expected text');
        return String(raw);
      case 'person':
        if (typeof raw !== 'string') throw wrong('expected a person');
        return this.person(raw);
    }
  }

  /** `customFields` of create_issue / update_issue, by field id, for an issue of `team`. */
  async fieldValues(values: Record<string, string | number | string[] | null>, team: Team) {
    const entries = Object.entries(values);
    const fields = await this.fieldsNamed(
      entries.map(([ref]) => ref),
      team,
    );
    const out: Record<string, CustomFieldValue | null> = {};
    for (const [i, [, raw]] of entries.entries())
      out[fields[i]!.id] = await this.fieldValue(fields[i]!, raw);
    return out;
  }

  /** search_issues' `customFields`: names and people to the ids `IssueFilter` matches on. */
  async fieldFilter(filters: Record<string, string[]>, team?: Team) {
    const entries = Object.entries(filters);
    const fields = await this.fieldsNamed(
      entries.map(([ref]) => ref),
      team,
    );
    const out: Record<string, string[]> = {};
    for (const [i, [, wanted]] of entries.entries()) {
      const field = fields[i]!;
      out[field.id] = await Promise.all(
        wanted.map(async (w) => {
          if (w === 'none') return 'none';
          const v = await this.fieldValue(field, w);
          return Array.isArray(v) ? v[0]! : String(v);
        }),
      );
    }
    return out;
  }

  async project(ref: string) {
    const projects = await this.projects();
    const p = projects.find((p) => p.id === ref || same(p.name, ref));
    if (p) return p;
    throw badRequest(`Unknown project "${ref}". Use list_projects to see them.`);
  }

  async milestone(project: Project, ref: string) {
    const m = project.milestones.find((m) => m.id === ref || same(m.name, ref));
    if (m) return m;
    throw badRequest(
      `Unknown milestone "${ref}" in ${project.name}. Milestones: ${project.milestones.map((m) => m.name).join(', ') || 'none'}`,
    );
  }

  /** Cycles matching `ref`: "current", a number, a name or an id, within one team or all. */
  async cycleIds(ref: string, teamId?: string): Promise<string[]> {
    const today = await this.today();
    const cycles = (await this.cycles()).filter((c) => !teamId || c.teamId === teamId);
    const match = (c: Cycle) =>
      ref === 'current'
        ? isCycleCurrent(c, today)
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
  const fields = list.some((i) => Object.keys(i.customFields).length)
    ? new Map((await dir.customFields()).map((f) => [f.id, f]))
    : new Map<string, CustomField>();
  const fieldPeople = list.flatMap((i) =>
    Object.entries(i.customFields)
      .filter(([id, v]) => fields.get(id)?.type === 'person' && typeof v === 'string')
      .map(([, v]) => v as string),
  );
  const [teams, labels, projects, cycles, people] = await Promise.all([
    dir.teams(),
    dir.labels(),
    dir.projects(),
    dir.cycles(),
    dir.people([...list.flatMap((i) => [i.assigneeId, i.creatorId]), ...fieldPeople]),
  ]);
  /** Values by field name, readable: option names, usernames. */
  const readable = (values: Issue['customFields']) => {
    const out: Record<string, CustomFieldValue> = {};
    for (const [id, v] of Object.entries(values)) {
      const f = fields.get(id);
      if (!f) continue;
      const optionName = (o: string) => f.options.find((x) => x.id === o)?.name ?? o;
      out[f.name] =
        f.type === 'select' && typeof v === 'string'
          ? optionName(v)
          : f.type === 'multi_select' && Array.isArray(v)
            ? v.map(optionName)
            : f.type === 'person' && typeof v === 'string'
              ? (people.get(v)?.username ?? v)
              : v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  return list.map((i) => {
    const team = teams.find((t) => t.id === i.teamId);
    const state = team?.states.find((s) => s.id === i.stateId);
    const cycle = cycles.find((x) => x.id === i.cycleId);
    const project = projects.find((p) => p.id === i.projectId);
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
      project: project?.name ?? null,
      milestone: project?.milestones.find((m) => m.id === i.milestoneId)?.name ?? null,
      cycle: cycle ? { number: cycle.number, name: cycle.name } : null,
      estimate: i.estimate,
      dueDate: i.dueDate,
      customFields: readable(i.customFields),
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
    links: detail.links.map((l) => ({
      title: l.title,
      url: l.url,
      kind: l.kind,
      state: l.state,
      ...(l.pullRequest && {
        repo: l.pullRequest.repo,
        number: l.pullRequest.number,
        branch: l.pullRequest.branch,
        checks: l.pullRequest.checks,
        review: l.pullRequest.review,
      }),
    })),
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

  /**
   * Issue fields shared by create and update, resolved within `team`. A milestone is looked up in
   * the project being set, else in `projectId` (the issue's own).
   */
  async function fields(
    args: McpToolArgs<'create_issue'> | McpToolArgs<'update_issue'>,
    team: Team,
    projectId: string | null = null,
  ) {
    const out: Record<string, unknown> = {};
    if (args.description !== undefined) out.description = args.description;
    if (args.status !== undefined) out.stateId = (await dir.status(team, args.status)).id;
    if (args.priority !== undefined) out.priority = priorityOf(args.priority);
    if (args.assignee !== undefined)
      out.assigneeId = args.assignee === null ? null : await dir.person(args.assignee);
    if (args.labels !== undefined) out.labelIds = await dir.labelIds(args.labels, team.id);
    const project = args.project ? await dir.project(args.project) : undefined;
    if (args.project !== undefined) out.projectId = project?.id ?? null;
    if (args.milestone === null) out.milestoneId = null;
    else if (args.milestone !== undefined) {
      const of = project ?? (projectId ? await dir.project(projectId) : undefined);
      if (!of) throw badRequest('Say which project the milestone is in (project).');
      out.milestoneId = (await dir.milestone(of, args.milestone)).id;
    }
    if (args.cycle !== undefined)
      out.cycleId = args.cycle === null ? null : await dir.cycle(args.cycle, team.id);
    if (args.parent !== undefined)
      out.parentId = args.parent === null ? null : await dir.issueId(args.parent);
    if (args.estimate !== undefined) out.estimate = args.estimate;
    if (args.dueDate !== undefined) out.dueDate = args.dueDate;
    if (args.customFields && Object.keys(args.customFields).length)
      out.customFields = await dir.fieldValues(args.customFields, team);
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
          // Assigning an issue to an agent hands it to the agent's runner.
          agent: m.kind === 'agent' || undefined,
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

    list_custom_fields: async ({ team }) => {
      const t = team ? await dir.team(team) : undefined;
      const teams = await dir.teams();
      const all = await dir.customFields();
      return (t ? fieldsForTeam(all, t.id) : all).map((f) => ({
        name: f.name,
        type: f.type,
        team: f.teamId ? (teams.find((x) => x.id === f.teamId)?.key ?? null) : null,
        description: f.description ?? undefined,
        options:
          f.type === 'select' || f.type === 'multi_select'
            ? f.options.map((o) => o.name)
            : undefined,
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
        milestones: p.milestones.map(milestoneResult),
      }));
    },

    list_cycles: async ({ team, includePast }) => {
      const teamId = team ? (await dir.team(team)).id : undefined;
      const today = await dir.today();
      const teams = await dir.teams();
      return (await dir.cycles())
        .filter((x) => (!teamId || x.teamId === teamId) && (includePast || x.endsAt > today))
        .map((x) =>
          cycleResult(
            teams.find((t) => t.id === x.teamId),
            x,
            today,
          ),
        );
    },

    create_cycle: async ({ team, ...input }) => {
      const t = await dir.team(team);
      const cycle = await c.run((ctx) => createCycle(ctx, t.id, parse(createCycleSchema, input)));
      return cycleResult(t, cycle, await dir.today());
    },

    update_cycle: async ({ team, cycle, ...input }) => {
      const t = await dir.team(team);
      const id = await dir.cycle(cycle, t.id);
      const patch = parse(updateCycleSchema, input);
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      const saved = await c.run((ctx) => updateCycle(ctx, id, patch));
      return cycleResult(t, saved, await dir.today());
    },

    create_milestone: async ({ project, ...input }) => {
      const p = await dir.project(project);
      const { milestone } = await c.run((ctx) =>
        createMilestone(ctx, p.id, parse(createMilestoneSchema, input)),
      );
      return { project: p.name, ...milestoneResult(milestone) };
    },

    update_milestone: async ({ project, milestone, ...input }) => {
      const p = await dir.project(project);
      const m = await dir.milestone(p, milestone);
      const patch = parse(updateMilestoneSchema, input);
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      const saved = await c.run((ctx) => updateMilestone(ctx, m.id, patch));
      return {
        project: p.name,
        ...milestoneResult(saved.milestones.find((x) => x.id === m.id)!),
      };
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
      if (a.customFields && Object.keys(a.customFields).length)
        filter.customFields = await dir.fieldFilter(a.customFields, team);
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
        ...(await fields(a, team, current.projectId)),
        ...(a.addLabels && { addLabelIds: await dir.labelIds(a.addLabels, team.id) }),
        ...(a.removeLabels && { removeLabelIds: await dir.labelIds(a.removeLabels, team.id) }),
      });
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      await c.run((ctx) => updateIssue(ctx, current.id, patch));
      return issueResult(c, dir, current.id, false);
    },

    list_agents: async () => {
      const teams = await dir.teams();
      return (await dir.members())
        .filter((m) => m.kind === 'agent' && !m.suspended)
        .map((m) => ({
          username: m.username,
          name: m.name,
          teams: teams.filter((t) => t.memberIds.includes(m.id)).map((t) => t.key),
          me: m.id === c.access.userId || undefined,
        }));
    },

    assign_to_agent: async ({ issue, agent, note }) => {
      const agentId = await dir.person(agent);
      const member = (await dir.members()).find((m) => m.id === agentId);
      if (member?.kind !== 'agent')
        throw badRequest(`${member?.name ?? agent} is a person, not an agent. See list_agents.`);
      const target = await getIssue(c.app.db, c.access, issue);
      await c.run(async (ctx) => {
        // The note first, so the run it queues already sees it.
        if (note) await createComment(ctx, target.id, { body: note });
        if (target.assigneeId === agentId) await requestRun(ctx, target.id);
        else await updateIssue(ctx, target.id, { assigneeId: agentId });
      });
      return agentRunsResult(c, dir, target.id);
    },

    agent_runs: async ({ issue }) => agentRunsResult(c, dir, issue),

    list_agent_runs: async ({ agent, status, limit }) => {
      const agentId = agent ? await dir.person(agent) : undefined;
      const runs = await listWorkspaceRuns(c.app.db, c.access, { status, agentId, limit });
      const names = await dir.people(runs.map((r) => r.agentId));
      return runs.map((r) => ({
        run: r.id,
        issue: r.issue.identifier,
        title: r.issue.title,
        agent: names.get(r.agentId) ?? null,
        status: r.status,
        trigger: r.trigger,
        runner: r.runnerName,
        question: r.status === 'waiting' ? r.question : undefined,
        failureReason: r.failureReason ?? undefined,
        error: r.status === 'failed' ? r.error?.slice(-500) : undefined,
        retryAt: r.retryAt ?? undefined,
        waitingOn: r.blockedBy.length ? r.blockedBy.map((b) => b.identifier) : undefined,
        sessionUrl: r.sessionUrl,
        usage: r.usage ?? undefined,
        updatedAt: r.finishedAt ?? r.startedAt ?? r.createdAt,
      }));
    },

    rerun_agent: async ({ issue, note }) => {
      const target = await getIssue(c.app.db, c.access, issue);
      await c.run(async (ctx) => {
        if (note) await createComment(ctx, target.id, { body: note });
        await requestRun(ctx, target.id);
      });
      return agentRunsResult(c, dir, target.id);
    },

    cancel_agent_run: async ({ issue }) => {
      const target = await getIssue(c.app.db, c.access, issue);
      const open = (await listRuns(c.app.db, c.access, target.id)).filter((r) =>
        ['queued', 'claimed', 'running'].includes(r.status),
      );
      if (!open.length) throw badRequest(`No agent is working on ${target.identifier}.`);
      await c.run(async (ctx) => {
        for (const r of open) await cancelRun(ctx, r.id);
      });
      return agentRunsResult(c, dir, target.id);
    },

    restart_agent_run: async (a) => {
      const runId = await finishedRun(c, dir, a);
      const saved = await c.run((ctx) => restartRun(ctx, runId));
      return { restarted: runId, ...(await agentRunsResult(c, dir, saved.issueId)) };
    },

    dismiss_agent_run: async (a) => {
      const runId = await finishedRun(c, dir, a);
      const saved = await c.run((ctx) => dismissRun(ctx, runId));
      return { dismissed: runId, ...(await agentRunsResult(c, dir, saved.issueId)) };
    },

    current_run: async () => {
      requireAgent(c);
      const runs = await heldRuns(c.app.db, c.access.userId);
      return Promise.all(
        runs.map(async (r) => {
          const i = await getIssue(c.app.db, c.access, r.issueId);
          return {
            run: r.id,
            issue: i.identifier,
            title: i.title,
            url: `${c.app.env.publicUrl}/${c.workspace.slug}/issue/${i.identifier}`,
            status: r.status,
            attempt: r.attempts,
            runner: r.runnerName,
            startedAt: r.startedAt,
            question: r.question,
          };
        }),
      );
    },

    report_run: async ({ run, ...report }) => {
      requireAgent(c);
      const runId = run ?? (await onlyHeldRun(c));
      if (!Object.values(report).some((v) => v !== undefined))
        throw badRequest('Nothing to report');
      const saved = await c.run((ctx) => reportRun(ctx, runId, report));
      return { run: saved.id, status: saved.status, sessionUrl: saved.sessionUrl };
    },

    report_progress: async ({ run, step, percent }) => {
      requireAgent(c);
      const runId = run ?? (await onlyHeldRun(c));
      const saved = await c.run((ctx) => reportProgress(ctx, runId, { step, percent }));
      return { run: saved.id, status: saved.status, progress: saved.progress };
    },

    ask_question: async ({ question, run }) => {
      requireAgent(c);
      const runId = run ?? (await onlyHeldRun(c));
      const saved = await c.run((ctx) => askQuestion(ctx, runId, question));
      return {
        run: saved.id,
        status: saved.status,
        next: 'Stop working now. The run resumes when someone replies on the issue.',
      };
    },

    add_relation: async ({ issue, type, other }) => {
      const target = await getIssue(c.app.db, c.access, issue);
      const related = await getIssue(c.app.db, c.access, other);
      await c.run((ctx) => createRelation(ctx, target.id, { type, relatedIssueId: related.id }));
      return relationsResult(c, target.id);
    },

    remove_relation: async ({ issue, other }) => {
      const detail = await getIssueDetail(c.app.db, c.access, issue);
      const related = await getIssue(c.app.db, c.access, other);
      const rel = detail.relations.find((r) => r.issue.id === related.id);
      if (!rel) throw badRequest(`${detail.identifier} has no relation to ${related.identifier}.`);
      await c.run((ctx) => deleteRelation(ctx, rel.id));
      return relationsResult(c, detail.id);
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

/** An issue's relations after a change, as get_issue shows them. */
async function relationsResult(c: McpReader, issueId: string) {
  const detail = await getIssueDetail(c.app.db, c.access, issueId);
  return {
    issue: detail.identifier,
    relations: detail.relations.map((r) => ({
      type: r.type,
      identifier: r.issue.identifier,
      title: r.issue.title,
    })),
  };
}

function cycleResult(team: Team | undefined, x: Cycle, today: string) {
  return {
    team: team?.key ?? null,
    number: x.number,
    name: x.name,
    startsAt: x.startsAt,
    endsAt: x.endsAt,
    current: isCycleCurrent(x, today),
    progress: x.progress,
  };
}

function milestoneResult(m: Milestone) {
  return {
    name: m.name,
    targetDate: m.targetDate,
    description: m.description,
    progress: m.progress,
  };
}

/** The caller's only held run, for tools that take `run` optionally. */
async function onlyHeldRun(c: McpCaller) {
  const held = await heldRuns(c.app.db, c.access.userId);
  if (held.length !== 1)
    throw badRequest(
      held.length
        ? `You hold ${held.length} runs; say which (see current_run).`
        : 'You hold no run right now.',
    );
  return held[0]!.id;
}

/**
 * The run restart_agent_run and dismiss_agent_run act on: `run` itself, or on the issue the latest
 * run of each agent (of `agent`, if given) that failed or was cancelled and isn't dismissed. An
 * agent whose latest run is active or succeeded has nothing to handle. When several agents
 * qualify, the caller has to name one.
 */
async function finishedRun(c: McpCaller, dir: Directory, a: McpToolArgs<'restart_agent_run'>) {
  if (a.run) return a.run;
  if (!a.issue) throw badRequest('Say which run: give issue (and agent), or run.');
  const issue = await getIssue(c.app.db, c.access, a.issue);
  const agentId = a.agent ? await dir.person(a.agent) : undefined;
  const latest = new Map<string, AgentRun>();
  // Newest first, so the first run seen per agent is its latest.
  for (const r of await listRuns(c.app.db, c.access, issue.id))
    if (!latest.has(r.agentId) && (!agentId || r.agentId === agentId)) latest.set(r.agentId, r);
  const candidates = [...latest.values()].filter(
    (r) => (r.status === 'failed' || r.status === 'cancelled') && !r.dismissedAt,
  );
  const [only] = candidates;
  if (!only)
    throw badRequest(
      `No failed or cancelled run${a.agent ? ` of ${a.agent}` : ''} on ${issue.identifier} to act on. See agent_runs.`,
    );
  if (candidates.length > 1) {
    const names = await dir.people(candidates.map((r) => r.agentId));
    throw badRequest(
      `Runs of several agents failed on ${issue.identifier} (${candidates.map((r) => names.get(r.agentId)?.username ?? r.agentId).join(', ')}); say which with agent, or give run.`,
    );
  }
  return only.id;
}

function requireAgent(c: McpCaller) {
  if (!c.agent) throw badRequest('Only an agent has runs; this key belongs to a person.');
}

/** An issue's runs, as an agent's or an assistant's caller reads them. */
async function agentRunsResult(c: McpReader, dir: Directory, ref: string) {
  const issue = await getIssue(c.app.db, c.access, ref);
  const runs = await listRuns(c.app.db, c.access, issue.id);
  const names = await dir.people(runs.map((r) => r.agentId));
  return {
    issue: issue.identifier,
    assignee:
      (issue.assigneeId && (await dir.people([issue.assigneeId])).get(issue.assigneeId)) || null,
    runs: runs.map((r) => ({
      run: r.id,
      agent: names.get(r.agentId) ?? null,
      status: r.status,
      runner: r.runnerName,
      attempt: r.attempts,
      sessionUrl: r.sessionUrl,
      trigger: r.trigger,
      question: r.question,
      summary: r.summary,
      error: r.error,
      failureReason: r.failureReason,
      retryAt: r.retryAt,
      retryOf: r.retryOfId ?? undefined,
      waitingOn: r.blockedBy.length ? r.blockedBy.map((b) => b.identifier) : undefined,
      dismissed: !!r.dismissedAt || undefined,
      usage: r.usage ?? undefined,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    })),
  };
}

/** The `tools/list` entries, without agent-only tools for people's keys. */
export function mcpToolList(agent = false) {
  return MCP_TOOLS.filter((t) => agent || t.audience !== 'agent').map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(mcpToolSchemas[t.name], { io: 'input' }),
    annotations: {
      title: t.title,
      readOnlyHint: t.readOnly,
      destructiveHint: false,
      idempotentHint: t.readOnly || t.name === 'update_issue' || t.name === 'cancel_agent_run',
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
