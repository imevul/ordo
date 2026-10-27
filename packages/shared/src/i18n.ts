import type { Locale } from './constants.ts';

/**
 * The message format shared by the web app and the API (emails, push, chat). A catalogue is a tree
 * of `{name}` templates; a message whose wording depends on a number is an object of plural forms
 * picked by `count`. English is the source; a translation may leave messages out and falls back.
 */

export type Plural = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};
export type Message = string | Plural;
type Tree = { [key: string]: Message | Tree };
export type MessageParams = Record<string, string | number>;

/** A translation of catalogue `T`: the same shape, any part of it may be missing. */
export type Translation<T> = {
  [K in keyof T]?: T[K] extends string ? string : T[K] extends Plural ? Plural : Translation<T[K]>;
};

/** Every message key of a catalogue, as dotted paths. */
export type MessagePaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends Message ? `${P}${K}` : MessagePaths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** BCP 47 tags for Intl: en follows US month-first dates, which Ordo has always shown. */
export const INTL_TAG: Record<Locale, string> = { en: 'en-US', sv: 'sv-SE', nb: 'nb-NO' };

export function lookupMessage(tree: object | null | undefined, key: string): Message | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' || (node && typeof node === 'object' && 'other' in node)
    ? (node as Message)
    : undefined;
}

/** The text of a message for `count`, in the plural forms of `locale`. */
export function pluralForm(msg: Message, count: unknown, rules: Intl.PluralRules): string {
  if (typeof msg === 'string') return msg;
  const n = typeof count === 'number' ? count : Number(count ?? 0);
  return msg[rules.select(n) as keyof Plural] ?? msg.other;
}

/** Fills `{name}` placeholders; numbers are formatted for the locale, unknown names are kept. */
export function fillMessage(
  text: string,
  params: MessageParams | undefined,
  numbers: Intl.NumberFormat,
) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    if (v === undefined) return m;
    return typeof v === 'number' ? numbers.format(v) : v;
  });
}

/**
 * A `t()` for one locale over a source catalogue and its translations: the translation's message,
 * else English, else the key itself (so a typo is easy to spot).
 */
export function translator<T extends Tree>(
  source: T,
  translations: Partial<Record<Locale, Translation<T>>>,
  locale: Locale,
) {
  const catalog = translations[locale] ?? null;
  const rules = new Intl.PluralRules(INTL_TAG[locale]);
  const numbers = new Intl.NumberFormat(INTL_TAG[locale]);
  return (key: MessagePaths<T>, params?: MessageParams): string => {
    const msg = lookupMessage(catalog, key) ?? lookupMessage(source, key);
    if (msg === undefined) return key;
    return fillMessage(pluralForm(msg, params?.count, rules), params, numbers);
  };
}

/** Message paths of a catalogue, plural forms counted as one message. */
export function messagePaths(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' || 'other' in v ? [`${prefix}${k}`] : messagePaths(v, `${prefix}${k}.`),
  );
}

/**
 * What's wrong with a translation: messages English doesn't have, and messages whose `{placeholders}`
 * or `<tags>` differ from English. Used by the catalogue tests.
 */
export function catalogueProblems(source: object, translation: object): string[] {
  const english = new Set(messagePaths(source));
  const marks = (msg: unknown) =>
    [...JSON.stringify(msg ?? null).matchAll(/\{(\w+)\}|<(\w+)>/g)]
      .map((m) => m[0])
      .sort()
      .join();
  return messagePaths(translation).flatMap((path) => {
    if (!english.has(path)) return [`${path}: not in English`];
    const theirs = marks(lookupMessage(translation, path));
    const ours = marks(lookupMessage(source, path));
    return theirs === ours ? [] : [`${path}: ${theirs} ≠ ${ours}`];
  });
}

/** How many English messages a translation leaves out. */
export const missingMessages = (source: object, translation: object) => {
  const have = new Set(messagePaths(translation));
  return messagePaths(source).filter((p) => !have.has(p));
};
