import { and, count, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditLog } from '../db/schema.ts';
import { HttpError } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from './audit.ts';

/** Route options for every route that checks a password or a second factor (per address). */
export const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

// Per account, whatever address the attempts come from: wrong passwords and wrong second factors.
// Sign-in and confirmations by a signed-in person count separately: anyone can send wrong passwords
// for an email address, and that mustn't stop the owner from changing their password meanwhile;
// nor should a stolen session guessing the password lock the owner out of signing in.
export const LOCKOUT_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

type FailedAction = 'auth.login_failed' | 'auth.confirm_failed';

async function countFailures(db: FastifyInstance['db'], userId: string, action: FailedAction) {
  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000).toISOString();
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(eq(auditLog.actorId, userId), eq(auditLog.action, action), gt(auditLog.createdAt, since)),
    );
  return row?.n ?? 0;
}

/** Failed sign-ins (password or second factor) for the account. */
export const failedAttempts = (db: FastifyInstance['db'], userId: string) =>
  countFailures(db, userId, 'auth.login_failed');

export const lockedOut = () =>
  new HttpError(
    429,
    `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`,
    'rate_limited',
  ).as('too_many_attempts', { minutes: LOCKOUT_MINUTES });

/** For a signed-in person confirming a change: only their own failed confirmations count. */
export async function assertNotLockedOut(db: FastifyInstance['db'], userId: string) {
  if ((await countFailures(db, userId, 'auth.confirm_failed')) >= LOCKOUT_ATTEMPTS)
    throw lockedOut();
}

/** Counts a wrong password or code from a signed-in person towards their confirmation lockout. */
export async function recordFailedCheck(
  db: FastifyInstance['db'],
  req: FastifyRequest,
  userId: string,
  method: 'password' | 'totp',
) {
  await audit(
    db,
    {
      action: 'auth.confirm_failed',
      actorId: userId,
      data: { method, route: req.routeOptions.url },
    },
    requestMeta(req),
  );
}
