import {
  type CreateTimeEntryInput,
  canonicalTimeZone,
  type IssueTime,
  MAX_TIME_ENTRY_SECONDS,
  type RunningTimer,
  type TimeEntry,
  type TimeReport,
  type TimeReportEntry,
  type TimeReportQuery,
  toCsv,
  type UpdateTimeEntryInput,
} from '@ordo/shared';
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { cycles, issues, projects, teams, timeEntries, users, workspaces } from '../db/schema.ts';
import { conflict, forbidden, HttpError, isUniqueViolation, notFound, one } from '../lib/errors.ts';
import { type Access, teamScope } from './access.ts';
import { auditCtx } from './audit.ts';
import { type Ctx, emit, record } from './context.ts';
import { getIssue } from './issues.ts';
import { workspaceSettings } from './workspaces.ts';

/**
 * Time tracking: people log time on issues they can see, by hand or with a timer. It's off until a
 * workspace admin turns it on. People change and delete their own entries; workspace admins can
 * correct anyone's (audited, since reports are used for invoicing).
 */

type Row = typeof timeEntries.$inferSelect;

export const toTimeEntry = (r: Row): TimeEntry => ({
  id: r.id,
  issueId: r.issueId,
  userId: r.userId,
  startedAt: r.startedAt,
  durationSeconds: r.durationSeconds,
  note: r.note,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

async function settingsOf(db: DbOrTx, workspaceId: string) {
  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return workspaceSettings({ settings: ws?.settings ?? null });
}

export async function assertTimeTracking(db: DbOrTx, workspaceId: string) {
  if (!(await settingsOf(db, workspaceId)).timeTracking)
    throw forbidden('Time tracking is off in this workspace').as('time_tracking_off');
}

const issueRef = (issue: { id: string; identifier: string; title: string }) => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
});

function changed(
  ctx: Ctx,
  entry: TimeEntry,
  issue: { teamId: string } & Parameters<typeof issueRef>[0],
  action: 'created' | 'updated' | 'deleted',
) {
  emit(ctx, { kind: 'timeEntry', action, id: entry.id, issueId: issue.id, teamId: issue.teamId });
  record(
    ctx,
    `time_entry.${action}`,
    { timeEntry: entry, issue: issueRef(issue) },
    {
      teamIds: [issue.teamId],
    },
  );
}

/** Everything logged on an issue the caller can read (guests: only their own), newest first. */
export async function issueTime(db: DbOrTx, access: Access, ref: string): Promise<IssueTime> {
  await assertTimeTracking(db, access.workspaceId);
  const issue = await getIssue(db, access, ref);
  const rows = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.issueId, issue.id),
        access.isGuest ? eq(timeEntries.userId, access.userId) : undefined,
      ),
    )
    .orderBy(desc(timeEntries.startedAt), desc(timeEntries.createdAt));
  const entries = rows.map(toTimeEntry);
  return { entries, totalSeconds: entries.reduce((n, e) => n + (e.durationSeconds ?? 0), 0) };
}

export async function logTime(ctx: Ctx, ref: string, input: CreateTimeEntryInput) {
  await assertTimeTracking(ctx.tx, ctx.workspaceId);
  const issue = await getIssue(ctx.tx, ctx.access, ref);
  const startedAt =
    input.startedAt !== undefined
      ? new Date(input.startedAt).toISOString()
      : new Date(Date.now() - input.durationSeconds * 1000).toISOString();
  const entry = toTimeEntry(
    one(
      await ctx.tx
        .insert(timeEntries)
        .values({
          workspaceId: ctx.workspaceId,
          issueId: issue.id,
          userId: ctx.userId,
          startedAt,
          durationSeconds: input.durationSeconds,
          note: input.note ?? '',
        })
        .returning(),
    ),
  );
  changed(ctx, entry, issue, 'created');
  return entry;
}

async function runningRow(db: DbOrTx, workspaceId: string, userId: string) {
  const [row] = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        eq(timeEntries.userId, userId),
        isNull(timeEntries.durationSeconds),
      ),
    )
    .for('update');
  return row;
}

/** Ends a running timer now, keeping at least a second (and at most the longest entry). */
async function finish(ctx: Ctx, row: Row) {
  const elapsed = Math.round((Date.now() - new Date(row.startedAt).getTime()) / 1000);
  const [saved] = await ctx.tx
    .update(timeEntries)
    .set({
      durationSeconds: Math.min(Math.max(elapsed, 1), MAX_TIME_ENTRY_SECONDS),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(timeEntries.id, row.id))
    .returning();
  const entry = toTimeEntry(saved!);
  const issue = await issueOf(ctx.tx, row.issueId);
  if (issue) changed(ctx, entry, issue, 'updated');
  return entry;
}

/** The issue an entry is on, whoever may see it (for events about one's own entries). */
async function issueOf(db: DbOrTx, issueId: string) {
  const [row] = await db
    .select({
      id: issues.id,
      number: issues.number,
      title: issues.title,
      teamId: issues.teamId,
      key: teams.key,
    })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(eq(issues.id, issueId));
  return row && { ...row, identifier: `${row.key}-${row.number}` };
}

/** Starts the caller's timer on an issue; a timer already running elsewhere stops first. */
export async function startTimer(ctx: Ctx, ref: string, note = '') {
  await assertTimeTracking(ctx.tx, ctx.workspaceId);
  const issue = await getIssue(ctx.tx, ctx.access, ref);
  const running = await runningRow(ctx.tx, ctx.workspaceId, ctx.userId);
  if (running) await finish(ctx, running);
  // Two starts at once both find no running row to lock; the unique index stops the second.
  const rows = await ctx.tx
    .insert(timeEntries)
    .values({
      workspaceId: ctx.workspaceId,
      issueId: issue.id,
      userId: ctx.userId,
      startedAt: new Date().toISOString(),
      note,
    })
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err))
        throw conflict('Your timer was just started elsewhere; try again').as('timer_conflict');
      throw err;
    });
  const entry = toTimeEntry(one(rows));
  changed(ctx, entry, issue, 'created');
  return entry;
}

export async function stopTimer(ctx: Ctx) {
  await assertTimeTracking(ctx.tx, ctx.workspaceId);
  const running = await runningRow(ctx.tx, ctx.workspaceId, ctx.userId);
  if (!running) throw new HttpError(404, 'No timer is running', 'not_found').as('no_timer');
  return finish(ctx, running);
}

/** The caller's running timer, or null; its issue as far as the caller can still see it. */
export async function runningTimer(db: DbOrTx, access: Access): Promise<RunningTimer | null> {
  await assertTimeTracking(db, access.workspaceId);
  const [row] = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, access.workspaceId),
        eq(timeEntries.userId, access.userId),
        isNull(timeEntries.durationSeconds),
      ),
    );
  if (!row) return null;
  const issue = await getIssue(db, access, row.issueId).catch(() => null);
  return {
    entry: toTimeEntry(row),
    issue: issue ? issueRef(issue) : { id: row.issueId, identifier: '', title: '' },
  };
}

/** An entry the caller may change: their own, or anyone's for workspace admins. */
async function loadOwn(ctx: Ctx, id: string, verb: 'change' | 'delete') {
  await assertTimeTracking(ctx.tx, ctx.workspaceId);
  const [row] = await ctx.tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.id, id), eq(timeEntries.workspaceId, ctx.workspaceId)));
  if (!row) throw notFound('Time entry');
  const issue = await getIssue(ctx.tx, ctx.access, row.issueId).catch(() => {
    throw notFound('Time entry');
  });
  const own = row.userId === ctx.userId;
  if (!own && !ctx.access.isAdmin)
    throw forbidden(`You can only ${verb} your own time entries`).as('own_time_entries');
  return { row, issue, own };
}

export async function updateTimeEntry(ctx: Ctx, id: string, input: UpdateTimeEntryInput) {
  const { row, issue, own } = await loadOwn(ctx, id, 'change');
  const [saved] = await ctx.tx
    .update(timeEntries)
    .set({
      durationSeconds: input.durationSeconds,
      startedAt: input.startedAt && new Date(input.startedAt).toISOString(),
      note: input.note,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(timeEntries.id, id))
    .returning();
  const entry = toTimeEntry(saved!);
  if (!own)
    await auditCtx(ctx, {
      action: 'time_entry.updated',
      targetType: 'time_entry',
      targetId: id,
      data: { issue: issue.identifier, userId: row.userId, before: toTimeEntry(row), after: entry },
    });
  changed(ctx, entry, issue, 'updated');
  return entry;
}

export async function deleteTimeEntry(ctx: Ctx, id: string) {
  const { row, issue, own } = await loadOwn(ctx, id, 'delete');
  await ctx.tx.delete(timeEntries).where(eq(timeEntries.id, id));
  const entry = toTimeEntry(row);
  if (!own)
    await auditCtx(ctx, {
      action: 'time_entry.deleted',
      targetType: 'time_entry',
      targetId: id,
      data: { issue: issue.identifier, entry },
    });
  changed(ctx, entry, issue, 'deleted');
}

/**
 * Finished entries on issues the caller can read (guests: only their own), filtered by person,
 * team, project, cycle and an inclusive range of days in the workspace's time zone.
 */
export async function timeReport(
  db: DbOrTx,
  access: Access,
  q: Omit<TimeReportQuery, 'format'>,
): Promise<TimeReport> {
  const settings = await settingsOf(db, access.workspaceId);
  if (!settings.timeTracking)
    throw forbidden('Time tracking is off in this workspace').as('time_tracking_off');
  // Postgres only gets canonical names: it reads offsets like "+01:00" the other way round.
  const zone = canonicalTimeZone(settings.timezone ?? '') ?? 'UTC';
  const day = sql<string>`to_char(${timeEntries.startedAt} at time zone ${zone}, 'YYYY-MM-DD')`;
  const where: (SQL | undefined)[] = [
    eq(timeEntries.workspaceId, access.workspaceId),
    sql`${timeEntries.durationSeconds} is not null`,
    isNull(issues.deletedAt),
    teamScope(access, issues.teamId),
    access.isGuest ? eq(timeEntries.userId, access.userId) : undefined,
    q.userId ? eq(timeEntries.userId, q.userId) : undefined,
    q.teamId ? eq(issues.teamId, q.teamId) : undefined,
    q.projectId === 'none'
      ? isNull(issues.projectId)
      : q.projectId
        ? eq(issues.projectId, q.projectId)
        : undefined,
    q.cycleId ? eq(issues.cycleId, q.cycleId) : undefined,
    q.from ? sql`${day} >= ${q.from}` : undefined,
    q.to ? sql`${day} <= ${q.to}` : undefined,
  ];
  const rows = await db
    .select({
      entry: timeEntries,
      date: day,
      issue: {
        id: issues.id,
        number: issues.number,
        title: issues.title,
        teamId: issues.teamId,
        projectId: issues.projectId,
        cycleId: issues.cycleId,
      },
      teamKey: teams.key,
    })
    .from(timeEntries)
    .innerJoin(issues, eq(issues.id, timeEntries.issueId))
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(and(...where))
    .orderBy(asc(timeEntries.startedAt), asc(timeEntries.createdAt))
    .limit(50_000);
  const entries: TimeReportEntry[] = rows.map(({ entry, date, issue, teamKey }) => ({
    ...toTimeEntry(entry),
    durationSeconds: entry.durationSeconds!,
    date,
    issue: {
      id: issue.id,
      identifier: `${teamKey}-${issue.number}`,
      title: issue.title,
      teamId: issue.teamId,
      projectId: issue.projectId,
      cycleId: issue.cycleId,
    },
  }));
  const sum = <K extends string | null>(key: (e: TimeReportEntry) => K) => {
    const totals = new Map<K, number>();
    for (const e of entries) totals.set(key(e), (totals.get(key(e)) ?? 0) + e.durationSeconds);
    return [...totals].sort((a, b) => b[1] - a[1]);
  };
  return {
    entries,
    totalSeconds: entries.reduce((n, e) => n + e.durationSeconds, 0),
    byUser: sum((e) => e.userId).map(([userId, seconds]) => ({ userId, seconds })),
    byProject: sum((e) => e.issue.projectId).map(([projectId, seconds]) => ({
      projectId,
      seconds,
    })),
  };
}

/** The report as a spreadsheet: one row per entry, hours as a decimal for invoicing. */
export async function timeReportCsv(db: DbOrTx, report: TimeReport) {
  const ids = (pick: (e: TimeReportEntry) => string | null) => [
    ...new Set(report.entries.map(pick).filter((v): v is string => !!v)),
  ];
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  // Drizzle turns an empty `inArray` into `false`, so no ids means no rows.
  const [people, projectRows, cycleRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(
        inArray(
          users.id,
          ids((e) => e.userId),
        ),
      )
      .then(byId),
    db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        inArray(
          projects.id,
          ids((e) => e.issue.projectId),
        ),
      )
      .then(byId),
    db
      .select({ id: cycles.id, name: cycles.name, number: cycles.number })
      .from(cycles)
      .where(
        inArray(
          cycles.id,
          ids((e) => e.issue.cycleId),
        ),
      )
      .then(byId),
  ]);
  const header = [
    'Date',
    'Person',
    'Email',
    'Issue',
    'Title',
    'Project',
    'Cycle',
    'Hours',
    'Minutes',
    'Note',
    'Started at',
  ];
  return toCsv([
    header,
    ...report.entries.map((e) => {
      const person = e.userId ? people.get(e.userId) : undefined;
      const cycle = e.issue.cycleId ? cycleRows.get(e.issue.cycleId) : undefined;
      return [
        e.date,
        person?.name ?? '',
        person?.email ?? '',
        e.issue.identifier,
        e.issue.title,
        (e.issue.projectId && projectRows.get(e.issue.projectId)?.name) || '',
        cycle ? cycle.name || `Cycle ${cycle.number}` : '',
        (e.durationSeconds / 3600).toFixed(2),
        Math.round(e.durationSeconds / 60),
        e.note,
        e.startedAt,
      ];
    }),
  ]);
}
