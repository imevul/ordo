import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { issues } from '../db/schema.ts';
import { runAutomation } from './automation.ts';
import { notify, subscriberIds } from './notifications.ts';

/**
 * Every few minutes: open issues whose SLA ran out are announced once, to their assignee and
 * subscribers, in their inbox (and by email and chat, per their settings).
 */
export async function announceSlaBreaches(app: FastifyInstance) {
  const breached = await app.db.execute<{
    id: string;
    workspace_id: string;
    assignee_id: string | null;
  }>(sql`
    select i.id, i.workspace_id, i.assignee_id from issues i
    join workflow_states s on s.id = i.state_id
    where i.sla_breaches_at <= now() and i.sla_notified_at is null
      and i.deleted_at is null and s.type not in ('completed', 'canceled')
    limit 500`);
  for (const issue of breached) {
    await runAutomation(app, issue.workspace_id, async (ctx) => {
      const subscribers = await subscriberIds(ctx, issue.id);
      await notify(ctx, {
        userIds: [issue.assignee_id, ...subscribers],
        type: 'issue_sla_breached',
        issueId: issue.id,
      });
      await ctx.tx
        .update(issues)
        .set({ slaNotifiedAt: new Date().toISOString() })
        .where(sql`${issues.id} = ${issue.id}`);
    });
  }
}
