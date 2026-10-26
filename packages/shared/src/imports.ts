import type { ProjectStatus, StateType } from './constants.ts';

/**
 * Imports from other trackers and files. An import runs in steps: the source is analyzed (what
 * teams, statuses, people, labels and projects it has), an admin maps those onto the workspace,
 * a dry run reports what would happen, and the run writes it.
 */

export const IMPORT_SOURCES = ['csv', 'linear'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_STATUSES = [
  'analyzing',
  'ready',
  'dry_running',
  'running',
  'completed',
  'failed',
  'canceled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Statuses during which a job is working on the import. */
export const IMPORT_BUSY: readonly ImportStatus[] = ['analyzing', 'dry_running', 'running'];

/** Something the source has, described for mapping. `id` is the source's own identifier. */
export interface ImportSourceTeam {
  id: string;
  name: string;
  key: string | null;
  issueCount: number;
  statuses: { name: string; type: StateType | null; count: number }[];
}

export interface ImportSourceUser {
  id: string;
  name: string;
  email: string | null;
  count: number;
}

export interface ImportSourceNamed {
  id: string;
  name: string;
  count: number;
}

/** A project, with what an API source knows about it. Its teams and lead are source ids. */
export interface ImportSourceProject extends ImportSourceNamed {
  teamIds?: string[];
  description?: string | null;
  status?: ProjectStatus;
  leadId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
}

/** A cycle of a source team. Cycles are imported into teams the import creates. */
export interface ImportSourceCycle {
  id: string;
  teamId: string;
  number: number;
  name: string | null;
  /** YYYY-MM-DD */
  startsAt: string;
  endsAt: string;
}

/** What analysis found. */
export interface ImportSummary {
  teams: ImportSourceTeam[];
  users: ImportSourceUser[];
  labels: ImportSourceNamed[];
  projects: ImportSourceProject[];
  cycles?: ImportSourceCycle[];
  counts: { issues: number; comments: number };
  warnings: string[];
  /** CSV: the file's columns, which Ordo field each one feeds, and the first rows. */
  csv?: {
    headers: string[];
    columns: CsvColumns;
    preview: string[][];
  };
}

/** Where a source team's issues go: an existing team, a new one, or nowhere. */
export type ImportTeamTarget =
  | { teamId: string }
  | { create: { name: string; key: string } }
  | { skip: true };

export interface ImportMapping {
  teams: Record<string, ImportTeamTarget>;
  /** Per source team: status name → a state id of the target team, or a state type. */
  statuses: Record<string, Record<string, string>>;
  /**
   * Source person → a member or an existing placeholder, 'placeholder' for a new one, or null to
   * leave their issues unassigned (and created by the importer).
   */
  users: Record<string, string | null>;
  /** Source label → an existing label id, 'create' or 'skip'. */
  labels: Record<string, string>;
  /** Source project → an existing project id, 'create' or 'skip'. */
  projects: Record<string, string>;
  /** Keep the source's issue numbers (ENG-42 stays ENG-42). Only for teams without issues. */
  keepNumbers: boolean;
}

export interface ImportProblem {
  /** The source item it's about ("ENG-12", "row 14"), if any. */
  item?: string;
  message: string;
}

export interface ImportReport {
  dryRun: boolean;
  created: {
    teams: number;
    people: number;
    labels: number;
    projects: number;
    cycles: number;
    issues: number;
    comments: number;
    relations: number;
  };
  /** Items already imported by an earlier attempt of this import. */
  existing: number;
  skipped: ImportProblem[];
  skippedCount: number;
  warnings: ImportProblem[];
  warningCount: number;
}

export interface ImportProgress {
  phase: string;
  done: number;
  total: number;
}

export interface Import {
  id: string;
  source: ImportSource;
  name: string;
  status: ImportStatus;
  config: Record<string, unknown>;
  summary: ImportSummary | null;
  mapping: ImportMapping | null;
  report: ImportReport | null;
  progress: ImportProgress | null;
  error: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// ─── CSV ──────────────────────────────────────────────────────────────────

export const CSV_FIELDS = [
  'id',
  'title',
  'description',
  'team',
  'status',
  'priority',
  'assignee',
  'creator',
  'labels',
  'project',
  'parent',
  'estimate',
  'dueDate',
  'createdAt',
  'updatedAt',
  'completedAt',
  'url',
] as const;
export type CsvField = (typeof CSV_FIELDS)[number];
/** Which column (by header) feeds each field; null for none. */
export type CsvColumns = Partial<Record<CsvField, string | null>>;

/** Header names other tools export (Linear, Jira, GitHub, spreadsheets), lowercased. */
const CSV_ALIASES: Record<CsvField, string[]> = {
  id: ['id', 'identifier', 'key', 'issue key', 'issue id', 'number', '#'],
  title: ['title', 'summary', 'name', 'subject'],
  description: ['description', 'body', 'details'],
  team: ['team', 'team key'],
  status: ['status', 'state', 'workflow state'],
  priority: ['priority'],
  assignee: ['assignee', 'assigned to', 'assignees', 'owner'],
  creator: ['creator', 'reporter', 'created by', 'author'],
  labels: ['labels', 'label', 'tags'],
  project: ['project', 'epic', 'epic name', 'milestone'],
  parent: ['parent', 'parent issue', 'parent id', 'parent key'],
  estimate: ['estimate', 'story points', 'points'],
  dueDate: ['due date', 'due', 'due on', 'duedate'],
  createdAt: ['created', 'created at', 'created date', 'createdat'],
  updatedAt: ['updated', 'updated at', 'updatedat'],
  completedAt: ['completed', 'completed at', 'resolved', 'resolution date', 'closed at'],
  url: ['url', 'link', 'html url'],
};

/** Guesses which column feeds each field from the headers. */
export function detectCsvColumns(headers: string[]): CsvColumns {
  const columns: CsvColumns = {};
  const taken = new Set<string>();
  for (const field of CSV_FIELDS) {
    const header = headers.find(
      (h) => !taken.has(h) && CSV_ALIASES[field].includes(h.trim().toLowerCase()),
    );
    columns[field] = header ?? null;
    if (header) taken.add(header);
  }
  return columns;
}

/**
 * Parses CSV (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes, CRLF or LF).
 * The delimiter is guessed from the first line (comma, semicolon or tab) unless given.
 * Fully empty lines are dropped.
 */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = delimiter ?? guessDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

function guessDelimiter(text: string) {
  const line = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length] as const);
  return counts.reduce((best, c) => (c[1] > best[1] ? c : best))[0];
}

// ─── mapping helpers ──────────────────────────────────────────────────────

const STATE_WORDS: [StateType, RegExp][] = [
  ['canceled', /cancel|won'?t (do|fix)|duplicate|rejected|invalid|obsolete/],
  ['completed', /done|complete|closed|resolved|fixed|shipped|released|merged/],
  ['started', /progress|doing|started|review|testing|qa|active|develop/],
  ['triage', /triage/],
  ['backlog', /backlog|icebox|later|someday/],
  ['unstarted', /to ?do|open|new|ready|planned|selected|unstarted/],
];

/** The kind of workflow state a status name probably is, or null if it's anyone's guess. */
export function guessStateType(name: string): StateType | null {
  const n = name.trim().toLowerCase();
  return STATE_WORDS.find(([, re]) => re.test(n))?.[0] ?? null;
}

/** Ordo priority (0 none, 1 urgent … 4 low) from a number or a word; null if unrecognised. */
export function parsePriority(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (!v) return 0;
  if (/^[0-4]$/.test(v)) return Number(v);
  if (/^(no priority|none|-)$/.test(v)) return 0;
  if (/urgent|critical|blocker|highest|p0/.test(v)) return 1;
  if (/high|major|p1/.test(v)) return 2;
  if (/medium|normal|p2/.test(v)) return 3;
  if (/low|minor|trivial|p3|p4/.test(v)) return 4;
  return null;
}
