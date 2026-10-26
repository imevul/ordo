import {
  type CreateIssueInput,
  IMPORT_BUSY,
  type Import,
  type ImportMapping,
  type ImportReport,
  type ImportSummary,
  LABEL_COLORS,
  SORT_GAP,
  STATE_TYPES,
  type StateType,
  TEAM_KEY_PATTERN,
} from '@ordo/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../../db/client.ts';
import {
  importItems,
  imports,
  issues,
  labels,
  projects,
  teams,
  users,
  workflowStates,
  workspaceMembers,
} from '../../db/schema.ts';
import { badRequest, HttpError } from '../../lib/errors.ts';
import { enqueue, type JobContext } from '../../lib/jobs/index.ts';
import { runInWorkspace } from '../../lib/mutate.ts';
import { usersWithTeamAccess } from '../access.ts';
import { audit } from '../audit.ts';
import { type Ctx, emit, type RequestMeta } from '../context.ts';
import { createIssue, type ImportedIssueFields, setImportedParent } from '../issues.ts';
import { createLabel } from '../labels.ts';
import { upsertIssueLink } from '../links.ts';
import { createPlaceholder } from '../placeholders.ts';
import { createProject } from '../projects.ts';
import { createTeam } from '../teams.ts';
import { csvSource } from './csv.ts';
import {
  ImportAbort,
  type ImportAdapter,
  type ImportRow,
  type SourceContext,
  type SourceIssue,
} from './types.ts';

/**
 * Runs imports. Analysis reads the source and suggests a mapping; a run (or dry run) then goes
 * through phases — setup (teams, labels, projects), issues, sub-issue links — a page per
 * transaction, saving its cursor with each page. Every created entity is recorded in
 * `import_items` under its source id, so a retried or resumed run skips what it already did.
 *
 * A dry run takes the same path without writing to the workspace. It notes the issues it would
 * create as PLANNED items (so sub-issue links can be checked), and removes them when it ends.
 */

const ADAPTERS: Record<string, ImportAdapter> = { csv: csvSource };
export const importAdapter = (source: string) => ADAPTERS[source];

/** How long one job works before handing over to the next, well inside the job lease. */
export const importLimits = { timeBudgetMs: 30_000 };
/** Skipped items and warnings listed in the report (all are counted). */
const MAX_LISTED = 200;
const PLANNED = '00000000-0000-0000-0000-000000000000';

type Phase = 'setup' | 'issues' | 'parents' | 'done';

interface Cursor {
  phase: Phase;
  page: string | null;
  /** Steps taken; keeps continuation jobs apart. */
  step: number;
  /** Items handled in the current phase. */
  done: number;
  /** Target teams that keep the source's issue numbers. */
  numberTeams: string[];
  /** Per target team: where imported issues start in the list, and how many are placed. */
  sort: Record<string, { base: number; next: number }>;
}

const newCursor = (): Cursor => ({
  phase: 'setup',
  page: null,
  step: 0,
  done: 0,
  numberTeams: [],
  sort: {},
});

const emptyReport = (dryRun: boolean): ImportReport => ({
  dryRun,
  created: { teams: 0, people: 0, labels: 0, projects: 0, issues: 0, comments: 0 },
  existing: 0,
  skipped: [],
  skippedCount: 0,
  warnings: [],
  warningCount: 0,
});

function skip(report: ImportReport, item: string | undefined, message: string) {
  report.skippedCount++;
  if (report.skipped.length < MAX_LISTED) report.skipped.push({ item, message });
}

function warn(report: ImportReport, item: string | undefined, message: string) {
  report.warningCount++;
  if (report.warnings.length < MAX_LISTED) report.warnings.push({ item, message });
}

const lower = (s: string) => s.trim().toLowerCase();
const isStateType = (v: string): v is StateType => (STATE_TYPES as readonly string[]).includes(v);

// ─── the workspace, as mapping needs it ───────────────────────────────────

async function workspaceData(db: DbOrTx, workspaceId: string) {
  const teamRows = await db
    .select({
      id: teams.id,
      key: teams.key,
      name: teams.name,
      defaultStateId: teams.defaultStateId,
    })
    .from(teams)
    .where(eq(teams.workspaceId, workspaceId));
  const states = teamRows.length
    ? await db
        .select({
          id: workflowStates.id,
          teamId: workflowStates.teamId,
          name: workflowStates.name,
          type: workflowStates.type,
        })
        .from(workflowStates)
        .where(
          inArray(
            workflowStates.teamId,
            teamRows.map((t) => t.id),
          ),
        )
        .orderBy(asc(workflowStates.position))
    : [];
  const members = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      email: users.email,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const labelRows = await db
    .select({ id: labels.id, name: labels.name, teamId: labels.teamId })
    .from(labels)
    .where(eq(labels.workspaceId, workspaceId));
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId));
  const placeholderRows = await db
    .select({ id: users.id, name: users.name, importedEmail: users.importedEmail })
    .from(users)
    .where(and(eq(users.kind, 'placeholder'), eq(users.botWorkspaceId, workspaceId)));
  return {
    teams: teamRows,
    states,
    members,
    placeholders: placeholderRows,
    labels: labelRows,
    projects: projectRows,
  };
}
type WorkspaceData = Awaited<ReturnType<typeof workspaceData>>;

/** A team key that's valid and not taken, as close to `seed` as possible. */
function freeKey(seed: string, used: Set<string>) {
  const clean = seed
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '');
  const base = (clean || 'IMP').slice(0, 4);
  const candidates = [
    clean.slice(0, 7),
    base,
    ...Array.from({ length: 98 }, (_, i) => `${base}${i + 2}`),
  ];
  const key =
    candidates.find((k) => TEAM_KEY_PATTERN.test(k) && !used.has(k)) ?? `I${Date.now() % 1e6}`;
  used.add(key);
  return key;
}

/**
 * The mapping analysis suggests: existing teams, people, labels and projects where the names (or
 * emails, or team keys) match, new ones otherwise. Choices from an earlier mapping are kept.
 */
export async function suggestMapping(
  db: DbOrTx,
  workspaceId: string,
  summary: ImportSummary,
  previous: ImportMapping | null,
): Promise<ImportMapping> {
  const data = await workspaceData(db, workspaceId);
  const usedKeys = new Set(data.teams.map((t) => t.key));
  const mapping: ImportMapping = {
    teams: {},
    statuses: {},
    users: {},
    labels: {},
    projects: {},
    keepNumbers: previous?.keepNumbers ?? true,
  };

  for (const t of summary.teams) {
    const existing =
      (t.key && data.teams.find((x) => x.key === t.key!.toUpperCase())) ||
      data.teams.find((x) => lower(x.name) === lower(t.name));
    mapping.teams[t.id] =
      previous?.teams[t.id] ??
      (existing
        ? { teamId: existing.id }
        : {
            create: {
              name: t.name.slice(0, 120) || 'Imported',
              key: freeKey(t.key ?? t.name, usedKeys),
            },
          });
    const target = mapping.teams[t.id]!;
    const states = 'teamId' in target ? data.states.filter((s) => s.teamId === target.teamId) : [];
    const team = 'teamId' in target ? data.teams.find((x) => x.id === target.teamId) : undefined;
    mapping.statuses[t.id] = {};
    for (const s of t.statuses) {
      const kept = previous?.statuses[t.id]?.[s.name];
      if (kept) {
        mapping.statuses[t.id]![s.name] = kept;
        continue;
      }
      if (!('teamId' in target)) {
        mapping.statuses[t.id]![s.name] = s.type ?? 'backlog';
        continue;
      }
      const match =
        states.find((x) => lower(x.name) === lower(s.name)) ??
        (s.type ? states.find((x) => x.type === s.type) : undefined);
      const fallback = team?.defaultStateId ?? states[0]?.id;
      const pick = match?.id ?? fallback;
      if (pick) mapping.statuses[t.id]![s.name] = pick;
    }
  }

  for (const u of summary.users) {
    if (previous && u.id in previous.users) {
      mapping.users[u.id] = previous.users[u.id]!;
      continue;
    }
    const match =
      (u.email && data.members.find((m) => lower(m.email) === lower(u.email!))) ||
      data.members.find(
        (m) => lower(m.name) === lower(u.name) || lower(m.username) === lower(u.name),
      );
    // Someone an earlier import already brought along keeps their placeholder.
    const earlier =
      (u.email &&
        data.placeholders.find(
          (p) => p.importedEmail && lower(p.importedEmail) === lower(u.email!),
        )) ||
      data.placeholders.find((p) => lower(p.name) === lower(u.name));
    mapping.users[u.id] = match?.id ?? earlier?.id ?? 'placeholder';
  }

  for (const l of summary.labels) {
    const match = data.labels.find((x) => !x.teamId && lower(x.name) === lower(l.name));
    mapping.labels[l.id] = previous?.labels[l.id] ?? match?.id ?? 'create';
  }
  for (const p of summary.projects) {
    const match = data.projects.find((x) => lower(x.name) === lower(p.name));
    mapping.projects[p.id] = previous?.projects[p.id] ?? match?.id ?? 'create';
  }
  return mapping;
}

/** Problems with a mapping that stop a run (things deleted since, keys taken, wrong teams). */
export async function mappingErrors(db: DbOrTx, row: ImportRow, mapping: ImportMapping) {
  const summary = row.summary!;
  const data = await workspaceData(db, row.workspaceId);
  const errors: string[] = [];
  const usedKeys = new Set(data.teams.map((t) => t.key));
  // Teams this import made on an earlier run are its own, not taken.
  const madeHere = new Set(
    (
      await db
        .select({ externalId: importItems.externalId })
        .from(importItems)
        .where(and(eq(importItems.importId, row.id), eq(importItems.kind, 'team')))
    ).map((r) => r.externalId),
  );
  for (const t of summary.teams) {
    const target = mapping.teams[t.id];
    if (!target) {
      errors.push(`Choose where the issues of ${t.name} go`);
      continue;
    }
    if ('teamId' in target && !data.teams.some((x) => x.id === target.teamId)) {
      errors.push(`The team chosen for ${t.name} no longer exists`);
    }
    if ('create' in target && !madeHere.has(t.id)) {
      if (usedKeys.has(target.create.key)) {
        errors.push(`The team key ${target.create.key} is already in use`);
      }
      usedKeys.add(target.create.key);
    }
    for (const [name, value] of Object.entries(mapping.statuses[t.id] ?? {})) {
      if (isStateType(value)) continue;
      const ok =
        'teamId' in target && data.states.some((s) => s.id === value && s.teamId === target.teamId);
      if (!ok) errors.push(`The status chosen for "${name}" isn't one of ${t.name}'s target team`);
    }
  }
  const people = new Set([...data.members, ...data.placeholders].map((m) => m.id));
  for (const u of summary.users) {
    const id = mapping.users[u.id];
    if (id && id !== 'placeholder' && !people.has(id)) {
      errors.push(`The person chosen for ${u.name} isn't a member`);
    }
  }
  const check = (kind: string, ids: Set<string>, values: Record<string, string>) => {
    for (const v of Object.values(values)) {
      if (v !== 'create' && v !== 'skip' && !ids.has(v)) {
        errors.push(`A ${kind} chosen in the mapping no longer exists`);
        return;
      }
    }
  };
  check('label', new Set(data.labels.map((l) => l.id)), mapping.labels);
  check('project', new Set(data.projects.map((p) => p.id)), mapping.projects);
  return errors;
}

// ─── starting, cancelling ─────────────────────────────────────────────────

function publish(app: FastifyInstance, row: { id: string; workspaceId: string }) {
  app.realtime.publish([
    { kind: 'import', action: 'updated', id: row.id, workspaceId: row.workspaceId },
  ]);
}

export async function startAnalysis(app: FastifyInstance, row: ImportRow) {
  await app.db
    .update(imports)
    .set({ status: 'analyzing', error: null, report: null, updatedAt: new Date().toISOString() })
    .where(eq(imports.id, row.id));
  await enqueue(
    app.db,
    'import.analyze',
    { importId: row.id },
    { orderingKey: `import:${row.id}` },
  );
  publish(app, row);
}

/** Starts a dry run or a run, after checking the mapping still fits the workspace. */
export async function startRun(
  app: FastifyInstance,
  row: ImportRow,
  opts: { dryRun: boolean; actorId: string; meta: RequestMeta | null },
) {
  if (!row.summary || !row.mapping) throw badRequest('The import has not been analyzed yet');
  const errors = await mappingErrors(app.db, row, row.mapping);
  if (errors.length) throw badRequest(errors.join('; '));
  await app.db.transaction(async (tx) => {
    await tx
      .delete(importItems)
      .where(and(eq(importItems.importId, row.id), eq(importItems.entityId, PLANNED)));
    await tx
      .update(imports)
      .set({
        status: opts.dryRun ? 'dry_running' : 'running',
        cursor: newCursor() as unknown as Record<string, unknown>,
        report: emptyReport(opts.dryRun),
        progress: { phase: 'setup', done: 0, total: row.summary!.counts.issues },
        error: null,
        ...(opts.dryRun ? {} : { startedAt: new Date().toISOString(), completedAt: null }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(imports.id, row.id));
    await enqueue(
      tx,
      'import.run',
      { importId: row.id, dryRun: opts.dryRun },
      { orderingKey: `import:${row.id}`, maxAttempts: 4 },
    );
    if (!opts.dryRun) {
      await audit(
        tx,
        {
          workspaceId: row.workspaceId,
          actorId: opts.actorId,
          action: 'import.started',
          targetType: 'import',
          targetId: row.id,
          data: { source: row.source, name: row.name },
        },
        opts.meta,
      );
    }
  });
  publish(app, row);
}

// ─── jobs ─────────────────────────────────────────────────────────────────

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

export async function runAnalyze(
  app: FastifyInstance,
  { importId }: { importId: string },
  job: JobContext,
) {
  const [row] = await app.db.select().from(imports).where(eq(imports.id, importId));
  if (row?.status !== 'analyzing') return;
  try {
    const adapter = importAdapter(row.source);
    if (!adapter) throw new ImportAbort(`Unknown source ${row.source}`);
    const { summary, config } = await adapter.analyze({ app, row, log: job.log });
    const mapping = await suggestMapping(app.db, row.workspaceId, summary, row.mapping);
    await app.db
      .update(imports)
      .set({
        status: 'ready',
        summary,
        mapping,
        config: config ?? row.config,
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(imports.id, row.id), eq(imports.status, 'analyzing')));
  } catch (err) {
    if (!(err instanceof ImportAbort) && job.attempt < job.maxAttempts) throw err;
    await app.db
      .update(imports)
      .set({ status: 'failed', error: message(err), updatedAt: new Date().toISOString() })
      .where(eq(imports.id, row.id));
  }
  publish(app, row);
}

export async function runImport(
  app: FastifyInstance,
  p: { importId: string; dryRun: boolean },
  job: JobContext,
) {
  const deadline = Date.now() + importLimits.timeBudgetMs;
  const busy = p.dryRun ? 'dry_running' : 'running';
  let row: ImportRow | undefined;
  try {
    for (;;) {
      [row] = await app.db.select().from(imports).where(eq(imports.id, p.importId));
      // Cancelled, deleted, or restarted as the other kind of run.
      if (!row || row.status !== busy) return;
      if (!row.createdById) throw new ImportAbort('The person who started this import was deleted');
      const cursor = await step(app, row, p.dryRun, job);
      if (cursor.phase === 'done') return;
      if (Date.now() > deadline) {
        await enqueue(app.db, 'import.run', p, {
          orderingKey: `import:${row.id}`,
          dedupeKey: `import:${row.id}:${cursor.step}`,
          maxAttempts: 4,
        });
        return;
      }
    }
  } catch (err) {
    if (!row) throw err;
    if (!(err instanceof ImportAbort) && job.attempt < job.maxAttempts) {
      // Shown while it retries.
      await app.db
        .update(imports)
        .set({ error: message(err) })
        .where(eq(imports.id, row.id));
      throw err;
    }
    await fail(app, row, p.dryRun, err);
  }
}

async function fail(app: FastifyInstance, row: ImportRow, dryRun: boolean, err: unknown) {
  await app.db.transaction(async (tx) => {
    await tx
      .delete(importItems)
      .where(and(eq(importItems.importId, row.id), eq(importItems.entityId, PLANNED)));
    await tx
      .update(imports)
      .set({ status: 'failed', error: message(err), updatedAt: new Date().toISOString() })
      .where(eq(imports.id, row.id));
    if (!dryRun) {
      await audit(tx, {
        workspaceId: row.workspaceId,
        actorId: row.createdById,
        action: 'import.failed',
        targetType: 'import',
        targetId: row.id,
        data: { source: row.source, error: message(err) },
      });
    }
  });
  publish(app, row);
}

// ─── a step: one phase, or one page of one ────────────────────────────────

interface RunState {
  row: ImportRow;
  summary: ImportSummary;
  mapping: ImportMapping;
  dryRun: boolean;
  cursor: Cursor;
  report: ImportReport;
  data: WorkspaceData;
  /** What earlier steps created, by kind and source id. */
  created: Record<'team' | 'user' | 'label' | 'project', Map<string, string>>;
  canAssign: Map<string, boolean>;
}

async function step(app: FastifyInstance, row: ImportRow, dryRun: boolean, job: JobContext) {
  const adapter = importAdapter(row.source)!;
  const sctx: SourceContext = { app, row, log: job.log };
  const cursor = { ...newCursor(), ...(row.cursor as Partial<Cursor> | null) };
  // Fetch before the transaction: sources can be slow.
  const page =
    cursor.phase === 'issues' || cursor.phase === 'parents'
      ? await adapter.issues(sctx, cursor.page)
      : null;

  const items = await app.db
    .select()
    .from(importItems)
    .where(
      and(
        eq(importItems.importId, row.id),
        inArray(importItems.kind, ['team', 'user', 'label', 'project']),
      ),
    );
  const created: RunState['created'] = {
    team: new Map(),
    user: new Map(),
    label: new Map(),
    project: new Map(),
  };
  for (const i of items) created[i.kind as keyof typeof created].set(i.externalId, i.entityId);

  const st: RunState = {
    row,
    summary: row.summary!,
    mapping: row.mapping!,
    dryRun,
    cursor,
    report: row.report ?? emptyReport(dryRun),
    data: await workspaceData(app.db, row.workspaceId),
    created,
    canAssign: new Map(),
  };

  await runInWorkspace(
    app,
    { workspaceId: row.workspaceId, actorId: row.createdById!, source: 'import', silent: true },
    async (ctx) => {
      if (cursor.phase === 'setup') {
        await setup(ctx, st);
        cursor.phase = 'issues';
      } else if (cursor.phase === 'issues') {
        await importIssues(ctx, st, page!.items);
        cursor.page = page!.next;
        if (!page!.next) Object.assign(cursor, { phase: 'parents', done: 0 });
      } else if (cursor.phase === 'parents') {
        await linkParents(ctx, st, page!.items);
        cursor.page = page!.next;
        if (!page!.next) cursor.phase = 'done';
      }
      cursor.step++;
      const done = cursor.phase === 'done';
      const now = new Date().toISOString();
      await ctx.tx
        .update(imports)
        .set({
          cursor: cursor as unknown as Record<string, unknown>,
          report: st.report,
          progress: { phase: cursor.phase, done: cursor.done, total: st.summary.counts.issues },
          updatedAt: now,
          ...(done && { status: dryRun ? 'ready' : 'completed', error: null }),
          ...(done && !dryRun && { completedAt: now }),
        })
        .where(eq(imports.id, row.id));
      if (done) await finish(ctx, st);
      emit(ctx, { kind: 'import', action: 'updated', id: row.id });
    },
  );
  return cursor;
}

async function finish(ctx: Ctx, st: RunState) {
  const { row, report } = st;
  if (st.dryRun) {
    await ctx.tx
      .delete(importItems)
      .where(and(eq(importItems.importId, row.id), eq(importItems.entityId, PLANNED)));
    return;
  }
  await audit(ctx.tx, {
    workspaceId: row.workspaceId,
    actorId: row.createdById,
    action: 'import.completed',
    targetType: 'import',
    targetId: row.id,
    data: {
      source: row.source,
      created: report.created,
      skipped: report.skippedCount,
      warnings: report.warningCount,
    },
  });
}

async function remember(
  ctx: Ctx,
  importId: string,
  kind: 'team' | 'user' | 'label' | 'project' | 'issue',
  externalId: string,
  entityId: string,
) {
  await ctx.tx.insert(importItems).values({ importId, kind, externalId, entityId });
}

/** The target team of a source team: an id, `new:<source id>` in a dry run, or null if skipped. */
function targetOf(st: RunState, sourceTeamId: string): string | null {
  const target = st.mapping.teams[sourceTeamId];
  if (!target || 'skip' in target) return null;
  if ('teamId' in target) return target.teamId;
  const created = st.created.team.get(sourceTeamId);
  if (created) return created;
  if (st.dryRun) return `new:${sourceTeamId}`;
  throw new ImportAbort(`The team for ${sourceTeamId} wasn't created`);
}

const isNewTeam = (st: RunState, target: string) =>
  target.startsWith('new:') || [...st.created.team.values()].includes(target);

async function setup(ctx: Ctx, st: RunState) {
  const { summary, mapping, report, row } = st;
  for (const t of summary.teams) {
    const target = mapping.teams[t.id];
    if (!target || !('create' in target) || st.created.team.has(t.id)) continue;
    report.created.teams++;
    if (st.dryRun) continue;
    const id = await createTeam(ctx, target.create);
    await remember(ctx, row.id, 'team', t.id, id);
    st.created.team.set(t.id, id);
  }

  for (const u of summary.users) {
    if (mapping.users[u.id] !== 'placeholder' || st.created.user.has(u.id)) continue;
    report.created.people++;
    if (st.dryRun) continue;
    const id = await createPlaceholder(ctx, { name: u.name, email: u.email });
    await remember(ctx, row.id, 'user', u.id, id);
    st.created.user.set(u.id, id);
  }

  const targets = new Map<string, number>();
  const sourcesPerTarget = new Map<string, number>();
  for (const t of summary.teams) {
    const target = targetOf(st, t.id);
    if (!target) continue;
    targets.set(target, (targets.get(target) ?? 0) + t.issueCount);
    sourcesPerTarget.set(target, (sourcesPerTarget.get(target) ?? 0) + 1);
  }
  const realTargets = [...targets.keys()].filter((t) => !t.startsWith('new:'));

  for (const [i, l] of summary.labels.entries()) {
    if (mapping.labels[l.id] !== 'create' || st.created.label.has(l.id)) continue;
    report.created.labels++;
    if (st.dryRun) continue;
    const label = await createLabel(ctx, {
      name: l.name.slice(0, 60),
      color: LABEL_COLORS[i % LABEL_COLORS.length]!,
      teamId: null,
    });
    await remember(ctx, row.id, 'label', l.id, label.id);
  }

  for (const p of summary.projects) {
    if (mapping.projects[p.id] !== 'create' || st.created.project.has(p.id)) continue;
    if (!targets.size) break;
    report.created.projects++;
    if (st.dryRun) continue;
    // Projects made by an import belong to every team it imports into.
    const id = await createProject(ctx, { name: p.name.slice(0, 120), teamIds: realTargets });
    await remember(ctx, row.id, 'project', p.id, id);
  }

  for (const [target, count] of targets) {
    const fresh = isNewTeam(st, target);
    const [{ issueCount, first }] = fresh
      ? [{ issueCount: 0, first: null }]
      : ((await ctx.tx
          .select({
            issueCount: sql<number>`count(*)::int`,
            first: sql<number | null>`min(${issues.sortOrder})`,
          })
          .from(issues)
          .where(eq(issues.teamId, target))) as [{ issueCount: number; first: number | null }]);
    // Imported issues go above the team's own, in source order.
    st.cursor.sort[target] = { base: (first ?? 0) - (count + 1) * SORT_GAP, next: 0 };
    if (mapping.keepNumbers && issueCount === 0 && sourcesPerTarget.get(target) === 1) {
      st.cursor.numberTeams.push(target);
    }
  }
}

async function assignable(ctx: Ctx, st: RunState, target: string, userId: string) {
  const key = `${target}:${userId}`;
  let ok = st.canAssign.get(key);
  // Placeholders can't see anything, but imports may assign them (merging fixes that up).
  const placeholder =
    st.data.placeholders.some((p) => p.id === userId) ||
    [...st.created.user.values()].includes(userId);
  if (placeholder) return true;
  if (ok === undefined) {
    ok = target.startsWith('new:')
      ? st.data.members.some((m) => m.id === userId && m.role !== 'guest')
      : (await usersWithTeamAccess(ctx.tx, ctx.workspaceId, target, [userId])).length > 0;
    st.canAssign.set(key, ok);
  }
  return ok;
}

/** The state an item lands in: the mapped one, else one of its status's guessed type. */
function stateFor(st: RunState, item: SourceIssue, target: string) {
  const value = item.status ? st.mapping.statuses[item.teamId]?.[item.status] : undefined;
  const states = st.data.states.filter((s) => s.teamId === target);
  if (!value) return undefined;
  if (isStateType(value)) return states.find((s) => s.type === value)?.id;
  return states.find((s) => s.id === value)?.id;
}

async function issueInput(ctx: Ctx, st: RunState, item: SourceIssue, target: string) {
  const { mapping, report, data } = st;
  const person = (id: string | undefined) => {
    const value = id ? mapping.users[id] : null;
    return value === 'placeholder' ? (st.created.user.get(id!) ?? null) : (value ?? null);
  };

  let assigneeId = person(item.assigneeId);
  if (assigneeId && !(await assignable(ctx, st, target, assigneeId))) {
    const name = data.members.find((m) => m.id === assigneeId)?.name ?? 'The assignee';
    warn(report, item.ref, `${name} can't see its team, so it's unassigned`);
    assigneeId = null;
  }

  const labelIds: string[] = [];
  for (const sourceId of item.labelIds ?? []) {
    const value = mapping.labels[sourceId];
    if (!value || value === 'skip') continue;
    if (value === 'create') {
      const id = st.created.label.get(sourceId);
      if (id) labelIds.push(id);
      continue;
    }
    const label = data.labels.find((l) => l.id === value);
    if (label?.teamId && label.teamId !== target) {
      warn(report, item.ref, `The label ${label.name} belongs to another team; left off`);
    } else if (label) labelIds.push(label.id);
  }

  const projectValue = item.projectId ? mapping.projects[item.projectId] : undefined;
  const projectId =
    projectValue === 'create'
      ? st.created.project.get(item.projectId!)
      : projectValue && projectValue !== 'skip'
        ? projectValue
        : undefined;

  let number: number | undefined;
  if (item.number && st.cursor.numberTeams.includes(target)) {
    const [taken] = target.startsWith('new:')
      ? []
      : await ctx.tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.teamId, target), eq(issues.number, item.number)));
    if (taken) warn(report, item.ref, `Number ${item.number} is taken; it gets a new one`);
    else number = item.number;
  }

  const sort = st.cursor.sort[target] ?? { base: 0, next: 0 };
  st.cursor.sort[target] = sort;
  const issue: CreateIssueInput = {
    teamId: target,
    title: item.title.slice(0, 500),
    description: item.description,
    stateId: stateFor(st, item, target),
    priority: item.priority,
    assigneeId,
    projectId,
    estimate: item.estimate,
    dueDate: item.dueDate,
    labelIds,
    sortOrder: sort.base + sort.next++ * SORT_GAP,
  };
  const imported: ImportedIssueFields = {
    creatorId: person(item.creatorId) ?? ctx.userId,
    number,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    canceledAt: item.canceledAt,
  };
  return { issue, imported };
}

async function importIssues(ctx: Ctx, st: RunState, items: SourceIssue[]) {
  const { row, report } = st;
  const ids = items.map((i) => i.id);
  const already = new Set(
    ids.length
      ? (
          await ctx.tx
            .select({ externalId: importItems.externalId })
            .from(importItems)
            .where(
              and(
                eq(importItems.importId, row.id),
                eq(importItems.kind, 'issue'),
                inArray(importItems.externalId, ids),
              ),
            )
        ).map((r) => r.externalId)
      : [],
  );

  for (const item of items) {
    st.cursor.done++;
    if (already.has(item.id)) {
      report.existing++;
      continue;
    }
    for (const w of item.warnings ?? []) warn(report, item.ref, w);
    const target = targetOf(st, item.teamId);
    if (!target) {
      skip(report, item.ref, 'Its team is skipped');
      continue;
    }
    if (!item.title) {
      skip(report, item.ref, 'It has no title');
      continue;
    }
    const input = await issueInput(ctx, st, item, target);
    if (st.dryRun) {
      report.created.issues++;
      await remember(ctx, row.id, 'issue', item.id, PLANNED);
      continue;
    }
    try {
      // A savepoint per issue: one that's refused doesn't undo the page.
      await ctx.tx.transaction(async (tx) => {
        const sub: Ctx = { ...ctx, tx };
        const issue = await createIssue(sub, input.issue, input.imported);
        if (item.url) {
          await upsertIssueLink(sub, {
            issueId: issue.id,
            provider: row.source,
            kind: 'link',
            externalId: item.id,
            url: item.url,
            title: `${item.ref} (imported)`,
          });
        }
        await remember(sub, row.id, 'issue', item.id, issue.id);
      });
      report.created.issues++;
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode >= 500) throw err;
      skip(report, item.ref, err.message);
    }
  }
}

async function linkParents(ctx: Ctx, st: RunState, items: SourceIssue[]) {
  const { row, report } = st;
  const children = items.filter((i) => i.parentId);
  st.cursor.done += items.length;
  if (!children.length) return;
  const wanted = [...new Set(children.flatMap((i) => [i.id, i.parentId!]))];
  const rows = await ctx.tx
    .select({ externalId: importItems.externalId, entityId: importItems.entityId })
    .from(importItems)
    .where(
      and(
        eq(importItems.importId, row.id),
        eq(importItems.kind, 'issue'),
        inArray(importItems.externalId, wanted),
      ),
    );
  const byId = new Map(rows.map((r) => [r.externalId, r.entityId]));
  for (const item of children) {
    const child = byId.get(item.id);
    const parent = byId.get(item.parentId!);
    if (!child) continue;
    if (!parent) {
      warn(report, item.ref, `Its parent ${item.parentId} isn't part of the import`);
      continue;
    }
    if (st.dryRun || child === PLANNED) continue;
    try {
      await ctx.tx.transaction((tx) => setImportedParent({ ...ctx, tx }, child, parent));
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode >= 500) throw err;
      warn(report, item.ref, `Not made a sub-issue: ${err.message}`);
    }
  }
}

// ─── serialization ────────────────────────────────────────────────────────

export async function listImports(db: DbOrTx, workspaceId: string, id?: string): Promise<Import[]> {
  const rows = await db
    .select({ row: imports, creator: { id: users.id, name: users.name } })
    .from(imports)
    .leftJoin(users, eq(users.id, imports.createdById))
    .where(and(eq(imports.workspaceId, workspaceId), id ? eq(imports.id, id) : undefined))
    .orderBy(sql`${imports.createdAt} desc`)
    .limit(50);
  return rows.map(({ row, creator }) => ({
    id: row.id,
    source: row.source,
    name: row.name,
    status: row.status,
    config: row.config,
    summary: row.summary,
    mapping: row.mapping,
    report: row.report,
    progress: row.progress,
    error: row.error,
    createdBy: creator?.id ? creator : null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));
}

/** Whether a job is working on the import (it can't be changed, started again or deleted). */
export const isBusy = (row: ImportRow) => IMPORT_BUSY.includes(row.status);
