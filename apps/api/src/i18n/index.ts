import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type MessagePaths,
  translator,
  type UserPreferences,
} from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { users } from '../db/schema.ts';
import en from './en.ts';
import nb from './nb.ts';
import sv from './sv.ts';

export type ServerMessageKey = MessagePaths<typeof en>;
export type ServerT = (key: ServerMessageKey, params?: Record<string, string | number>) => string;

const cache = new Map<Locale, ServerT>();

/** `t()` for what the server writes to one person: emails, push notifications, chat messages. */
export function serverT(locale: Locale): ServerT {
  let tr = cache.get(locale);
  if (!tr) {
    tr = translator(en, { sv, nb }, locale);
    cache.set(locale, tr);
  }
  return tr;
}

/** The language someone reads in, from their stored preferences (English if unset or unknown). */
export function localeOf(prefs: Partial<UserPreferences> | null | undefined): Locale {
  const v = prefs?.locale;
  return v && LOCALES.includes(v) ? v : DEFAULT_LOCALE;
}

/** The language of the user with this id (English for someone unknown). */
export async function userLocale(db: DbOrTx, userId: string | null | undefined): Promise<Locale> {
  if (!userId) return DEFAULT_LOCALE;
  const [row] = await db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, userId));
  return localeOf(row?.preferences);
}

/**
 * The language to write to an email address in: its account's, if it has one, else the language of
 * `fallbackUserId` (an invite reads like the person who sent it).
 */
export async function localeForEmail(
  db: DbOrTx,
  email: string,
  fallbackUserId: string | null | undefined,
): Promise<Locale> {
  const [row] = await db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.email, email.toLowerCase()));
  return row ? localeOf(row.preferences) : userLocale(db, fallbackUserId);
}

export const serverCatalogues = { en, sv, nb };
