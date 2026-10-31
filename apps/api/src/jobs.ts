import { lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sessions } from './db/schema.ts';
import { reapLeases, restartAfterLimits } from './services/agents.ts';
import { sweepAttachments } from './services/attachments.ts';
import { autoArchive, forEachIsolated } from './services/automation.ts';
import { runAutomationEvent, runAutomationRules } from './services/automationRules.ts';
import { runChatNotification, runChatPost } from './services/chat.ts';
import { automateCycles } from './services/cycle-automation.ts';
import { sendNotificationEmails } from './services/digest.ts';
import { dispatchEvents, pruneEvents } from './services/events.ts';
import { failExport, purgeOldExports, runExport } from './services/exports.ts';
import { runAnalyze, runImport } from './services/imports/engine.ts';
import { runUndo } from './services/imports/undo.ts';
import {
  runInbound,
  runIntegrationEvent,
  runIssueInbound,
  runPoll,
  schedulePolls,
} from './services/integrations.ts';
import type { Email } from './services/mail-templates.ts';
import { wakeSnoozed } from './services/notifications.ts';
import { pruneOAuth } from './services/oauth.ts';
import { purgeExpiredChallenges } from './services/passkeys.ts';
import { runPush } from './services/push.ts';
import { runRecurring } from './services/recurring.ts';
import { announceSlaBreaches } from './services/sla.ts';
import { purgeExpiredStates } from './services/sso.ts';
import { expireStatuses } from './services/status.ts';
import { pruneChanges } from './services/sync.ts';
import { purgeExpiredTokens } from './services/tokens.ts';
import { deliverWebhook } from './services/webhooks.ts';

/** Registers every background job and schedule. Add new job types here. */
export function registerJobs(app: FastifyInstance) {
  const { jobs } = app;

  jobs.define<{ to: string; email: Email }>('email.send', async ({ to, email }) => {
    await app.mailer.send(to, email);
  });

  jobs.define('notifications.email', () => sendNotificationEmails(app));
  jobs.define('notifications.wake', () => wakeSnoozed(app));
  jobs.define<{ notificationId: string }>('push.notify', (p) => runPush(app, p));
  jobs.every('notifications.wake', 60);
  jobs.every('notifications.email', 60);
  jobs.define('users.statusExpire', () => expireStatuses(app));
  jobs.every('users.statusExpire', 60);
  jobs.define('agents.leases', () => reapLeases(app));
  jobs.every('agents.leases', 60);
  jobs.define('agents.restart', () => restartAfterLimits(app));
  jobs.every('agents.restart', 60);

  // The outbox: one dispatch per transaction, then one job per webhook delivery / integration.
  jobs.define<{ workspaceId: string; ids: number[] }>('events.dispatch', (p) =>
    dispatchEvents(app, p),
  );
  // Automation rules: one run per issue event, plus pull request triggers from forges.
  jobs.define<Parameters<typeof runAutomationEvent>[1]>('automations.event', (p) =>
    runAutomationEvent(app, p),
  );
  jobs.define<Parameters<typeof runAutomationRules>[1]>('automations.run', (p) =>
    runAutomationRules(app, p),
  );
  jobs.define<{ deliveryId: string }>('webhook.deliver', (p, job) => deliverWebhook(app, p, job));
  jobs.define<Parameters<typeof runIntegrationEvent>[1]>('integration.event', (p, job) =>
    runIntegrationEvent(app, p, job),
  );
  jobs.define<Parameters<typeof runInbound>[1]>('integration.inbound', (p, job) =>
    runInbound(app, p, job),
  );
  jobs.define<Parameters<typeof runIssueInbound>[1]>('integration.issue', (p, job) =>
    runIssueInbound(app, p, job),
  );
  jobs.define<{ integrationId: string }>('integration.poll', (p, job) => runPoll(app, p, job));
  jobs.define<Parameters<typeof runChatPost>[1]>('chat.post', (p, job) => runChatPost(app, p, job));
  jobs.define<Parameters<typeof runChatNotification>[1]>('chat.notify', (p, job) =>
    runChatNotification(app, p, job),
  );
  jobs.define('integrations.poll', () => schedulePolls(app));
  jobs.every('integrations.poll', 60);

  jobs.define<{ importId: string }>('import.analyze', (p, job) => runAnalyze(app, p, job));
  jobs.define<Parameters<typeof runImport>[1]>('import.run', (p, job) => runImport(app, p, job));
  jobs.define<{ importId: string }>('import.undo', (p, job) => runUndo(app, p, job));
  jobs.define<{ exportId: string }>('export.run', (p, job) => runExport(app, p, job), {
    onDead: (p, error) => failExport(app, p, error),
  });

  // Cycle dates are days, so hourly is plenty; a missed run catches up on the next.
  jobs.define('cycles.automate', () => automateCycles(app));
  jobs.every('cycles.automate', 3600);
  jobs.define('issues.sla', () => announceSlaBreaches(app));
  jobs.every('issues.sla', 300);
  jobs.define('issues.recur', () => runRecurring(app));
  jobs.every('issues.recur', 3600);
  jobs.define('issues.autoArchive', () => autoArchive(app));
  jobs.every('issues.autoArchive', 3600);

  jobs.define('maintenance.cleanup', async () => {
    await runMaintenance(app);
  });
  jobs.every('maintenance.cleanup', 3600);
}

/** Hourly housekeeping. The steps are independent, so one that fails doesn't skip the rest. */
export async function runMaintenance(app: FastifyInstance) {
  const steps: [string, () => Promise<unknown>][] = [
    ['events', () => pruneEvents(app)],
    ['tokens', () => purgeExpiredTokens(app.db)],
    ['challenges', () => purgeExpiredChallenges(app.db)],
    ['oauth', () => pruneOAuth(app.db)],
    ['ssoStates', () => purgeExpiredStates(app)],
    ['changes', () => pruneChanges(app.db)],
    ['exports', () => purgeOldExports(app)],
    ['attachments', () => sweepAttachments(app)],
    [
      'sessions',
      () => app.db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())),
    ],
    // Dead jobs stay for a week so admins can see what failed.
    [
      'deadJobs',
      () =>
        app.db.execute(
          sql`delete from jobs where status = 'dead' and created_at < now() - interval '7 days'`,
        ),
    ],
  ];
  return forEachIsolated(
    app,
    'maintenance.cleanup',
    steps,
    ([step]) => ({ step }),
    ([, run]) => run(),
  );
}
