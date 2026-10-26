import type { ImportSource, ImportSummary } from '@ordo/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { imports } from '../../db/schema.ts';

export type ImportRow = typeof imports.$inferSelect;

/**
 * An issue as a source describes it. Its id and the ids it refers to (team, people, labels,
 * project, parent) are the source's own, matching the ids in the summary.
 */
export interface SourceIssue {
  id: string;
  /** How people know it: "ENG-12", "row 14". */
  ref: string;
  teamId: string;
  number?: number;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  assigneeId?: string;
  creatorId?: string;
  labelIds?: string[];
  projectId?: string;
  cycleId?: string;
  parentId?: string;
  estimate?: number;
  dueDate?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  canceledAt?: string;
  url?: string;
  /** Other links on it (attachments, pull requests), kept as links. */
  links?: { url: string; title: string }[];
  /** Problems reading it, reported as warnings. */
  warnings?: string[];
}

/** A comment as a source describes it, oldest first so replies follow what they answer. */
export interface SourceComment {
  id: string;
  issueId: string;
  authorId?: string;
  body: string;
  createdAt?: string;
  parentId?: string;
}

/** A relation between two source issues. `duplicate` means `issueId` duplicates the other. */
export interface SourceRelation {
  id: string;
  issueId: string;
  relatedIssueId: string;
  type: 'blocks' | 'related' | 'duplicate';
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface SourceContext {
  app: FastifyInstance;
  row: ImportRow;
  log: FastifyBaseLogger;
}

/** One kind of source (a file format or another tracker's API). */
export interface ImportAdapter {
  key: ImportSource;
  /** Reads the source and summarizes it; may return settings it worked out (CSV columns). */
  analyze(
    sctx: SourceContext,
  ): Promise<{ summary: ImportSummary; config?: Record<string, unknown> }>;
  /** Issues a page at a time, in a stable order; `cursor` null is the first page. */
  issues(sctx: SourceContext, cursor: string | null): Promise<Page<SourceIssue>>;
  /**
   * Issues that have a parent (only `id`, `ref` and `parentId` are needed), for linking sub-issues.
   * Without it the engine goes through `issues` again.
   */
  children?(sctx: SourceContext, cursor: string | null): Promise<Page<SourceIssue>>;
  /** Relations and comments, for sources that have them. */
  relations?(sctx: SourceContext, cursor: string | null): Promise<Page<SourceRelation>>;
  comments?(sctx: SourceContext, cursor: string | null): Promise<Page<SourceComment>>;
}

/** A problem that retrying won't fix: the import fails with this message. */
export class ImportAbort extends Error {}

/** The source asks to slow down (a rate limit): the import carries on at `at`. */
export class ImportRetryLater extends Error {
  constructor(
    message: string,
    public at: Date,
  ) {
    super(message);
  }
}
