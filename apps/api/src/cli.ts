/**
 * Recovery and maintenance commands, for when you can't (or can no longer) do it in the app.
 *
 *   node cli.mjs promote-admin <email>     make someone an instance admin
 *   node cli.mjs reset-password <email>    print a one-hour password reset link
 *   node cli.mjs disable-2fa <email>       turn off two-factor authentication for someone
 *   node cli.mjs rotate-key                re-encrypt 2FA secrets and SMTP with the current ORDO_SECRET_KEY
 *
 * In Docker: `make admin EMAIL=…`, `make reset-password EMAIL=…`, or
 * `docker compose exec app node cli.mjs <command>`.
 */
import { eq, isNotNull } from 'drizzle-orm';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { passkeys, recoveryCodes, users } from './db/schema.ts';
import { loadEnv } from './env.ts';
import { Keyring } from './lib/secrets.ts';
import { audit } from './services/audit.ts';
import { Settings } from './services/settings.ts';
import { createToken } from './services/tokens.ts';

const [command, arg] = process.argv.slice(2);
const env = loadEnv();
const { db, sql } = createDb(env.databaseUrl);
const silentLog = {
  error: console.error,
  warn: () => {},
  info: () => {},
  debug: () => {},
} as never;

async function findUser(email: string | undefined) {
  if (!email) throw new Error('Pass an email address');
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (!user) throw new Error(`No user with email ${email}`);
  return user;
}

async function main() {
  await runMigrations(db);
  switch (command) {
    case 'promote-admin': {
      const user = await findUser(arg);
      await db
        .update(users)
        .set({ isInstanceAdmin: true, disabledAt: null })
        .where(eq(users.id, user.id));
      await audit(db, {
        action: 'admin.user_updated',
        actorId: null,
        targetType: 'user',
        targetId: user.id,
        data: { isInstanceAdmin: true, via: 'cli' },
      });
      console.log(`${user.email} is now an instance admin.`);
      break;
    }
    case 'reset-password': {
      const user = await findUser(arg);
      const token = await createToken(db, user.id, 'password_reset', 60);
      console.log(
        `Reset link for ${user.email} (valid for one hour):\n${env.publicUrl}/reset-password/${token}`,
      );
      break;
    }
    case 'disable-2fa': {
      const user = await findUser(arg);
      await db
        .update(users)
        .set({ totpEnabledAt: null, totpSecret: null })
        .where(eq(users.id, user.id));
      await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
      // Passkeys are a second factor too; someone locked out has lost them as well.
      await db.delete(passkeys).where(eq(passkeys.userId, user.id));
      await audit(db, {
        action: 'auth.2fa_disabled',
        actorId: null,
        targetType: 'user',
        targetId: user.id,
        data: { via: 'cli' },
      });
      console.log(`Two-factor authentication is off for ${user.email}.`);
      break;
    }
    case 'rotate-key': {
      const keyring = new Keyring(env.secretKey, env.previousSecretKey);
      if (!keyring.available) throw new Error('ORDO_SECRET_KEY is not set');
      let n = 0;
      for (const u of await db.select().from(users).where(isNotNull(users.totpSecret))) {
        const aad = `users:${u.id}:totp_secret`;
        if (!keyring.needsRotation(u.totpSecret!)) continue;
        await db
          .update(users)
          .set({ totpSecret: keyring.encrypt(keyring.decrypt(u.totpSecret!, aad), aad) })
          .where(eq(users.id, u.id));
        n++;
      }
      const settings = new Settings(db, sql, {}, silentLog);
      await settings.reload();
      const smtp = settings.get('smtp');
      if (smtp?.url.startsWith('v1.') && keyring.needsRotation(smtp.url)) {
        const aad = 'instance_settings:smtp:url';
        await settings.set(
          'smtp',
          { ...smtp, url: keyring.encrypt(keyring.decrypt(smtp.url, aad), aad) },
          null,
        );
        n++;
      }
      console.log(
        `Re-encrypted ${n} secret(s) (two-factor secrets and SMTP). Keep ORDO_SECRET_KEY_PREVIOUS set: other stored secrets move to the new key only when they're saved again.`,
      );
      break;
    }
    default:
      console.log(
        'Commands: promote-admin <email> | reset-password <email> | disable-2fa <email> | rotate-key',
      );
      process.exitCode = command ? 1 : 0;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
