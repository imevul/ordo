import { type SQL, sql } from 'drizzle-orm';

/**
 * Full-text search in Postgres, no extensions: issue titles and descriptions, and comments, are
 * indexed with the language-neutral 'simple' configuration (GIN expression indexes, see schema.ts),
 * and every word of a query matches as a prefix so results follow typing.
 */

// Must match issues_search_idx and comments_search_idx exactly, or Postgres won't use them.
const issueDocument = (t: string) =>
  sql.raw(
    `(setweight(to_tsvector('simple', "${t}"."title"), 'A') || setweight(to_tsvector('simple', "${t}"."description"), 'B'))`,
  );
const commentDocument = sql`to_tsvector('simple', "c"."body")`;

const MAX_TERMS = 8;

/** A prefix tsquery for the words in `q`, or null when it has none (only punctuation). */
export function textQuery(q: string): SQL | null {
  const words = q
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, MAX_TERMS);
  if (!words?.length) return null;
  // Words are letters and digits only, so they need no quoting beyond the apostrophes.
  return sql`to_tsquery('simple', ${words.map((w) => `'${w}':*`).join(' & ')})`;
}

// Words too common to say anything about whether two issues are about the same thing.
const STOPWORDS = new Set(
  'the and for with from that this when into not are was but can should would could have has after before when then than does doesnt dont cant wont add fix make use issue bug'.split(
    ' ',
  ),
);

/**
 * A tsquery matching any of the telling words in `text` (as prefixes), for finding issues that
 * share some of its words rather than all of them.
 */
export function anyWordQuery(text: string, maxTerms = 12): SQL | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .replace(/['’]/g, '')
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ].slice(0, maxTerms);
  if (!words.length) return null;
  return sql`to_tsquery('simple', ${words.map((w) => `'${w}':*`).join(' | ')})`;
}

/**
 * Ids of issues whose title, description or a comment matches: a union of lookups that can each
 * use their index (an OR across them couldn't).
 */
export const matchingIssueIds = (query: SQL) =>
  sql`select d.id from issues d where ${issueDocument('d')} @@ ${query}
    union select c.issue_id from comments c where ${commentDocument} @@ ${query}`;

/** Relevance of a matched issue: text rank (title words weigh most), a little more for comments. */
export const textRank = (query: SQL) =>
  sql`ts_rank(${issueDocument('issues')}, ${query}) + case when exists (select 1 from comments c where c.issue_id = "issues"."id" and ${commentDocument} @@ ${query}) then 0.05 else 0 end`;
