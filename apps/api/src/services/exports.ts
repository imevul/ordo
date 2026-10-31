import {
  type CustomField,
  type ExportFormat,
  type Issue,
  priorityLabel,
  toCsv,
  type WorkspaceExport,
} from '@ordo/shared';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  attachments,
  commentReactions,
  comments,
  customerRequests,
  customFields,
  files,
  issueFieldValues,
  issueHistory,
  issueLinks,
  issueRelations,
  issues,
  labels,
  projectDocuments,
  projects,
  projectUpdates,
  users,
  views,
  workspaceExports,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { conflict, one } from '../lib/errors.ts';
import { enqueue, type JobContext } from '../lib/jobs/index.ts';
import { systemAccess } from './access.ts';
import { audit } from './audit.ts';
import type { RequestMeta } from './context.ts';
import { listCustomers } from './customers.ts';
import { listCustomFields } from './customFields.ts';
import { listCycles } from './cycles.ts';
import { deleteFile, saveFile, signedFileUrl } from './files.ts';
import { listInitiatives } from './initiatives.ts';
import { workspaceIssuePage } from './issues.ts';
import { listProjects } from './projects.ts';
import { toLabel, toView } from './serialize.ts';
import { publishChanges } from './sync.ts';
import { listTeams } from './teams.ts';
import { listTemplates } from './templates.ts';
import { workspaceSettings } from './workspaces.ts';

/**
 * Workspace exports, written by a job and kept for a week. JSON holds what belongs to the
 * workspace as a whole: people, teams, labels, custom fields, issue templates, projects, cycles, shared views, and issues with
 * their custom field values, comments and reactions, history, relations, links and attachment metadata. CSV is the issues, in the columns Ordo's CSV
 * import reads (a column per custom field, by name), so it round-trips. Personal things (private views, favourites, notifications) and
 * anything secret (integrations, webhooks, SSO) are left out.
 */

export const EXPORT_DAYS = 7;
const PAGE = 1000;

type ExportRow = typeof workspaceExports.$inferSelect;

export async function listExports(
  app: FastifyInstance,
  workspaceId: string,
  id?: string,
): Promise<WorkspaceExport[]> {
  const rows = await app.db
    .select({ row: workspaceExports, creator: { id: users.id, name: users.name } })
    .from(workspaceExports)
    .leftJoin(users, eq(users.id, workspaceExports.createdById))
    .where(
      and(
        eq(workspaceExports.workspaceId, workspaceId),
        id ? eq(workspaceExports.id, id) : undefined,
      ),
    )
    .orderBy(desc(workspaceExports.createdAt))
    .limit(20);
  return rows.map(({ row, creator }) => ({
    id: row.id,
    format: row.format,
    status: row.status,
    size: row.size,
    url: row.status === 'ready' ? signedFileUrl(app, row.fileId) : null,
    error: row.error,
    createdBy: creator?.id ? creator : null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    expiresAt: new Date(Date.parse(row.createdAt) + EXPORT_DAYS * 86_400_000).toISOString(),
  }));
}

/** Starts an export, one at a time per workspace. Audited: an export is the whole workspace. */
export async function startExport(
  app: FastifyInstance,
  opts: { workspaceId: string; userId: string; format: ExportFormat; meta: RequestMeta },
) {
  return app.db.transaction(async (tx) => {
    // Under read committed two requests would both see no running export; the lock queues them.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`export:${opts.workspaceId}`}))`);
    const [running] = await tx
      .select({ id: workspaceExports.id })
      .from(workspaceExports)
      .where(
        and(
          eq(workspaceExports.workspaceId, opts.workspaceId),
          eq(workspaceExports.status, 'running'),
        ),
      );
    if (running)
      throw conflict('An export is already being made; wait for it to finish').as('export_busy');
    const row = one(
      await tx
        .insert(workspaceExports)
        .values({ workspaceId: opts.workspaceId, format: opts.format, createdById: opts.userId })
        .returning(),
    );
    await enqueue(tx, 'export.run', { exportId: row.id }, { maxAttempts: 3 });
    await audit(
      tx,
      {
        workspaceId: opts.workspaceId,
        actorId: opts.userId,
        action: 'workspace.exported',
        targetType: 'export',
        targetId: row.id,
        data: { format: opts.format },
      },
      opts.meta,
    );
    return row;
  });
}

function publish(app: FastifyInstance, row: ExportRow) {
  return publishChanges(app, [
    { kind: 'export', action: 'updated', id: row.id, workspaceId: row.workspaceId },
  ]);
}

export async function runExport(
  app: FastifyInstance,
  { exportId }: { exportId: string },
  job: JobContext,
) {
  const [row] = await app.db
    .select()
    .from(workspaceExports)
    .where(eq(workspaceExports.id, exportId));
  if (row?.status !== 'running') return;
  try {
    const [ws] = await app.db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
    if (!ws || !row.createdById) throw new Error('The workspace or the person exporting is gone');
    const body = Buffer.from(
      row.format === 'json'
        ? await jsonExport(app, ws, row.createdById)
        : await csvExport(app, ws, row.createdById),
    );
    const file = await saveFile(app, {
      workspaceId: ws.id,
      ownerId: row.createdById,
      kind: 'export',
      filename: `ordo-${ws.slug}-${new Date().toISOString().slice(0, 10)}.${row.format}`,
      body,
    });
    // Only the first run to finish wins; one that lost the race throws its file away.
    const done = await app.db
      .update(workspaceExports)
      .set({
        status: 'ready',
        fileId: file.id,
        size: body.length,
        completedAt: new Date().toISOString(),
      })
      .where(and(eq(workspaceExports.id, row.id), eq(workspaceExports.status, 'running')))
      .returning({ id: workspaceExports.id });
    if (done.length === 0) return deleteFile(app, file.id);
  } catch (err) {
    if (job.attempt < job.maxAttempts) throw err;
    return failExport(app, { exportId }, err instanceof Error ? err.message : String(err));
  }
  await publish(app, row);
}

/**
 * Marks a still-running export failed: after its last attempt threw, or when the job died with
 * its worker (an export too big for memory takes the process with it, so `runExport` never gets
 * to record anything).
 */
export async function failExport(
  app: FastifyInstance,
  { exportId }: { exportId: string },
  error: string,
) {
  // Another run may have finished it meanwhile; a late failure mustn't undo that.
  const [row] = await app.db
    .update(workspaceExports)
    .set({ status: 'failed', error: error.slice(0, 1000), completedAt: new Date().toISOString() })
    .where(and(eq(workspaceExports.id, exportId), eq(workspaceExports.status, 'running')))
    .returning();
  if (row) await publish(app, row);
}

/** Exports older than a week go, files and all. */
export async function purgeOldExports(app: FastifyInstance) {
  const cutoff = new Date(Date.now() - EXPORT_DAYS * 86_400_000).toISOString();
  const old = await app.db
    .delete(workspaceExports)
    .where(lt(workspaceExports.createdAt, cutoff))
    .returning({ fileId: workspaceExports.fileId });
  for (const { fileId } of old) if (fileId) await deleteFile(app, fileId);
}

export async function deleteExport(app: FastifyInstance, row: ExportRow) {
  await app.db.delete(workspaceExports).where(eq(workspaceExports.id, row.id));
  if (row.fileId) await deleteFile(app, row.fileId);
}

// ─── formats ──────────────────────────────────────────────────────────────

/** Every issue, trashed ones too, a page at a time. */
async function allIssues(db: DbOrTx, workspaceId: string) {
  const out: Issue[] = [];
  for (let after: string | null = null; ; ) {
    const page = await workspaceIssuePage(db, workspaceId, after, PAGE);
    out.push(...page);
    if (page.length < PAGE) return out;
    after = page.at(-1)!.id;
  }
}

async function jsonExport(
  app: FastifyInstance,
  ws: typeof workspaces.$inferSelect,
  actorId: string,
): Promise<string> {
  const { db } = app;
  // An admin's view: every team, private ones included.
  const access = systemAccess(ws.id, actorId);
  const issueList = await allIssues(db, ws.id);
  // Chunked: a big workspace has more issues than one IN list should hold.
  const chunks = Array.from({ length: Math.ceil(issueList.length / PAGE) }, (_, i) =>
    issueList.slice(i * PAGE, (i + 1) * PAGE).map((x) => x.id),
  );
  /** Rows hanging off issues (comments, history…), a chunk of issues at a time. */
  const perIssue = async <T>(query: (ids: string[]) => Promise<T[]>) =>
    (await Promise.all(chunks.map(query))).flat();

  const projectList = await listProjects(db, access);
  const data = {
    format: 'ordo-workspace-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      settings: workspaceSettings(ws),
      createdAt: ws.createdAt,
    },
    members: await db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
        suspendedAt: workspaceMembers.suspendedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, ws.id))
      .orderBy(asc(users.name)),
    placeholders: await db
      .select({ id: users.id, name: users.name, importedEmail: users.importedEmail })
      .from(users)
      .where(and(eq(users.kind, 'placeholder'), eq(users.botWorkspaceId, ws.id))),
    teams: await listTeams(db, access),
    labels: (await db.select().from(labels).where(eq(labels.workspaceId, ws.id))).map(toLabel),
    // Definitions; each issue carries its values in `customFields`, by field id.
    customFields: await listCustomFields(db, access),
    templates: await listTemplates(db, access),
    initiatives: await listInitiatives(db, access, projectList),
    customers: await listCustomers(db, access),
    customerRequests: await perIssue((ids) =>
      db.select().from(customerRequests).where(inArray(customerRequests.issueId, ids)),
    ),
    projects: projectList,
    projectDocuments: projectList.length
      ? await db
          .select()
          .from(projectDocuments)
          .where(
            inArray(
              projectDocuments.projectId,
              projectList.map((p) => p.id),
            ),
          )
      : [],
    projectUpdates: projectList.length
      ? await db
          .select()
          .from(projectUpdates)
          .where(
            inArray(
              projectUpdates.projectId,
              projectList.map((p) => p.id),
            ),
          )
          .orderBy(asc(projectUpdates.createdAt))
      : [],
    cycles: await listCycles(db, access),
    views: (
      await db
        .select()
        .from(views)
        .where(and(eq(views.workspaceId, ws.id), eq(views.shared, true)))
    ).map(toView),
    issues: issueList,
    comments: await perIssue((ids) =>
      db
        .select()
        .from(comments)
        .where(inArray(comments.issueId, ids))
        .orderBy(asc(comments.createdAt)),
    ),
    reactions: await perIssue((ids) =>
      db
        .select({
          commentId: commentReactions.commentId,
          userId: commentReactions.userId,
          emoji: commentReactions.emoji,
          createdAt: commentReactions.createdAt,
        })
        .from(commentReactions)
        .innerJoin(comments, eq(comments.id, commentReactions.commentId))
        .where(inArray(comments.issueId, ids))
        .orderBy(asc(commentReactions.createdAt)),
    ),
    relations: await perIssue((ids) =>
      db.select().from(issueRelations).where(inArray(issueRelations.issueId, ids)),
    ),
    history: await perIssue((ids) =>
      db
        .select()
        .from(issueHistory)
        .where(inArray(issueHistory.issueId, ids))
        .orderBy(asc(issueHistory.createdAt)),
    ),
    links: await perIssue((ids) =>
      db
        .select({
          issueId: issueLinks.issueId,
          provider: issueLinks.provider,
          kind: issueLinks.kind,
          url: issueLinks.url,
          title: issueLinks.title,
          state: issueLinks.state,
          author: issueLinks.author,
          createdAt: issueLinks.createdAt,
        })
        .from(issueLinks)
        .where(inArray(issueLinks.issueId, ids)),
    ),
    // Metadata only: the files stay on the instance, at their URLs.
    attachments: await perIssue((ids) =>
      db
        .select({
          issueId: attachments.issueId,
          id: attachments.id,
          filename: files.filename,
          contentType: files.contentType,
          size: files.size,
          uploaderId: attachments.uploaderId,
          createdAt: attachments.createdAt,
        })
        .from(attachments)
        .innerJoin(files, eq(files.id, attachments.fileId))
        .where(inArray(attachments.issueId, ids)),
    ),
  };
  return JSON.stringify(data, null, 1);
}

/** The columns the CSV import recognises, so an export can be imported again. */
const CSV_HEADER = [
  'ID',
  'Team',
  'Title',
  'Description',
  'Status',
  'Priority',
  'Assignee',
  'Creator',
  'Labels',
  'Project',
  'Cycle',
  'Parent',
  'Estimate',
  'Due date',
  'Created',
  'Updated',
  'Completed',
  'Canceled',
  'URL',
];

async function csvExport(
  app: FastifyInstance,
  ws: typeof workspaces.$inferSelect,
  actorId: string,
) {
  const { db } = app;
  const access = systemAccess(ws.id, actorId);
  const teamList = await listTeams(db, access);
  const states = new Map(teamList.flatMap((t) => t.states).map((s) => [s.id, s.name]));
  const teamName = new Map(teamList.map((t) => [t.id, t.name]));
  // People by email where they have one (the import matches on it), else by name.
  const people = new Map(
    (
      await db
        .select({ id: users.id, name: users.name, email: users.email, kind: users.kind })
        .from(users)
        .where(
          inArray(
            users.id,
            db
              .select({ id: issues.creatorId })
              .from(issues)
              .where(eq(issues.workspaceId, ws.id))
              .union(
                db
                  .select({ id: issues.assigneeId })
                  .from(issues)
                  .where(eq(issues.workspaceId, ws.id)),
              )
              .union(
                db
                  .select({ id: issueFieldValues.userId })
                  .from(issueFieldValues)
                  .innerJoin(customFields, eq(customFields.id, issueFieldValues.fieldId))
                  .where(eq(customFields.workspaceId, ws.id)),
              ),
          ),
        )
    ).map((u) => [u.id, u.kind === 'human' ? u.email : u.name]),
  );
  const labelName = new Map(
    (await db.select().from(labels).where(eq(labels.workspaceId, ws.id))).map((l) => [
      l.id,
      l.name,
    ]),
  );
  const projectName = new Map(
    (await db.select().from(projects).where(eq(projects.workspaceId, ws.id))).map((p) => [
      p.id,
      p.name,
    ]),
  );
  const cycleName = new Map(
    (await listCycles(db, access)).map((c) => [c.id, c.name || `Cycle ${c.number}`]),
  );
  // A column per field name, headed by it, which the CSV import reads back into the field of
  // that name. Team fields may share a name, but an issue only ever has one of them.
  const fieldColumns = new Map<string, CustomField[]>();
  for (const f of await listCustomFields(db, access)) {
    const key = f.name.toLowerCase();
    fieldColumns.set(key, [...(fieldColumns.get(key) ?? []), f]);
  }
  const fieldCell = (i: Issue, fields: CustomField[]) => {
    for (const f of fields) {
      const value = i.customFields[f.id];
      if (value === undefined) continue;
      const option = (id: string) => f.options.find((o) => o.id === id)?.name;
      if (f.type === 'select') return option(value as string) ?? '';
      if (f.type === 'multi_select')
        return (value as string[]).map(option).filter(Boolean).join(', ');
      if (f.type === 'person') return people.get(value as string) ?? '';
      return value as string | number;
    }
    return '';
  };

  const list = (await allIssues(db, ws.id)).filter((i) => !i.deletedAt);
  const identifier = new Map(list.map((i) => [i.id, i.identifier]));
  const rows = list
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((i) => [
      i.identifier,
      teamName.get(i.teamId),
      i.title,
      i.description,
      states.get(i.stateId),
      priorityLabel(i.priority),
      i.assigneeId ? people.get(i.assigneeId) : '',
      i.creatorId ? people.get(i.creatorId) : '',
      i.labelIds
        .map((id) => labelName.get(id))
        .filter(Boolean)
        .join(', '),
      i.projectId ? projectName.get(i.projectId) : '',
      i.cycleId ? cycleName.get(i.cycleId) : '',
      i.parentId ? identifier.get(i.parentId) : '',
      i.estimate,
      i.dueDate,
      i.createdAt,
      i.updatedAt,
      i.completedAt,
      i.canceledAt,
      `${app.env.publicUrl}/${ws.slug}/issue/${i.identifier}`,
      ...[...fieldColumns.values()].map((fields) => fieldCell(i, fields)),
    ]);
  const header = [...CSV_HEADER, ...[...fieldColumns.values()].map((fields) => fields[0]!.name)];
  return toCsv([header, ...rows]);
}
