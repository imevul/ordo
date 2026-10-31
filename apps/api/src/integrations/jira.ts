import {
  guessStateType,
  type JiraConfig,
  type JiraProjectMap,
  jiraSettingsSchema,
  parsePriority,
  type StateType,
} from '@ordo/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  integrationRefs,
  issueLinks,
  issues,
  teams,
  users,
  workflowStates,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { usersWithTeamAccess } from '../services/access.ts';
import { createComment } from '../services/comments.ts';
import type { Ctx } from '../services/context.ts';
import {
  authorization,
  isEpic,
  type JiraComment,
  type JiraIssue,
  type JiraUser,
  date as jiraDate,
  stateType as jiraStateType,
} from '../services/imports/jira.ts';
import { jiraToMarkdown, markdownToJira } from '../services/imports/jira-markup.ts';
import { createIssue, updateIssue } from '../services/issues.ts';
import { upsertIssueLink } from '../services/links.ts';
import { ApiCallError, callApi, hmacHex, safeEqual } from './http.ts';
import {
  configOf,
  type IntegrationContext,
  type IntegrationProvider,
  type IntegrationRow,
} from './types.ts';

/**
 * Jira, Cloud or Data Center, through REST API v2. One integration, three modes:
 *
 * - links: Jira keys and URLs in Ordo issues and comments become links that show the Jira status,
 *   and Jira gets a link back; Ordo URLs in Jira issues link the other way.
 * - mirror: Jira is the source of truth. Issues of mapped projects appear in their Ordo team and
 *   follow Jira (title, description, status, priority, assignee, comments). Ordo writes nothing.
 * - sync: the same both ways. Ordo changes to synced issues (and new issues in mapped teams, if
 *   chosen) go to Jira.
 *
 * Every synced issue keeps the Jira values as of its last sync (`integration_refs.data`). Only
 * fields that differ from that snapshot are applied, on either side, so a change made by Ordo
 * that comes back from Jira is recognised and nothing bounces. Webhooks are only a hint: Ordo
 * re-reads the issue from Jira, so a forged delivery can at most cause a refresh.
 */

interface JiraState {
  self?: { id: string; name: string };
  priorities?: { name: string; value: number }[];
  /** Keys of every project the token can see (links mode recognises their issue keys). */
  projectKeys?: string[];
  polledAt?: string;
  /** Ordo email → Jira account (accountId on Cloud, username on Data Center), or null if none. */
  people?: Record<string, string | null>;
}

/** The Jira values of a synced issue as of the last sync. */
interface Snapshot {
  key: string;
  summary: string;
  description: string;
  status: string;
  priority: string | null;
  assignee: string | null;
  updated: string;
}

const cfg = configOf<JiraConfig>();
const stateOf = (row: IntegrationRow) => row.state as JiraState;
const FIELDS = 'summary,description,status,priority,assignee,creator,issuetype,parent,updated';
const MAX_POLL = 1000;

// ─── the API ──────────────────────────────────────────────────────────────

async function jira<T>(
  ictx: IntegrationContext,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { data } = await callApi<T>(ictx.app, `${cfg(ictx.integration).siteUrl}${path}`, {
    ...opts,
    headers: {
      authorization: authorization({ token: ictx.secrets.token!, email: ictx.secrets.email }),
    },
    timeoutMs: 30_000,
  });
  return data;
}

/** An issue by id or key; null when it's gone or out of reach. */
async function getIssue(ictx: IntegrationContext, idOrKey: string) {
  try {
    return await jira<JiraIssue>(
      ictx,
      `/rest/api/2/issue/${encodeURIComponent(idOrKey)}?fields=${FIELDS}`,
    );
  } catch (err) {
    if (err instanceof ApiCallError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/** Issues matching `jql`, at most `limit`, through Cloud's token paging or Data Center's offsets. */
async function search(ictx: IntegrationContext, jql: string, limit = MAX_POLL) {
  const out: JiraIssue[] = [];
  const { cloud } = cfg(ictx.integration);
  let next: string | null = null;
  do {
    const q = new URLSearchParams({ jql, maxResults: '100', fields: FIELDS });
    if (cloud) {
      if (next) q.set('nextPageToken', next);
      const res = await jira<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(
        ictx,
        `/rest/api/2/search/jql?${q}`,
      );
      out.push(...res.issues);
      next = res.isLast || !res.nextPageToken ? null : res.nextPageToken;
    } else {
      const start = out.length;
      q.set('startAt', String(start));
      const res = await jira<{ issues: JiraIssue[]; total: number }>(
        ictx,
        `/rest/api/2/search?${q}`,
      );
      out.push(...res.issues);
      next = res.issues.length && out.length < res.total ? String(out.length) : null;
    }
  } while (next && out.length < limit);
  return out.slice(0, limit);
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\r\n?/g, '\n').trim();
const accountOf = (u: JiraUser | null | undefined) =>
  u ? (u.accountId ?? u.name ?? u.key ?? null) : null;

function snapshotOf(i: JiraIssue): Snapshot {
  const f = i.fields;
  return {
    key: i.key,
    summary: f.summary,
    description: norm(f.description),
    status: f.status.name,
    priority: f.priority?.name ?? null,
    assignee: accountOf(f.assignee),
    updated: f.updated,
  };
}

const browseUrl = (ictx: IntegrationContext, key: string) =>
  `${cfg(ictx.integration).siteUrl}/browse/${key}`;
const projectKeyOf = (key: string) => key.slice(0, key.lastIndexOf('-'));
const projectFor = (ictx: IntegrationContext, key: string) =>
  cfg(ictx.integration).projects.find((p) => p.key === projectKeyOf(key));

// ─── refs: which Jira issue is which Ordo issue ───────────────────────────

type Ref = typeof integrationRefs.$inferSelect;

async function refBy(
  ictx: IntegrationContext,
  kind: 'issue' | 'comment',
  side: 'externalId' | 'localId',
  value: string,
): Promise<Ref | null> {
  const [row] = await ictx.app.db
    .select()
    .from(integrationRefs)
    .where(
      and(
        eq(integrationRefs.integrationId, ictx.integration.id),
        eq(integrationRefs.kind, kind),
        eq(integrationRefs[side], value),
      ),
    );
  return row ?? null;
}

async function saveRef(
  db: Ctx['tx'],
  ictx: IntegrationContext,
  kind: 'issue' | 'comment',
  externalId: string,
  localId: string,
  data: Record<string, unknown>,
) {
  await db
    .insert(integrationRefs)
    .values({ integrationId: ictx.integration.id, kind, externalId, localId, data })
    .onConflictDoUpdate({
      target: [integrationRefs.integrationId, integrationRefs.kind, integrationRefs.externalId],
      set: { localId, data, updatedAt: new Date().toISOString() },
    });
}

// ─── Ordo issues as Jira sees them ────────────────────────────────────────

async function ordoIssue(ictx: IntegrationContext, id: string) {
  const [row] = await ictx.app.db
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      priority: issues.priority,
      teamId: issues.teamId,
      number: issues.number,
      key: teams.key,
      slug: workspaces.slug,
      state: workflowStates.name,
      stateType: workflowStates.type,
      assigneeEmail: users.email,
      deletedAt: issues.deletedAt,
    })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(workspaces, eq(workspaces.id, issues.workspaceId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .leftJoin(users, eq(users.id, issues.assigneeId))
    .where(and(eq(issues.id, id), eq(issues.workspaceId, ictx.integration.workspaceId)));
  if (!row) return null;
  const identifier = `${row.key}-${row.number}`;
  return { ...row, identifier, url: `${ictx.app.env.publicUrl}/${row.slug}/issue/${identifier}` };
}

/** "See it in Ordo" on the Jira issue. Idempotent (one link per Ordo issue); failures don't matter. */
async function backlink(ictx: IntegrationContext, jiraKey: string, ordoIssueId: string) {
  if (!cfg(ictx.integration).backlinks) return;
  const issue = await ordoIssue(ictx, ordoIssueId);
  if (!issue) return;
  await jira(ictx, `/rest/api/2/issue/${jiraKey}/remotelink`, {
    method: 'POST',
    body: {
      globalId: `ordo-issue:${issue.id}`,
      application: { type: 'ordo', name: 'Ordo' },
      object: { url: issue.url, title: `${issue.identifier} ${issue.title}` },
    },
  }).catch((err) => ictx.log.info({ err, jiraKey }, 'could not add the Ordo link to Jira'));
}

/** The link on an Ordo issue that shows a Jira issue and its status. */
function linkJira(ctx: Ctx, ictx: IntegrationContext, ordoIssueId: string, i: JiraIssue) {
  return upsertIssueLink(ctx, {
    issueId: ordoIssueId,
    provider: 'jira',
    kind: 'external_issue',
    externalId: i.id,
    url: browseUrl(ictx, i.key),
    title: `${i.key} ${i.fields.summary}`,
    state: i.fields.status.name,
    data: { key: i.key, category: i.fields.status.statusCategory?.key ?? null },
    integrationId: ictx.integration.id,
  });
}

// ─── people ───────────────────────────────────────────────────────────────

/**
 * The workspace member behind a Jira user: by email, else (with `byName`) by a unique name.
 * Undefined if unknown. Names are good enough to pick an assignee, not to sign someone's comment.
 */
async function memberFor(
  ictx: IntegrationContext,
  u: JiraUser | null | undefined,
  { byName = true } = {},
) {
  if (!u) return null;
  const members = await ictx.app.db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, ictx.integration.workspaceId),
        eq(users.kind, 'human'),
        isNull(users.disabledAt),
      ),
    );
  if (u.emailAddress) {
    const match = members.find((m) => m.email.toLowerCase() === u.emailAddress!.toLowerCase());
    if (match) return match.id;
  }
  if (!byName) return undefined;
  const named = members.filter((m) => m.name === u.displayName);
  return named.length === 1 ? named[0]!.id : undefined;
}

/** The Jira account of an Ordo user, found by email and remembered. Undefined if none. */
async function jiraAccountFor(ictx: IntegrationContext, userId: string) {
  const [u] = await ictx.app.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return undefined;
  const email = u.email.toLowerCase();
  const people = stateOf(ictx.integration).people ?? {};
  if (!(email in people)) {
    const param = cfg(ictx.integration).cloud ? 'query' : 'username';
    const found = await jira<JiraUser[]>(
      ictx,
      `/rest/api/2/user/search?${param}=${encodeURIComponent(email)}`,
    ).catch(() => [] as JiraUser[]);
    const exact = found.filter((f) => f.emailAddress?.toLowerCase() === email);
    const pick = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined;
    people[email] = accountOf(pick);
    await ictx.saveState({ people });
  }
  return people[email] ?? undefined;
}

const assigneeField = (ictx: IntegrationContext, account: string | null) =>
  account === null
    ? null
    : cfg(ictx.integration).cloud
      ? { accountId: account }
      : { name: account };

// ─── statuses and priorities ──────────────────────────────────────────────

async function stateForStatus(ctx: Ctx, teamId: string, status: JiraIssue['fields']['status']) {
  const states = await ctx.tx
    .select({ id: workflowStates.id, name: workflowStates.name, type: workflowStates.type })
    .from(workflowStates)
    .where(eq(workflowStates.teamId, teamId))
    .orderBy(asc(workflowStates.position));
  const byName = states.find((s) => s.name.toLowerCase() === status.name.toLowerCase());
  if (byName) return byName.id;
  const type = jiraStateType(status);
  return states.find((s) => s.type === type)?.id;
}

const CATEGORY_FOR: Record<StateType, string> = {
  triage: 'new',
  backlog: 'new',
  unstarted: 'new',
  started: 'indeterminate',
  completed: 'done',
  canceled: 'done',
};

/** Moves a Jira issue to the status matching an Ordo state, if a transition gets there. */
async function transitionTo(
  ictx: IntegrationContext,
  key: string,
  state: { name: string; type: StateType },
) {
  const { transitions } = await jira<{
    transitions: { id: string; to: { name: string; statusCategory?: { key: string } } }[];
  }>(ictx, `/rest/api/2/issue/${key}/transitions`);
  const pick =
    transitions.find((t) => t.to.name.toLowerCase() === state.name.toLowerCase()) ??
    transitions.find((t) => guessStateType(t.to.name) === state.type) ??
    transitions.find((t) => t.to.statusCategory?.key === CATEGORY_FOR[state.type]);
  if (!pick) return;
  await jira(ictx, `/rest/api/2/issue/${key}/transitions`, {
    method: 'POST',
    body: { transition: { id: pick.id } },
  });
}

const priorityName = (ictx: IntegrationContext, value: number) =>
  value ? stateOf(ictx.integration).priorities?.find((p) => p.value === value)?.name : undefined;

// ─── Jira → Ordo ──────────────────────────────────────────────────────────

/** Brings Ordo up to date with one Jira issue: links always; fields and comments when synced. */
async function pullIssue(ictx: IntegrationContext, i: JiraIssue) {
  await refreshLinks(ictx, i);
  await linkOrdoMentions(ictx, i);
  const { mode } = cfg(ictx.integration);
  if (mode === 'links') return;
  const project = projectFor(ictx, i.key);
  if (!project?.teamId) return;

  let ref = await refBy(ictx, 'issue', 'externalId', i.id);
  if (!ref) {
    const adopted = await importedIssue(ictx, i.key);
    if (adopted) {
      await saveRef(ictx.app.db, ictx, 'issue', i.id, adopted, {});
      ref = await refBy(ictx, 'issue', 'externalId', i.id);
    } else if (project.createInOrdo && !isEpic(i.fields.issuetype) && !createdBySelf(ictx, i)) {
      await createFromJira(ictx, i, project.teamId);
      return;
    } else return;
  }
  await applyFromJira(ictx, ref!, i);
}

/**
 * Jira issues Ordo created itself (pushCreate). Outbound and inbound work run concurrently, so
 * Jira's webhook for such an issue can arrive before pushCreate has saved the ref; it isn't new.
 */
function createdBySelf(ictx: IntegrationContext, i: JiraIssue) {
  const self = stateOf(ictx.integration).self?.id;
  return !!self && accountOf(i.fields.creator) === self;
}

/** An Ordo issue the Jira importer brought in from this key (its link says so). */
async function importedIssue(ictx: IntegrationContext, key: string) {
  const [row] = await ictx.app.db
    .select({ issueId: issueLinks.issueId })
    .from(issueLinks)
    .innerJoin(issues, eq(issues.id, issueLinks.issueId))
    .where(
      and(
        eq(issueLinks.workspaceId, ictx.integration.workspaceId),
        eq(issueLinks.provider, 'jira'),
        eq(issueLinks.kind, 'link'),
        eq(issueLinks.externalId, key),
        isNull(issues.deletedAt),
      ),
    );
  if (!row) return null;
  // Already synced by another integration? Then not ours to take.
  const [taken] = await ictx.app.db
    .select({ id: integrationRefs.id })
    .from(integrationRefs)
    .where(and(eq(integrationRefs.kind, 'issue'), eq(integrationRefs.localId, row.issueId)));
  return taken ? null : row.issueId;
}

async function assignable(ctx: Ctx, teamId: string, userId: string | null | undefined) {
  if (!userId) return userId;
  const ok = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, teamId, [userId]);
  return ok.length ? userId : undefined;
}

async function createFromJira(ictx: IntegrationContext, i: JiraIssue, teamId: string) {
  const f = i.fields;
  const assignee = await memberFor(ictx, f.assignee);
  const parent =
    f.parent && !isEpic(f.parent.fields?.issuetype)
      ? await refBy(ictx, 'issue', 'externalId', (await getIssue(ictx, f.parent.key))?.id ?? '')
      : null;
  const ordoId = await ictx.run(async (ctx) => {
    const issue = await createIssue(ctx, {
      teamId,
      title: f.summary.slice(0, 500),
      description: f.description ? jiraToMarkdown(f.description) : undefined,
      stateId: await stateForStatus(ctx, teamId, f.status),
      priority: f.priority ? (parsePriority(f.priority.name) ?? undefined) : undefined,
      assigneeId: (await assignable(ctx, teamId, assignee)) ?? undefined,
      parentId: parent?.localId,
    });
    await linkJira(ctx, ictx, issue.id, i);
    await saveRef(ctx.tx, ictx, 'issue', i.id, issue.id, { snapshot: snapshotOf(i) });
    return issue.id;
  });
  await backlink(ictx, i.key, ordoId);
  // Only comments from here on: the issue's history stays in Jira.
}

async function applyFromJira(ictx: IntegrationContext, ref: Ref, i: JiraIssue) {
  const before = ref.data.snapshot as Snapshot | undefined;
  const now = snapshotOf(i);
  const f = i.fields;
  const changed = (field: keyof Snapshot) => !before || before[field] !== now[field];
  const assignee = changed('assignee') ? await memberFor(ictx, f.assignee) : undefined;
  await ictx.run(async (ctx) => {
    const [current] = await ctx.tx
      .select({ teamId: issues.teamId })
      .from(issues)
      .where(eq(issues.id, ref.localId));
    if (!current) return;
    const patch: Parameters<typeof updateIssue>[2] = {};
    if (changed('summary')) patch.title = now.summary.slice(0, 500);
    if (changed('description')) patch.description = jiraToMarkdown(f.description ?? '');
    if (changed('status')) {
      const stateId = await stateForStatus(ctx, current.teamId, f.status);
      if (stateId) patch.stateId = stateId;
    }
    if (changed('priority') && f.priority) {
      const value = parsePriority(f.priority.name);
      if (value !== null) patch.priority = value;
    }
    if (changed('assignee') && assignee !== undefined) {
      const ok = await assignable(ctx, current.teamId, assignee);
      if (ok !== undefined) patch.assigneeId = ok;
    }
    if (Object.keys(patch).length) await updateIssue(ctx, ref.localId, patch);
    await linkJira(ctx, ictx, ref.localId, i);
    await saveRef(ctx.tx, ictx, 'issue', i.id, ref.localId, { ...ref.data, snapshot: now });
  });
  if (!before) await backlink(ictx, i.key, ref.localId);
  if (changed('updated')) await pullComments(ictx, ref, i);
}

/** Jira comments not yet in Ordo, written since the issue was paired, except Ordo's own. */
async function pullComments(ictx: IntegrationContext, ref: Ref, i: JiraIssue) {
  const { comments: list } = await jira<{ comments: JiraComment[] }>(
    ictx,
    `/rest/api/2/issue/${i.id}/comment?maxResults=100&orderBy=-created`,
  );
  const self = stateOf(ictx.integration).self?.id;
  const since = Date.parse(ref.createdAt);
  for (const c of list.reverse()) {
    const created = Date.parse(jiraDate(c.created) ?? '');
    if (accountOf(c.author) === self || !(created >= since)) continue;
    if (await refBy(ictx, 'comment', 'externalId', c.id)) continue;
    const author = await memberFor(ictx, c.author, { byName: false });
    await ictx.run(async (ctx) => {
      const body = jiraToMarkdown(c.body);
      const comment = author
        ? await createComment(ctx, ref.localId, { body }, { authorId: author })
        : await createComment(ctx, ref.localId, {
            body: `**${c.author?.displayName ?? 'Someone'}** in Jira:\n\n${body}`,
          });
      await saveRef(ctx.tx, ictx, 'comment', c.id, comment.id, {});
    });
  }
}

/** Every Ordo link to this Jira issue shows its current title and status. */
async function refreshLinks(ictx: IntegrationContext, i: JiraIssue) {
  const linked = await ictx.app.db
    .select({ issueId: issueLinks.issueId })
    .from(issueLinks)
    .where(
      and(
        eq(issueLinks.workspaceId, ictx.integration.workspaceId),
        eq(issueLinks.provider, 'jira'),
        eq(issueLinks.kind, 'external_issue'),
        eq(issueLinks.externalId, i.id),
      ),
    );
  if (!linked.length) return;
  await ictx.run(async (ctx) => {
    for (const l of linked) await linkJira(ctx, ictx, l.issueId, i);
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ordo issue URLs in a Jira issue's text link that Ordo issue to it. */
async function linkOrdoMentions(ictx: IntegrationContext, i: JiraIssue) {
  const [ws] = await ictx.app.db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, ictx.integration.workspaceId));
  const re = new RegExp(
    `${escapeRe(`${ictx.app.env.publicUrl}/${ws!.slug}/issue/`)}([A-Za-z][A-Za-z0-9]*)-(\\d+)`,
    'g',
  );
  const text = `${i.fields.summary}\n${i.fields.description ?? ''}`;
  const found = [...text.matchAll(re)].slice(0, 10);
  if (!found.length) return;
  const ids: string[] = [];
  for (const [, key, n] of found) {
    const [row] = await ictx.app.db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(
        and(
          eq(issues.workspaceId, ictx.integration.workspaceId),
          eq(teams.key, key!.toUpperCase()),
          eq(issues.number, Number(n)),
        ),
      );
    if (row) ids.push(row.id);
  }
  if (!ids.length) return;
  await ictx.run(async (ctx) => {
    for (const id of ids) await linkJira(ctx, ictx, id, i);
  });
}

// ─── Ordo → Jira ──────────────────────────────────────────────────────────

/** Jira keys and browse URLs in Ordo text: links (every mode). */
async function linkJiraMentions(ictx: IntegrationContext, ordoIssueId: string, text: string) {
  if (!text) return;
  const c = cfg(ictx.integration);
  const keys = new Set<string>();
  for (const m of text.matchAll(
    new RegExp(`${escapeRe(c.siteUrl)}/browse/([A-Z][A-Z0-9_]*-\\d+)`, 'g'),
  ))
    keys.add(m[1]!);
  // Bare keys only for known Jira projects, and never ones that are also Ordo team keys.
  const known = new Set(
    c.projects.length
      ? c.projects.map((p) => p.key)
      : (stateOf(ictx.integration).projectKeys ?? []),
  );
  const bare = [...text.matchAll(/(?<![\w/-])([A-Z][A-Z0-9_]*)-(\d+)(?![\w-])/g)].filter((m) =>
    known.has(m[1]!),
  );
  if (bare.length) {
    const ordoKeys = new Set(
      (
        await ictx.app.db
          .select({ key: teams.key })
          .from(teams)
          .where(eq(teams.workspaceId, ictx.integration.workspaceId))
      ).map((t) => t.key),
    );
    for (const m of bare) if (!ordoKeys.has(m[1]!)) keys.add(m[0]);
  }
  for (const key of [...keys].slice(0, 10)) {
    const i = await getIssue(ictx, key);
    if (!i) continue;
    await ictx.run((ctx) => linkJira(ctx, ictx, ordoIssueId, i));
    await backlink(ictx, i.key, ordoIssueId);
  }
}

async function pushCreate(ictx: IntegrationContext, ordoId: string, project: JiraProjectMap) {
  const issue = await ordoIssue(ictx, ordoId);
  if (!issue || (await refBy(ictx, 'issue', 'localId', ordoId))) return;
  const created = await jira<{ id: string; key: string }>(ictx, '/rest/api/2/issue', {
    method: 'POST',
    body: {
      fields: {
        project: { key: project.key },
        summary: issue.title,
        description: markdownToJira(issue.description ?? ''),
        issuetype: { name: project.issueType },
      },
    },
  });
  await pushFields(ictx, created.key, ordoId, ['priority', 'assignee', 'state']);
  const fresh = await getIssue(ictx, created.id);
  if (!fresh) return;
  await ictx.run(async (ctx) => {
    await linkJira(ctx, ictx, ordoId, fresh);
    await saveRef(ctx.tx, ictx, 'issue', fresh.id, ordoId, { snapshot: snapshotOf(fresh) });
  });
  await backlink(ictx, fresh.key, ordoId);
}

type PushField = 'title' | 'description' | 'priority' | 'assignee' | 'state';

/** Writes Ordo's current values of `fields` to the Jira issue. Fields Jira refuses are skipped. */
async function pushFields(
  ictx: IntegrationContext,
  key: string,
  ordoId: string,
  fields: PushField[],
) {
  const issue = await ordoIssue(ictx, ordoId);
  if (!issue) return;
  const set: Record<string, unknown> = {};
  if (fields.includes('title')) set.summary = issue.title;
  if (fields.includes('description')) set.description = markdownToJira(issue.description ?? '');
  const optional: Record<string, unknown> = {};
  if (fields.includes('priority')) {
    const name = priorityName(ictx, issue.priority);
    if (name) optional.priority = { name };
  }
  if (fields.includes('assignee')) {
    if (!issue.assigneeEmail) optional.assignee = null;
    else {
      const [u] = await ictx.app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, issue.assigneeEmail));
      const account = u ? await jiraAccountFor(ictx, u.id) : undefined;
      if (account) optional.assignee = assigneeField(ictx, account);
    }
  }
  const put = (body: Record<string, unknown>) =>
    jira(ictx, `/rest/api/2/issue/${key}`, { method: 'PUT', body: { fields: body } });
  if (Object.keys(set).length) await put(set);
  // Priority and assignee aren't on every screen; one refused doesn't stop the rest.
  for (const [field, value] of Object.entries(optional)) {
    await put({ [field]: value }).catch((err) => {
      if (!(err instanceof ApiCallError) || err.status !== 400) throw err;
      ictx.log.info({ err, key, field }, 'Jira refused a field');
    });
  }
  if (fields.includes('state'))
    await transitionTo(ictx, key, { name: issue.state, type: issue.stateType });
}

const PUSHED: Record<string, PushField> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  assignee: 'assignee',
  state: 'state',
};

async function pushUpdate(ictx: IntegrationContext, ref: Ref, changed: string[]) {
  const fields = [...new Set(changed.map((c) => PUSHED[c]).filter((f): f is PushField => !!f))];
  if (!fields.length) return;
  const snapshot = ref.data.snapshot as Snapshot | undefined;
  const key = snapshot?.key ?? ref.externalId;
  await pushFields(ictx, key, ref.localId, fields);
  // What Jira now holds is the new baseline: its webhook for this change then finds nothing new.
  const fresh = await getIssue(ictx, ref.externalId);
  if (fresh)
    await saveRef(ictx.app.db, ictx, 'issue', fresh.id, ref.localId, {
      ...ref.data,
      snapshot: snapshotOf(fresh),
    });
}

async function pushComment(
  ictx: IntegrationContext,
  ref: Ref,
  comment: { id: string; body: string; authorId: string | null },
) {
  if (await refBy(ictx, 'comment', 'localId', comment.id)) return;
  const [author] = comment.authorId
    ? await ictx.app.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, comment.authorId))
    : [];
  const created = await jira<{ id: string }>(ictx, `/rest/api/2/issue/${ref.externalId}/comment`, {
    method: 'POST',
    body: { body: `*${author?.name ?? 'Someone'}* in Ordo:\n\n${markdownToJira(comment.body)}` },
  });
  await saveRef(ictx.app.db, ictx, 'comment', created.id, comment.id, {});
}

// ─── the provider ─────────────────────────────────────────────────────────

export const jiraProvider: IntegrationProvider = {
  key: 'jira',
  name: 'Jira',
  description:
    'Link Jira issues, mirror Jira projects into teams, or keep issues in sync both ways.',
  category: 'tracker',

  settings: jiraSettingsSchema,

  async install(ictx) {
    const me = await jira<JiraUser>(ictx, '/rest/api/2/myself');
    const visible = await jira<{ key: string }[]>(ictx, '/rest/api/2/project');
    for (const p of cfg(ictx.integration).projects) {
      if (!visible.some((v) => v.key === p.key))
        throw new Error(`Can't see the Jira project ${p.key} with this token`);
    }
    // Teams must belong to this workspace.
    const teamIds = cfg(ictx.integration)
      .projects.map((p) => p.teamId)
      .filter((t): t is string => !!t);
    if (teamIds.length) {
      const found = await ictx.app.db
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(eq(teams.workspaceId, ictx.integration.workspaceId), inArray(teams.id, teamIds)),
        );
      if (found.length !== new Set(teamIds).size) throw new Error('A mapped team no longer exists');
    }
    const priorities = await jira<{ name: string }[]>(ictx, '/rest/api/2/priority').catch(() => []);
    await ictx.saveState({
      self: { id: accountOf(me) ?? '', name: me.displayName },
      projectKeys: visible.map((v) => v.key),
      priorities: priorities.flatMap((p) => {
        const value = parsePriority(p.name);
        return value ? [{ name: p.name, value }] : [];
      }),
      polledAt: stateOf(ictx.integration).polledAt ?? new Date().toISOString(),
    });
  },

  verify(req, _row, secrets) {
    const signature = req.headers['x-hub-signature'];
    // With a secret set in Ordo, only signed deliveries count. Without, deliveries are only a hint
    // to re-read an issue from Jira, so the unguessable URL is enough.
    if (secrets.webhookSecret) {
      return safeEqual(signature, `sha256=${hmacHex(secrets.webhookSecret, req.body)}`);
    }
    return true;
  },

  deliveryId: (req) => req.headers['x-atlassian-webhook-identifier'] ?? null,

  async handleInbound(ictx, req) {
    const body = JSON.parse(req.body) as {
      webhookEvent?: string;
      issue?: { id?: string; key?: string };
    };
    const id = body.issue?.id ?? body.issue?.key;
    if (!id) return;
    if (body.webhookEvent === 'jira:issue_deleted') {
      await ictx.app.db
        .update(issueLinks)
        .set({ state: 'Deleted in Jira', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(issueLinks.workspaceId, ictx.integration.workspaceId),
            eq(issueLinks.provider, 'jira'),
            eq(issueLinks.externalId, String(body.issue?.id ?? '')),
          ),
        );
      return;
    }
    const issue = await getIssue(ictx, String(id));
    if (issue) await pullIssue(ictx, issue);
  },

  async onDomainEvent(ictx, event) {
    const { mode } = cfg(ictx.integration);
    const data = event.data as {
      id?: string;
      teamId?: string;
      description?: string;
      comment?: { id: string; body: string; authorId: string | null; issueId: string };
      issue?: { id: string };
    };
    if (event.type === 'issue.created' && data.id) {
      await linkJiraMentions(ictx, data.id, data.description ?? '');
      const project = cfg(ictx.integration).projects.find(
        (p) => p.teamId === data.teamId && p.createInJira,
      );
      if (mode === 'sync' && project) await pushCreate(ictx, data.id, project);
    } else if (event.type === 'issue.updated' && data.id) {
      const fields = (event.changes ?? []).map((c) => c.field);
      if (fields.includes('description'))
        await linkJiraMentions(ictx, data.id, data.description ?? '');
      if (mode !== 'sync') return;
      const ref = await refBy(ictx, 'issue', 'localId', data.id);
      if (ref) await pushUpdate(ictx, ref, fields);
    } else if (event.type === 'comment.created' && data.comment) {
      const issueId = data.issue?.id ?? data.comment.issueId;
      await linkJiraMentions(ictx, issueId, data.comment.body);
      if (mode !== 'sync') return;
      const ref = await refBy(ictx, 'issue', 'localId', issueId);
      if (ref) await pushComment(ictx, ref, data.comment);
    }
  },

  pollIntervalSeconds: 120,

  async poll(ictx) {
    const c = cfg(ictx.integration);
    if (c.delivery !== 'poll') return;
    const since = stateOf(ictx.integration).polledAt;
    const startedAt = new Date().toISOString();
    // Relative JQL dates sidestep the Jira user's time zone; a couple of minutes' overlap is
    // harmless (unchanged issues don't change anything).
    const minutes = since
      ? Math.min(7 * 24 * 60, Math.ceil((Date.now() - Date.parse(since)) / 60_000) + 2)
      : 10;
    const keys = c.projects.map((p) => `"${p.key}"`);
    const jql = `${keys.length ? `project in (${keys.join(', ')}) AND ` : ''}updated >= -${minutes}m ORDER BY updated ASC`;
    for (const issue of await search(ictx, jql)) await pullIssue(ictx, issue);
    await ictx.saveState({ polledAt: startedAt });
  },
};
