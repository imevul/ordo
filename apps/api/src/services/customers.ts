import type {
  CreateCustomerInput,
  Customer,
  CustomerRequest,
  CustomerRequestWithIssue,
} from '@ordo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { customerRequests, customers } from '../db/schema.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { type Access, assertCan } from './access.ts';
import { type Ctx, emit } from './context.ts';
import { getIssue } from './issues.ts';
import { assertProjectLead } from './projects.ts';

/** Email providers whose domains say nothing about a company. */
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  'yandex.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
  'qq.com',
  '163.com',
]);

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc']);

export const toRequest = (r: typeof customerRequests.$inferSelect): CustomerRequest => ({
  id: r.id,
  customerId: r.customerId,
  issueId: r.issueId,
  body: r.body,
  contact: r.contact,
  source: r.source,
  createdById: r.createdById,
  createdAt: r.createdAt,
});

/** Customers aren't for guests: they'd learn who else the workspace works with. */
function assertNotGuest(access: Access) {
  if (access.isGuest) throw forbidden('Guests cannot see customers');
}

/**
 * The workspace's customers, with how many requests (and still-open issues) they have among the
 * issues `access` can see.
 */
export async function listCustomers(db: DbOrTx, access: Access): Promise<Customer[]> {
  if (access.isGuest) return [];
  const scope = access.isAdmin
    ? sql``
    : access.teamIds.length
      ? sql` and i.team_id in (${sql.join(
          access.teamIds.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql` and false`;
  const counts = await db.execute<{ customer_id: string; requests: number; open: number }>(sql`
    select r.customer_id, count(*)::int as requests,
      count(distinct i.id) filter (where s.type not in ('completed', 'canceled'))::int as open
    from customer_requests r
    join issues i on i.id = r.issue_id and i.deleted_at is null
    join workflow_states s on s.id = i.state_id
    where r.workspace_id = ${access.workspaceId}${scope}
    group by 1`);
  const byId = new Map([...counts].map((c) => [c.customer_id, c]));
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.workspaceId, access.workspaceId))
    .orderBy(asc(customers.name));
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    domains: c.domains,
    ownerId: c.ownerId,
    notes: c.notes,
    requestCount: byId.get(c.id)?.requests ?? 0,
    openIssueCount: byId.get(c.id)?.open ?? 0,
    createdAt: c.createdAt,
  }));
}

async function loadCustomer(ctx: Ctx, id: string) {
  assertCan(ctx.access, 'projects.create', 'Guests cannot manage customers');
  const [row] = await ctx.tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.workspaceId, ctx.workspaceId)));
  if (!row) throw notFound('Customer');
  return row;
}

export async function createCustomer(ctx: Ctx, input: CreateCustomerInput) {
  assertCan(ctx.access, 'projects.create', 'Guests cannot manage customers');
  await assertProjectLead(ctx, input.ownerId);
  const [row] = await ctx.tx
    .insert(customers)
    .values({ ...input, workspaceId: ctx.workspaceId })
    .returning({ id: customers.id });
  emit(ctx, { kind: 'customer', action: 'created', id: row!.id });
  return row!.id;
}

export async function updateCustomer(ctx: Ctx, id: string, input: Partial<CreateCustomerInput>) {
  await loadCustomer(ctx, id);
  if (input.ownerId) await assertProjectLead(ctx, input.ownerId);
  await ctx.tx
    .update(customers)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(eq(customers.id, id));
  emit(ctx, { kind: 'customer', action: 'updated', id });
}

export async function deleteCustomer(ctx: Ctx, id: string) {
  await loadCustomer(ctx, id);
  await ctx.tx.delete(customers).where(eq(customers.id, id));
  emit(ctx, { kind: 'customer', action: 'deleted', id });
  emit(ctx, { kind: 'issue', action: 'updated', id });
}

/** A customer's requests on issues `access` can see, newest first. */
export async function customerRequestsOf(db: DbOrTx, access: Access, customerId: string) {
  assertNotGuest(access);
  const rows = await db
    .select({ request: customerRequests })
    .from(customerRequests)
    .innerJoin(customers, eq(customers.id, customerRequests.customerId))
    .where(
      and(
        eq(customerRequests.customerId, customerId),
        eq(customers.workspaceId, access.workspaceId),
      ),
    )
    .orderBy(sql`${customerRequests.createdAt} desc`);
  const visible: CustomerRequestWithIssue[] = [];
  for (const { request } of rows) {
    const issue = await getIssue(db, access, request.issueId).catch(() => null);
    if (issue)
      visible.push({
        ...toRequest(request),
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          stateId: issue.stateId,
          teamId: issue.teamId,
        },
      });
  }
  return visible;
}

/** The requests on one issue (already known to be readable); none for guests. */
export async function requestsOnIssue(db: DbOrTx, access: Access, issueId: string) {
  if (access.isGuest) return [];
  const rows = await db
    .select()
    .from(customerRequests)
    .where(eq(customerRequests.issueId, issueId))
    .orderBy(asc(customerRequests.createdAt));
  return rows.map(toRequest);
}

export async function addCustomerRequest(
  ctx: Ctx,
  issueIdOrIdentifier: string,
  input: { customerId: string; body?: string; contact?: string | null },
  source: CustomerRequest['source'] = 'manual',
) {
  const issue = await getIssue(ctx.tx, ctx.access, issueIdOrIdentifier);
  await loadCustomer(ctx, input.customerId);
  const [row] = await ctx.tx
    .insert(customerRequests)
    .values({
      workspaceId: ctx.workspaceId,
      customerId: input.customerId,
      issueId: issue.id,
      body: input.body ?? '',
      contact: input.contact ?? null,
      source,
      createdById: ctx.userId,
    })
    .returning();
  emit(ctx, { kind: 'issue', action: 'updated', id: issue.id, teamId: issue.teamId });
  emit(ctx, { kind: 'customer', action: 'updated', id: input.customerId });
  return toRequest(row!);
}

export async function deleteCustomerRequest(ctx: Ctx, id: string) {
  const [row] = await ctx.tx
    .select()
    .from(customerRequests)
    .where(and(eq(customerRequests.id, id), eq(customerRequests.workspaceId, ctx.workspaceId)));
  if (!row) throw notFound('Customer request');
  const issue = await getIssue(ctx.tx, ctx.access, row.issueId);
  assertNotGuest(ctx.access);
  await ctx.tx.delete(customerRequests).where(eq(customerRequests.id, id));
  emit(ctx, { kind: 'issue', action: 'updated', id: issue.id, teamId: issue.teamId });
  emit(ctx, { kind: 'customer', action: 'updated', id: row.customerId });
}

/**
 * The customer an email address belongs to: by its domain, or, for free-mail addresses, by the
 * address itself (kept as the customer's name). Creates one when there's none yet.
 */
export async function customerForEmail(ctx: Ctx, email: string, displayName?: string | null) {
  const address = email.trim().toLowerCase();
  const host = address.split('@')[1] ?? '';
  const personal = FREE_MAIL.has(host);
  const [found] = personal
    ? await ctx.tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.workspaceId, ctx.workspaceId),
            sql`lower(${customers.name}) = ${address}`,
          ),
        )
    : await ctx.tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(eq(customers.workspaceId, ctx.workspaceId), sql`${host} = any(${customers.domains})`),
        );
  if (found) return found.id;
  // The company part of the domain: "globex" in mail.globex.co.uk.
  const parts = host.split('.');
  const sld = parts.length >= 3 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!);
  const name = parts.at(sld ? -3 : -2) ?? host;
  const [row] = await ctx.tx
    .insert(customers)
    .values({
      workspaceId: ctx.workspaceId,
      name: personal ? address : name.charAt(0).toUpperCase() + name.slice(1),
      domains: personal ? [] : [host],
      notes: displayName ? `First contact: ${displayName} <${address}>` : null,
    })
    .returning({ id: customers.id });
  emit(ctx, { kind: 'customer', action: 'created', id: row!.id });
  return row!.id;
}
