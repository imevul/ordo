import {
  type CreateCustomFieldInput,
  type CustomField,
  type CustomFieldOption,
  type CustomFieldValue,
  type HistoryChange,
  LABEL_COLORS,
  type UpdateCustomFieldInput,
} from '@ordo/shared';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { customFields, issueFieldValues, teams } from '../db/schema.ts';
import { badRequest, conflict, forbidden, notFound, one } from '../lib/errors.ts';
import {
  type Access,
  canAdminTeam,
  canReadTeam,
  teamScope,
  usersWithTeamAccess,
} from './access.ts';
import { type Ctx, emit } from './context.ts';
import { isWorkspacePlaceholder } from './placeholders.ts';

type FieldRow = typeof customFields.$inferSelect;
type ValueRow = typeof issueFieldValues.$inferInsert;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const toCustomField = (f: FieldRow): CustomField => ({
  id: f.id,
  teamId: f.teamId,
  name: f.name,
  description: f.description,
  type: f.type,
  options: f.options,
  position: f.position,
});

const fieldOrder = [asc(customFields.position), asc(customFields.name)];

/** Workspace fields, plus fields of teams `access` can read. */
export async function listCustomFields(db: DbOrTx, access: Access): Promise<CustomField[]> {
  const rows = await db
    .select()
    .from(customFields)
    .where(
      and(
        eq(customFields.workspaceId, access.workspaceId),
        access.isAdmin
          ? undefined
          : or(isNull(customFields.teamId), teamScope(access, customFields.teamId)),
      ),
    )
    .orderBy(...fieldOrder);
  return rows.map(toCustomField);
}

/** The fields issues of `teamId` have: the workspace's and the team's own. */
export async function teamFields(db: DbOrTx, workspaceId: string, teamId: string) {
  return db
    .select()
    .from(customFields)
    .where(
      and(
        eq(customFields.workspaceId, workspaceId),
        or(isNull(customFields.teamId), eq(customFields.teamId, teamId)),
      ),
    )
    .orderBy(...fieldOrder);
}

/** Workspace fields are for workspace admins; a team's fields for its admins too. */
function assertManage(access: Access, teamId: string | null) {
  if (teamId ? canAdminTeam(access, teamId) : access.isAdmin) return;
  throw forbidden(
    teamId ? 'Only team admins can manage its fields' : 'Only admins can manage workspace fields',
  );
}

/**
 * Names are how people, the CLI and MCP tools refer to fields, so they must be unique among the
 * fields an issue can have: a workspace field's against every field, a team field's against the
 * workspace's and its team's.
 */
async function assertUniqueName(ctx: Ctx, name: string, teamId: string | null, exceptId?: string) {
  const rows = await ctx.tx
    .select({ id: customFields.id })
    .from(customFields)
    .where(
      and(
        eq(customFields.workspaceId, ctx.workspaceId),
        sql`lower(${customFields.name}) = lower(${name})`,
        teamId ? or(isNull(customFields.teamId), eq(customFields.teamId, teamId)) : undefined,
        exceptId ? sql`${customFields.id} <> ${exceptId}` : undefined,
      ),
    );
  if (rows.length) throw conflict(`There is already a field named "${name}"`);
}

const newOptionId = () => crypto.randomUUID().slice(0, 8);

/** Options with ids (kept where given) and colors; names must be unique within the field. */
function normalizeOptions(
  options: { id?: string; name: string; color?: string }[],
  previous: CustomFieldOption[] = [],
): CustomFieldOption[] {
  const known = new Map(previous.map((o) => [o.id, o]));
  const names = new Set<string>();
  const ids = new Set<string>();
  return options.map((o, i) => {
    const key = o.name.toLowerCase();
    if (names.has(key)) throw badRequest(`Option "${o.name}" is listed twice`);
    names.add(key);
    const id = o.id && !ids.has(o.id) ? o.id : newOptionId();
    ids.add(id);
    return {
      id,
      name: o.name,
      color: o.color ?? known.get(id)?.color ?? LABEL_COLORS[i % LABEL_COLORS.length]!,
    };
  });
}

const hasOptions = (type: CustomField['type']) => type === 'select' || type === 'multi_select';

export async function createCustomField(
  ctx: Ctx,
  input: CreateCustomFieldInput,
): Promise<CustomField> {
  const teamId = input.teamId ?? null;
  if (teamId) {
    const [t] = await ctx.tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
    if (!t || !canReadTeam(ctx.access, t.id)) throw badRequest('Unknown team').as('unknown_team');
  }
  assertManage(ctx.access, teamId);
  await assertUniqueName(ctx, input.name, teamId);
  let position = input.position;
  if (position === undefined) {
    const [{ max }] = (await ctx.tx
      .select({ max: sql<number | null>`max(${customFields.position})` })
      .from(customFields)
      .where(eq(customFields.workspaceId, ctx.workspaceId))) as [{ max: number | null }];
    position = (max ?? 0) + 1;
  }
  const row = one(
    await ctx.tx
      .insert(customFields)
      .values({
        workspaceId: ctx.workspaceId,
        teamId,
        name: input.name,
        description: input.description || null,
        type: input.type,
        options: hasOptions(input.type) ? normalizeOptions(input.options) : [],
        position,
      })
      .returning(),
  );
  emit(ctx, { kind: 'customField', action: 'created', id: row.id, teamId: teamId ?? undefined });
  return toCustomField(row);
}

/** A field the requester may manage; unreadable team fields are "not found". */
async function manageableField(ctx: Ctx, id: string) {
  const [field] = await ctx.tx
    .select()
    .from(customFields)
    .where(and(eq(customFields.id, id), eq(customFields.workspaceId, ctx.workspaceId)));
  if (!field || (field.teamId && !canReadTeam(ctx.access, field.teamId)))
    throw notFound('Custom field');
  assertManage(ctx.access, field.teamId);
  return field;
}

/** Ids of the issues that have a value for `fieldId`, to tell their viewers. */
async function issuesWithValue(ctx: Ctx, fieldId: string) {
  const rows = await ctx.tx
    .select({ id: issueFieldValues.issueId })
    .from(issueFieldValues)
    .where(eq(issueFieldValues.fieldId, fieldId));
  return rows.map((r) => r.id);
}

function emitIssues(ctx: Ctx, ids: string[]) {
  for (const id of ids)
    emit(ctx, { kind: 'issue', action: 'updated', id, bootstrapUnchanged: true });
}

export async function updateCustomField(
  ctx: Ctx,
  id: string,
  input: UpdateCustomFieldInput,
): Promise<CustomField> {
  const field = await manageableField(ctx, id);
  if (input.name !== undefined && input.name.toLowerCase() !== field.name.toLowerCase())
    await assertUniqueName(ctx, input.name, field.teamId, id);
  const set: Partial<typeof customFields.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description || null;
  if (input.position !== undefined) set.position = input.position;
  let touched: string[] = [];
  if (input.options !== undefined && hasOptions(field.type)) {
    const options = normalizeOptions(input.options, field.options);
    set.options = options;
    // Issues lose the options that are gone.
    const kept = options.map((o) => o.id);
    const removed = field.options.filter((o) => !kept.includes(o.id)).map((o) => o.id);
    if (removed.length) {
      const removedArray = sql`array[${sql.join(
        removed.map((r) => sql`${r}`),
        sql`, `,
      )}]::text[]`;
      const changed =
        field.type === 'select'
          ? await ctx.tx
              .delete(issueFieldValues)
              .where(
                and(eq(issueFieldValues.fieldId, id), inArray(issueFieldValues.textValue, removed)),
              )
              .returning({ id: issueFieldValues.issueId })
          : await ctx.tx
              .update(issueFieldValues)
              .set({
                optionIds: sql`array(select o from unnest(${issueFieldValues.optionIds}) o where o <> all(${removedArray}))`,
              })
              .where(
                and(
                  eq(issueFieldValues.fieldId, id),
                  sql`${issueFieldValues.optionIds} && ${removedArray}`,
                ),
              )
              .returning({ id: issueFieldValues.issueId });
      if (field.type === 'multi_select') {
        await ctx.tx
          .delete(issueFieldValues)
          .where(
            and(
              eq(issueFieldValues.fieldId, id),
              sql`cardinality(${issueFieldValues.optionIds}) = 0`,
            ),
          );
      }
      touched = changed.map((c) => c.id);
    }
  }
  const [row] = Object.keys(set).length
    ? await ctx.tx.update(customFields).set(set).where(eq(customFields.id, id)).returning()
    : [field];
  emit(ctx, {
    kind: 'customField',
    action: 'updated',
    id,
    teamId: field.teamId ?? undefined,
  });
  emitIssues(ctx, touched);
  return toCustomField(row!);
}

export async function deleteCustomField(ctx: Ctx, id: string) {
  const field = await manageableField(ctx, id);
  const touched = await issuesWithValue(ctx, id);
  await ctx.tx.delete(customFields).where(eq(customFields.id, id));
  emit(ctx, { kind: 'customField', action: 'deleted', id, teamId: field.teamId ?? undefined });
  emitIssues(ctx, touched);
}

// ─── values ────────────────────────────────────────────────────────────

/** A stored row as the value the API sends; null when it holds nothing. */
export function storedValue(
  field: Pick<FieldRow, 'type'>,
  v: Omit<ValueRow, 'issueId' | 'fieldId'>,
): CustomFieldValue | null {
  switch (field.type) {
    case 'multi_select':
      return v.optionIds?.length ? v.optionIds : null;
    case 'number':
      return v.numberValue ?? null;
    case 'date':
      return v.dateValue ?? null;
    case 'person':
      return v.userId ?? null;
    default:
      return v.textValue ?? null;
  }
}

/**
 * The columns to store for `value` in `field`, or null to clear it. Throws on values that don't
 * fit the field: unknown options, a person who can't see the team, a malformed date.
 */
async function toColumns(
  ctx: Ctx,
  field: FieldRow,
  teamId: string,
  value: CustomFieldValue | null,
  imported: boolean,
): Promise<Omit<ValueRow, 'issueId' | 'fieldId'> | null> {
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  const wrong = (what: string) => badRequest(`${field.name}: ${what}`);
  const optionIds = new Set(field.options.map((o) => o.id));
  switch (field.type) {
    case 'select':
      if (typeof value !== 'string' || !optionIds.has(value)) throw wrong('unknown option');
      return { textValue: value };
    case 'multi_select': {
      if (!Array.isArray(value)) throw wrong('expected a list of options');
      const ids = [...new Set(value)];
      if (ids.some((o) => !optionIds.has(o))) throw wrong('unknown option');
      // Kept in the field's order, so the same choice always reads the same.
      return { optionIds: field.options.map((o) => o.id).filter((o) => ids.includes(o)) };
    }
    case 'number':
      if (typeof value !== 'number') throw wrong('expected a number');
      return { numberValue: value };
    case 'date':
      if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value)))
        throw wrong('expected a date like 2026-01-31');
      return { dateValue: value };
    case 'text': {
      if (typeof value !== 'string') throw wrong('expected text');
      const text = value.trim();
      return text ? { textValue: text } : null;
    }
    case 'person': {
      if (typeof value !== 'string') throw wrong('expected a user id');
      const [ok] = await usersWithTeamAccess(ctx.tx, ctx.workspaceId, teamId, [value]);
      if (!ok && !(imported && (await isWorkspacePlaceholder(ctx.tx, ctx.workspaceId, value))))
        throw wrong("isn't a member of this workspace, or can't access this team");
      return { userId: value };
    }
  }
}

const sameValue = (a: CustomFieldValue | null, b: CustomFieldValue | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Sets custom field values on an issue in `teamId` (null clears one) and returns the history
 * entries for what changed. Fields of other teams are rejected.
 */
export async function setFieldValues(
  ctx: Ctx,
  issueId: string,
  teamId: string,
  values: Record<string, CustomFieldValue | null>,
  opts: { imported?: boolean } = {},
): Promise<HistoryChange[]> {
  const ids = Object.keys(values);
  if (!ids.length) return [];
  const fields = new Map((await teamFields(ctx.tx, ctx.workspaceId, teamId)).map((f) => [f.id, f]));
  const unknown = ids.find((id) => !fields.has(id));
  if (unknown) throw badRequest(`Unknown custom field for this team: ${unknown}`);
  const existing = new Map(
    (
      await ctx.tx
        .select()
        .from(issueFieldValues)
        .where(and(eq(issueFieldValues.issueId, issueId), inArray(issueFieldValues.fieldId, ids)))
    ).map((v) => [v.fieldId, v]),
  );
  const changes: HistoryChange[] = [];
  for (const id of ids) {
    const field = fields.get(id)!;
    const columns = await toColumns(ctx, field, teamId, values[id]!, !!opts.imported);
    const before = existing.has(id) ? storedValue(field, existing.get(id)!) : null;
    const after = columns ? storedValue(field, columns) : null;
    if (sameValue(before, after)) continue;
    if (columns) {
      const row = {
        textValue: null,
        optionIds: null,
        numberValue: null,
        dateValue: null,
        userId: null,
        ...columns,
      };
      await ctx.tx
        .insert(issueFieldValues)
        .values({ issueId, fieldId: id, ...row })
        .onConflictDoUpdate({
          target: [issueFieldValues.issueId, issueFieldValues.fieldId],
          set: row,
        });
    } else {
      await ctx.tx
        .delete(issueFieldValues)
        .where(and(eq(issueFieldValues.issueId, issueId), eq(issueFieldValues.fieldId, id)));
    }
    changes.push({ field: `customField:${id}`, from: before, to: after });
  }
  return changes;
}

/** Drops values of team fields that don't belong to `teamId` (after a move to it). */
export async function dropForeignFieldValues(ctx: Ctx, issueId: string, teamId: string) {
  await ctx.tx.execute(sql`delete from issue_field_values v using custom_fields f
    where v.field_id = f.id and v.issue_id = ${issueId} and f.team_id is not null and f.team_id <> ${teamId}`);
}
