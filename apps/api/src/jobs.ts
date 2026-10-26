import { lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sessions } from './db/schema.ts';
import { sendNotificationEmails } from './services/digest.ts';
import type { Email } from './services/mail-templates.ts';
import { purgeExpiredTokens } from './services/tokens.ts';

/** Registers every background job and schedule. Add new job types here. */
export function registerJobs(app: FastifyInstance) {
  const { jobs } = app;

  jobs.define<{ to: string; email: Email }>('email.send', async ({ to, email }) => {
    await app.mailer.send(to, email);
  });

  jobs.define('notifications.email', () => sendNotificationEmails(app));
  jobs.every('notifications.email', 60);

  jobs.define('maintenance.cleanup', async () => {
    await purgeExpiredTokens(app.db);
    await app.db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));
    // Dead jobs stay for a week so admins can see what failed.
    await app.db.execute(
      sql`delete from jobs where status = 'dead' and created_at < now() - interval '7 days'`,
    );
  });
  jobs.every('maintenance.cleanup', 3600);
}
