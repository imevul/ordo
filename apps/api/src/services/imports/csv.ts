import {
  type CsvColumns,
  type CsvField,
  detectCsvColumns,
  guessStateType,
  type ImportSummary,
  parseCsv,
  parsePriority,
} from '@ordo/shared';
import { eq } from 'drizzle-orm';
import { customFields, files } from '../../db/schema.ts';
import {
  ImportAbort,
  type ImportAdapter,
  type SourceContext,
  type SourceFieldValue,
  type SourceIssue,
} from './types.ts';

const MAX_ROWS = 50_000;
const PAGE_SIZE = 250;
/** The source team for files without a team column. */
const ONLY_TEAM = '*';

const DATE_FIELDS = ['createdAt', 'updatedAt', 'completedAt'] as const;
const FIELD_LABELS: Partial<Record<CsvField, string>> = {
  createdAt: 'created date',
  updatedAt: 'updated date',
  completedAt: 'completed date',
  dueDate: 'due date',
};

interface Parsed {
  headers: string[];
  issues: SourceIssue[];
  summary: ImportSummary;
}

// Every page of a run needs the whole file; keep the last one parsed.
let cache: { key: string; parsed: Parsed } | null = null;

async function readFile(sctx: SourceContext) {
  const { row, app } = sctx;
  if (!row.fileId) throw new ImportAbort('The uploaded file is gone; start a new import');
  const [file] = await app.db.select().from(files).where(eq(files.id, row.fileId));
  const body = file && (await app.storage.get(file.storageKey));
  if (!body) throw new ImportAbort('The uploaded file is gone; start a new import');
  return body.toString('utf8');
}

const columnsOf = (sctx: SourceContext) =>
  (sctx.row.config.columns as CsvColumns | undefined) ?? null;

async function parsed(sctx: SourceContext): Promise<Parsed> {
  const fields = await fieldNames(sctx);
  const key = `${sctx.row.id}:${sctx.row.fileId}:${JSON.stringify(columnsOf(sctx))}:${JSON.stringify([...fields])}`;
  if (cache?.key === key) return cache.parsed;
  const rows = parseCsv(await readFile(sctx));
  const [headers = [], ...data] = rows;
  if (data.length > MAX_ROWS) {
    throw new ImportAbort(
      `The file has ${data.length} rows; split it into files of at most ${MAX_ROWS}`,
    );
  }
  const columns = columnsOf(sctx) ?? detectCsvColumns(headers);
  const result = convert(sctx.row.name, headers, data, columns, fields);
  cache = { key, parsed: result };
  return result;
}

/**
 * The workspace's custom field names (lowercased), and whether one of that name is a person
 * field. Columns named like one feed it.
 */
async function fieldNames(sctx: SourceContext) {
  const rows = await sctx.app.db
    .select({ name: customFields.name, type: customFields.type })
    .from(customFields)
    .where(eq(customFields.workspaceId, sctx.row.workspaceId));
  const names = new Map<string, boolean>();
  for (const r of rows) names.set(lower(r.name), names.get(lower(r.name)) || r.type === 'person');
  return names;
}

const lower = (s: string) => s.trim().toLowerCase();

function date(value: string, warnings: string[], label: string) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    warnings.push(`Couldn't read the ${label} "${value}"`);
    return undefined;
  }
  return d.toISOString();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day a cell names: `03/15/2026` is the 15th whatever zone the server runs in. */
export function calendarDate(value: string) {
  const iso = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value);
  if (iso) return iso[1];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  // Without a zone the text is read as local time, so the local fields are the day it names.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Turns rows into source issues and a summary of what they refer to. */
function convert(
  name: string,
  headers: string[],
  data: string[][],
  columns: CsvColumns,
  fieldNames: Map<string, boolean>,
): Parsed {
  // Columns no Ordo field reads, named like a custom field, feed it.
  const used = new Set(Object.values(columns).filter(Boolean));
  const fieldColumns = headers
    .map((header, i) => ({ header, i, id: lower(header) }))
    .filter(
      (c, i) =>
        c.id &&
        !used.has(c.header) &&
        fieldNames.has(c.id) &&
        headers.findIndex((h) => lower(h) === c.id) === i,
    )
    .map((c) => ({ ...c, person: fieldNames.get(c.id)!, count: 0 }));
  const index = Object.fromEntries(
    Object.entries(columns).map(([field, header]) => [
      field,
      header ? headers.indexOf(header) : -1,
    ]),
  ) as Partial<Record<CsvField, number>>;
  const cell = (r: string[], field: CsvField) => {
    const i = index[field] ?? -1;
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };

  const teams = new Map<
    string,
    { name: string; key: string | null; count: number; statuses: Map<string, number> }
  >();
  const users = new Map<string, { name: string; email: string | null; count: number }>();
  const labels = new Map<string, { name: string; count: number }>();
  const projects = new Map<string, { name: string; count: number }>();
  const seen = new Set<string>();
  const person = (value: string) => {
    // GitHub exports list several assignees; the first one gets the issue.
    const v = value.split(',')[0]!.trim();
    if (!v) return undefined;
    const id = lower(v);
    const u = users.get(id) ?? { name: v, email: v.includes('@') ? v : null, count: 0 };
    u.count++;
    users.set(id, u);
    return id;
  };
  const named = (map: Map<string, { name: string; count: number }>, value: string) => {
    const id = lower(value);
    const entry = map.get(id) ?? { name: value.trim(), count: 0 };
    entry.count++;
    map.set(id, entry);
    return id;
  };

  const issues = data.map((r, i): SourceIssue => {
    const line = `row ${i + 2}`;
    const warnings: string[] = [];
    const rawId = cell(r, 'id');
    let id = rawId || line;
    if (seen.has(id)) {
      warnings.push(`The ID ${rawId} appears more than once; this row is a separate issue`);
      id = `${rawId} (${line})`;
    }
    seen.add(id);
    const keyMatch = /^([A-Za-z][A-Za-z0-9]{0,6})-(\d+)$/.exec(rawId);
    // A repeated ID's number belongs to its first row.
    const number = warnings.length
      ? undefined
      : /^\d+$/.test(rawId)
        ? Number(rawId)
        : keyMatch
          ? Number(keyMatch[2])
          : undefined;

    const teamName = cell(r, 'team');
    const teamId = teamName ? lower(teamName) : ONLY_TEAM;
    const team = teams.get(teamId) ?? {
      name: teamName || name.replace(/\.csv$/i, ''),
      key: null,
      count: 0,
      statuses: new Map(),
    };
    team.count++;
    team.key ??= keyMatch ? keyMatch[1]!.toUpperCase() : null;
    const status = cell(r, 'status');
    if (status) team.statuses.set(status, (team.statuses.get(status) ?? 0) + 1);
    teams.set(teamId, team);

    const priorityText = cell(r, 'priority');
    const priority = priorityText ? parsePriority(priorityText) : undefined;
    if (priority === null) warnings.push(`Couldn't read the priority "${priorityText}"`);

    const estimateText = cell(r, 'estimate');
    let estimate: number | undefined;
    if (estimateText) {
      const n = Math.round(Number(estimateText));
      if (Number.isFinite(n) && n >= 0 && n <= 100) estimate = n;
      else warnings.push(`Couldn't read the estimate "${estimateText}"`);
    }

    const dueText = cell(r, 'dueDate');
    const due = dueText ? calendarDate(dueText) : undefined;
    if (dueText && !due) warnings.push(`Couldn't read the ${FIELD_LABELS.dueDate} "${dueText}"`);
    const dates = Object.fromEntries(
      DATE_FIELDS.map((f) => [f, date(cell(r, f), warnings, FIELD_LABELS[f]!)]),
    ) as Record<(typeof DATE_FIELDS)[number], string | undefined>;

    const labelText = cell(r, 'labels');
    const projectText = cell(r, 'project');
    const values: Record<string, SourceFieldValue> = {};
    for (const c of fieldColumns) {
      const v = (r[c.i] ?? '').trim();
      if (!v) continue;
      // People in person columns are mapped like assignees.
      const value = c.person ? person(v) : v;
      if (!value) continue;
      values[c.id] = value;
      c.count++;
    }
    return {
      id,
      ref: rawId || line,
      teamId,
      number,
      title: cell(r, 'title'),
      description: cell(r, 'description') || undefined,
      status: status || undefined,
      priority: priority ?? undefined,
      assigneeId: person(cell(r, 'assignee')),
      creatorId: person(cell(r, 'creator')),
      labelIds: labelText
        ? [
            ...new Set(
              labelText
                .split(/[,;|]/)
                .filter((l) => l.trim())
                .map((l) => named(labels, l)),
            ),
          ]
        : undefined,
      projectId: projectText ? named(projects, projectText) : undefined,
      parentId: cell(r, 'parent') || undefined,
      estimate,
      dueDate: due,
      ...dates,
      url: /^https?:\/\//.test(cell(r, 'url')) ? cell(r, 'url') : undefined,
      customFields: Object.keys(values).length ? values : undefined,
      warnings,
    };
  });

  const summaryWarnings: string[] = [];
  if (!data.length) summaryWarnings.push('The file has no rows');
  if (!columns.title) summaryWarnings.push('No column is used for the title; pick one');
  return {
    headers,
    issues,
    summary: {
      teams: [...teams].map(([id, t]) => ({
        id,
        name: t.name,
        key: t.key,
        issueCount: t.count,
        statuses: [...t.statuses].map(([s, count]) => ({
          name: s,
          type: guessStateType(s),
          count,
        })),
      })),
      users: [...users].map(([id, u]) => ({ id, ...u })),
      labels: [...labels].map(([id, l]) => ({ id, ...l })),
      projects: [...projects].map(([id, p]) => ({ id, ...p })),
      fields: fieldColumns.map((c) => ({ id: c.id, name: c.header.trim(), count: c.count })),
      counts: { issues: data.length, comments: 0 },
      warnings: summaryWarnings,
      csv: { headers, columns, preview: data.slice(0, 5) },
    },
  };
}

export const csvSource: ImportAdapter = {
  key: 'csv',

  async analyze(sctx) {
    const { summary } = await parsed(sctx);
    return { summary, config: { ...sctx.row.config, columns: summary.csv!.columns } };
  },

  async issues(sctx, cursor) {
    const { issues } = await parsed(sctx);
    const start = Number(cursor ?? 0);
    const next = start + PAGE_SIZE;
    return {
      items: issues.slice(start, next),
      next: next < issues.length ? String(next) : null,
    };
  },
};
