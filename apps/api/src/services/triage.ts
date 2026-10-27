import type { TriageActions, TriageConditions, TriageRule, TriageSource } from '@ordo/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { integrations, issueLabels, issues, triageRules } from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import { systemAccess } from './access.ts';
import { automationBot } from './automation.ts';
import type { ActorSource, Ctx } from './context.ts';
import { assertAssignee, assertLabels, stateOf, updateIssue } from './issues.ts';

export const toTriageRule = (r: typeof triageRules.$inferSelect): TriageRule => ({
  id: r.id,
  teamId: r.teamId,
  name: r.name,
  enabled: r.enabled,
  position: r.position,
  conditions: r.conditions,
  actions: r.actions,
});

export async function triageRulesOf(db: DbOrTx, teamIds: string[]) {
  if (teamIds.length === 0) return [];
  return db
    .select()
    .from(triageRules)
    .where(inArray(triageRules.teamId, teamIds))
    .orderBy(asc(triageRules.position), asc(triageRules.createdAt));
}

/** That a rule's labels, people and status make sense in its team. */
export async function assertTriageRule(
  ctx: Ctx,
  teamId: string,
  rule: { conditions?: TriageConditions; actions?: TriageActions },
) {
  const a = rule.actions ?? {};
  await assertLabels(ctx, teamId, [...(rule.conditions?.labelIds ?? []), ...(a.labelIds ?? [])]);
  for (const userId of [...(a.assigneeId ? [a.assigneeId] : []), ...(a.rotation ?? [])])
    await assertAssignee(ctx, teamId, userId);
  if (a.stateId) {
    const state = await stateOf(ctx, teamId, a.stateId);
    if (state.type === 'triage') throw badRequest('Accept into a status outside triage');
  }
}

/** Where an issue came from, as rules name it: email intake is its own source. */
async function sourceOf(ctx: Ctx): Promise<TriageSource | 'system' | 'import'> {
  const source: ActorSource = ctx.source;
  if (!source.startsWith('integration:')) return source as TriageSource;
  const [row] = await ctx.tx
    .select({ provider: integrations.provider })
    .from(integrations)
    .where(eq(integrations.id, source.slice('integration:'.length)));
  return row?.provider === 'email' ? 'email' : 'integration';
}

/**
 * Runs the team's enabled triage rules, in order, on an issue just created in triage. Every
 * matching rule applies (later ones win for single values; labels add up), as the Ordo bot, so the
 * history says a rule did it.
 */
export async function applyTriageRules(ctx: Ctx, issueId: string, teamId: string) {
  const rules = (await triageRulesOf(ctx.tx, [teamId])).filter((r) => r.enabled);
  if (rules.length === 0) return;
  const [issue] = await ctx.tx.select().from(issues).where(eq(issues.id, issueId));
  const labels = (
    await ctx.tx
      .select({ id: issueLabels.labelId })
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issueId))
  ).map((l) => l.id);
  const source = await sourceOf(ctx);
  const text = `${issue!.title}\n${issue!.description}`.toLowerCase();

  const patch: Parameters<typeof updateIssue>[2] = {};
  const addLabels = new Set<string>();
  for (const rule of rules) {
    const c = rule.conditions;
    if (c.sources?.length && !c.sources.includes(source as TriageSource)) continue;
    if (c.text && !text.includes(c.text.toLowerCase())) continue;
    if (c.labelIds?.length && !c.labelIds.some((l) => labels.includes(l))) continue;
    if (c.priorities?.length && !c.priorities.includes(issue!.priority)) continue;
    const a = rule.actions;
    if (a.priority !== undefined) patch.priority = a.priority;
    for (const l of a.labelIds ?? []) addLabels.add(l);
    if (a.stateId) patch.stateId = a.stateId;
    if (a.rotation?.length) {
      // Take a turn atomically, so two issues at once go to different people.
      const [{ turn }] = (await ctx.tx
        .update(triageRules)
        .set({ turn: sql`${triageRules.turn} + 1` })
        .where(eq(triageRules.id, rule.id))
        .returning({ turn: triageRules.turn })) as [{ turn: number }];
      patch.assigneeId = a.rotation[(turn - 1) % a.rotation.length];
    } else if (a.assigneeId) patch.assigneeId = a.assigneeId;
  }
  if (addLabels.size) patch.addLabelIds = [...addLabels];
  if (Object.keys(patch).length === 0) return;

  const botId = await automationBot(ctx.tx, ctx.workspaceId);
  const asBot: Ctx = { ...ctx, userId: botId, access: systemAccess(ctx.workspaceId, botId) };
  // People or labels can go stale after the rule was written; skip what no longer fits.
  await ctx.tx
    .transaction((tx) => updateIssue({ ...asBot, tx }, issueId, patch))
    .catch(async () => {
      const { assigneeId, addLabelIds, ...rest } = patch;
      if (Object.keys(rest).length) await updateIssue(asBot, issueId, rest);
    });
}
