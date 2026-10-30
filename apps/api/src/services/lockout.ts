import { and, count, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditLog } from '../db/schema.ts';
import { HttpError } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from './audit.ts';

/** Route options for every route that checks a password or a second factor (per address). */
export const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

// Per account, whatever address the attempts come from: wrong passwords and wrong second factors,
// at sign-in and when confirming a change in account settings alike.
export const LOCKOUT_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

export async function failedAttempts(db: FastifyInstance['db'], userId: string) {
  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000).toISOString();
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorId, userId),
        eq(auditLog.action, 'auth.login_failed'),
        gt(auditLog.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

export const lockedOut = () =>
  new HttpError(
    429,
    `Too many failed sign-in attempts. Try again in ${LOCKOUT_MINUTES} minutes.`,
    'rate_limited',
  ).as('too_many_attempts', { minutes: LOCKOUT_MINUTES });

export async function assertNotLockedOut(db: FastifyInstance['db'], userId: string) {
  if ((await failedAttempts(db, userId)) >= LOCKOUT_ATTEMPTS) throw lockedOut();
}

/** Counts a wrong password or code from a signed-in person towards the lockout. */
export async function recordFailedCheck(
  db: FastifyInstance['db'],
  req: FastifyRequest,
  userId: string,
  method: 'password' | 'totp',
) {
  await audit(
    db,
    { action: 'auth.login_failed', actorId: userId, data: { method, route: req.routeOptions.url } },
    requestMeta(req),
  );
}
