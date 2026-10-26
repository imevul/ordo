import { lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sessions } from './db/schema.ts';
import { sweepAttachments } from './services/attachments.ts';
import { runChatNotification, runChatPost } from './services/chat.ts';
import { sendNotificationEmails } from './services/digest.ts';
import { dispatchEvents, pruneEvents } from './services/events.ts';
import { purgeOldExports, runExport } from './services/exports.ts';
import { runAnalyze, runImport } from './services/imports/engine.ts';
import { runUndo } from './services/imports/undo.ts';
import {
  runInbound,
  runIntegrationEvent,
  runPoll,
  schedulePolls,
} from './services/integrations.ts';
import type { Email } from './services/mail-templates.ts';
import { purgeExpiredStates } from './services/sso.ts';
import { purgeExpiredTokens } from './services/tokens.ts';
import { deliverWebhook } from './services/webhooks.ts';

/** Registers every background job and schedule. Add new job types here. */
export function registerJobs(app: FastifyInstance) {
  const { jobs } = app;

  jobs.define<{ to: string; email: Email }>('email.send', async ({ to, email }) => {
    await app.mailer.send(to, email);
  });

  jobs.define('notifications.email', () => sendNotificationEmails(app));
  jobs.every('notifications.email', 60);

  // The outbox: one dispatch per transaction, then one job per webhook delivery / integration.
  jobs.define<{ workspaceId: string; ids: number[] }>('events.dispatch', (p) =>
    dispatchEvents(app, p),
  );
  jobs.define<{ deliveryId: string }>('webhook.deliver', (p, job) => deliverWebhook(app, p, job));
  jobs.define<Parameters<typeof runIntegrationEvent>[1]>('integration.event', (p, job) =>
    runIntegrationEvent(app, p, job),
  );
  jobs.define<Parameters<typeof runInbound>[1]>('integration.inbound', (p, job) =>
    runInbound(app, p, job),
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
  jobs.define<{ exportId: string }>('export.run', (p, job) => runExport(app, p, job));

  jobs.define('maintenance.cleanup', async () => {
    await pruneEvents(app);
    await purgeExpiredTokens(app.db);
    await purgeExpiredStates(app);
    await purgeOldExports(app);
    await sweepAttachments(app);
    await app.db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));
    // Dead jobs stay for a week so admins can see what failed.
    await app.db.execute(
      sql`delete from jobs where status = 'dead' and created_at < now() - interval '7 days'`,
    );
  });
  jobs.every('maintenance.cleanup', 3600);
}
