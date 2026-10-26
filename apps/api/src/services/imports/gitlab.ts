import type { ImportSourceProject, ImportSummary, StateType } from '@ordo/shared';
import { ApiCallError, trimUrl } from '../../integrations/http.ts';
import { type ForgeApi, forgeAll, forgeGet, labelKey } from './forge-api.ts';
import { importSecrets } from './secrets.ts';
import {
  ImportAbort,
  type ImportAdapter,
  type Page,
  type SourceComment,
  type SourceContext,
  type SourceIssue,
} from './types.ts';

/**
 * GitLab (gitlab.com or self-managed), read through REST API v4 with an access token (`read_api`
 * is enough). Each project is a source team; milestones become projects; comments are the issues'
 * notes, without GitLab's own system notes. People are usernames, matched to the ones members
 * claimed, then by name.
 */

interface GitlabProject {
  id: number;
  path: string;
  name: string;
}

interface GitlabConfig {
  baseUrl: string;
  projects: GitlabProject[];
}

interface GlUser {
  username: string;
  name?: string;
}

interface GlMilestone {
  id: number;
  title: string;
  description?: string | null;
  state: 'active' | 'closed';
  due_date: string | null;
}

interface GlIssue {
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  author: GlUser | null;
  assignee: GlUser | null;
  labels: string[];
  milestone: GlMilestone | null;
  user_notes_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  due_date: string | null;
  weight?: number | null;
  web_url: string;
}

interface GlNote {
  id: number;
  body: string;
  created_at: string;
  author: GlUser | null;
  system: boolean;
}

const STATUSES: Record<string, StateType> = { Open: 'unstarted', Closed: 'completed' };
const PER_PAGE = 'per_page=100';

const cfg = (sctx: SourceContext) => sctx.row.config as unknown as GitlabConfig;
const apiAt = (app: SourceContext['app'], baseUrl: string, token: string): ForgeApi => ({
  app,
  base: `${baseUrl}/api/v4`,
  headers: { 'private-token': token },
  name: 'GitLab',
});
const api = (sctx: SourceContext) =>
  apiAt(sctx.app, cfg(sctx).baseUrl, importSecrets<{ token: string }>(sctx).token);

const issuesPath = (p: GitlabProject) =>
  `/projects/${p.id}/issues?scope=all&state=all&order_by=created_at&sort=asc&${PER_PAGE}`;
const notesPath = (p: GitlabProject, iid: number) =>
  `/projects/${p.id}/issues/${iid}/notes?sort=asc&order_by=created_at&${PER_PAGE}`;
const username = (u: GlUser | null) => u?.username.toLowerCase();
const milestoneId = (p: GitlabProject, m: GlMilestone) => `${p.path}#m${m.id}`;

/** An issue's comments: its notes, minus "changed the label" and the like. */
async function notesOf(sctx: SourceContext, p: GitlabProject, i: GlIssue) {
  if (!i.user_notes_count) return [];
  return (await forgeAll<GlNote>(api(sctx), notesPath(p, i.iid))).filter((n) => !n.system);
}

function toIssue(p: GitlabProject, i: GlIssue): SourceIssue {
  const weight = i.weight ?? undefined;
  return {
    id: `${p.path}#${i.iid}`,
    ref: `${p.path}#${i.iid}`,
    teamId: p.path,
    number: i.iid,
    title: i.title,
    description: i.description || undefined,
    status: i.state === 'opened' ? 'Open' : 'Closed',
    assigneeId: username(i.assignee),
    creatorId: username(i.author),
    labelIds: [...new Set(i.labels.map(labelKey))],
    projectId: i.milestone ? milestoneId(p, i.milestone) : undefined,
    estimate: weight !== undefined && weight >= 0 && weight <= 100 ? weight : undefined,
    dueDate: i.due_date ?? undefined,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    completedAt: i.state === 'closed' ? (i.closed_at ?? undefined) : undefined,
    url: i.web_url,
  };
}

/** A page of one project's issues, going through the projects in turn. */
async function issuePage(sctx: SourceContext, cursor: string | null) {
  const { projects } = cfg(sctx);
  const [index, page] = cursor ? cursor.split(':').map(Number) : [0, 1];
  const project = projects[index!]!;
  const { data, more } = await forgeGet<GlIssue[]>(
    api(sctx),
    `${issuesPath(project)}&page=${page}`,
  );
  const next =
    more && data.length
      ? `${index}:${page! + 1}`
      : index! + 1 < projects.length
        ? `${index! + 1}:1`
        : null;
  return { project, issues: data, next };
}

export const gitlabSource: ImportAdapter = {
  key: 'gitlab',

  async start(app, input) {
    if (input.source !== 'gitlab') throw new Error('Not a GitLab import');
    const baseUrl = trimUrl(input.baseUrl);
    const projects: GitlabProject[] = [];
    for (const path of new Set(input.projects)) {
      try {
        const { data } = await forgeGet<{ id: number; path_with_namespace: string; name: string }>(
          apiAt(app, baseUrl, input.token),
          `/projects/${encodeURIComponent(path)}`,
        );
        projects.push({ id: data.id, path: data.path_with_namespace, name: data.name });
      } catch (err) {
        if (err instanceof ApiCallError && err.status === 404) {
          throw new ImportAbort(`Can't see ${path} with this token`);
        }
        throw err;
      }
    }
    const first = projects[0]!.path;
    return {
      name: `GitLab: ${first}${projects.length > 1 ? ` and ${projects.length - 1} more` : ''}`,
      config: { baseUrl, projects },
      secrets: { token: input.token },
    };
  },

  async analyze(sctx) {
    const { baseUrl, projects } = cfg(sctx);
    const host = new URL(baseUrl).host;
    const users = new Map<string, { name: string; count: number }>();
    const labels = new Map<string, { name: string; count: number }>();
    const summary: ImportSummary = {
      teams: [],
      users: [],
      labels: [],
      projects: [],
      counts: { issues: 0, comments: 0 },
      warnings: [],
    };
    const person = (u: GlUser | null) => {
      const id = username(u);
      if (!id) return;
      const entry = users.get(id) ?? { name: u!.name || u!.username, count: 0 };
      entry.count++;
      users.set(id, entry);
    };

    for (const p of projects) {
      for (const l of await forgeAll<{ name: string }>(
        api(sctx),
        `/projects/${p.id}/labels?${PER_PAGE}`,
      )) {
        const id = labelKey(l.name);
        if (!labels.has(id)) labels.set(id, { name: l.name, count: 0 });
      }
      const milestones = new Map<string, ImportSourceProject>();
      const addMilestone = (m: GlMilestone) => {
        const id = milestoneId(p, m);
        if (milestones.has(id)) return milestones.get(id)!;
        const project: ImportSourceProject = {
          id,
          name: m.title,
          count: 0,
          teamIds: [p.path],
          description: m.description ?? null,
          status: m.state === 'active' ? 'planned' : 'completed',
          targetDate: m.due_date,
        };
        milestones.set(id, project);
        return project;
      };
      for (const m of await forgeAll<GlMilestone>(
        api(sctx),
        `/projects/${p.id}/milestones?${PER_PAGE}`,
      )) {
        addMilestone(m);
      }

      const statuses = new Map<string, number>([
        ['Open', 0],
        ['Closed', 0],
      ]);
      let issueCount = 0;
      for (const i of await forgeAll<GlIssue>(api(sctx), issuesPath(p))) {
        issueCount++;
        const status = i.state === 'opened' ? 'Open' : 'Closed';
        statuses.set(status, statuses.get(status)! + 1);
        person(i.author);
        person(i.assignee);
        for (const name of i.labels) {
          const id = labelKey(name);
          const label = labels.get(id) ?? { name, count: 0 };
          label.count++;
          labels.set(id, label);
        }
        // Group milestones aren't in the project's list, but issues carry them.
        if (i.milestone) addMilestone(i.milestone).count++;
        // Commenters can be people who never opened or took an issue; they need mapping too.
        const notes = await notesOf(sctx, p, i);
        summary.counts.comments += notes.length;
        for (const n of notes) person(n.author);
      }
      summary.counts.issues += issueCount;
      summary.teams.push({
        id: p.path,
        name: p.name,
        key: null,
        issueCount,
        statuses: [...statuses].map(([name, n]) => ({ name, type: STATUSES[name]!, count: n })),
      });
      summary.projects.push(...milestones.values());
    }

    summary.users = [...users].map(([id, u]) => ({
      id,
      name: u.name,
      email: null,
      count: u.count,
      account: { provider: 'gitlab', host, login: id },
    }));
    summary.labels = [...labels].map(([id, l]) => ({ id, ...l }));
    return { summary };
  },

  async issues(sctx, cursor): Promise<Page<SourceIssue>> {
    const { project, issues, next } = await issuePage(sctx, cursor);
    return { items: issues.map((i) => toIssue(project, i)), next };
  },

  // GitLab's child tasks aren't in the issue list; nothing to link.
  children: async () => ({ items: [], next: null }),

  async comments(sctx, cursor): Promise<Page<SourceComment>> {
    const { project, issues, next } = await issuePage(sctx, cursor);
    const items: SourceComment[] = [];
    for (const i of issues) {
      for (const n of await notesOf(sctx, project, i)) {
        items.push({
          id: `${project.path}#n${n.id}`,
          issueId: `${project.path}#${i.iid}`,
          authorId: username(n.author),
          body: n.body,
          createdAt: n.created_at,
        });
      }
    }
    return { items, next };
  },
};
