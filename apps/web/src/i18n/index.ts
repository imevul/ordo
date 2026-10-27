import { DEFAULT_LOCALE, LOCALES, type Locale } from '@ordo/shared';
import { createElement, Fragment, type ReactNode } from 'react';
import { readPref, writePref } from '../lib/store.ts';
import en from './en/index.ts';

/**
 * Translations. English (en/) is the source and the fallback: sv/ and nb/ may leave messages
 * out, and t() then shows the English one. Messages are `{name}` templates; a message whose
 * wording depends on a number is an object of plural forms ({ one, other }) picked by `count`.
 *
 * The language is fixed for the life of the page: main.tsx loads it before the first render, and
 * switching (switchLocale) reloads the page. So components call t() during render and nothing
 * needs to subscribe, and nothing rendered in the old language is left behind.
 */

export type Plural = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};
type Leaf = string | Plural;
type Tree = { [key: string]: Leaf | Tree };

export type Catalog = typeof en;

/** A translation: the same shape as English, any part of it may be missing. */
export type Translation<T = Catalog> = {
  [K in keyof T]?: T[K] extends string ? string : T[K] extends Plural ? Plural : Translation<T[K]>;
};

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends Leaf ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Paths<Catalog>;
export type Params = Record<string, string | number>;

const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Translation }>> = {
  sv: () => import('./sv/index.ts'),
  nb: () => import('./nb/index.ts'),
};

/** BCP 47 tags for Intl: en follows US month-first dates, which Ordo has always shown. */
export const INTL_TAG: Record<Locale, string> = { en: 'en-US', sv: 'sv-SE', nb: 'nb-NO' };

let locale: Locale = DEFAULT_LOCALE;
let catalog: Translation | null = null;
let plurals = new Intl.PluralRules(INTL_TAG[locale]);

export const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale);

export const getLocale = () => locale;

/** Loads `next`'s messages and uses them from now on. Call before rendering (main.tsx, tests). */
export async function setLocale(next: Locale) {
  if (!isLocale(next)) next = DEFAULT_LOCALE;
  const loaded = next === 'en' ? null : (await LOADERS[next]()).default;
  locale = next;
  catalog = loaded;
  plurals = new Intl.PluralRules(INTL_TAG[next]);
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

/**
 * Shows the app in `next`: remembers it for this browser and reloads. Does nothing if it's
 * already the language, or if the choice can't be stored (that would reload forever).
 */
export function switchLocale(next: Locale) {
  if (!isLocale(next) || next === locale) return;
  writePref('locale', next);
  if (storedLocale() === next) location.reload();
}

/** The language this browser last used (the signed-in person's choice), before /me answers. */
export const storedLocale = (): Locale => {
  const v = readPref<string>('locale', DEFAULT_LOCALE);
  return isLocale(v) ? v : DEFAULT_LOCALE;
};

function lookup(tree: Tree | Translation | null, key: string): Leaf | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' || (node && typeof node === 'object' && 'other' in node)
    ? (node as Leaf)
    : undefined;
}

function pick(key: string, count: unknown): string {
  const msg = (catalog && lookup(catalog, key)) ?? lookup(en as Tree, key);
  if (msg === undefined) return key;
  if (typeof msg === 'string') return msg;
  const n = typeof count === 'number' ? count : Number(count ?? 0);
  return msg[plurals.select(n) as keyof Plural] ?? msg.other;
}

/** The message for `key` in the current language, with `{name}` placeholders filled in. */
export function t(key: MessageKey, params?: Params): string {
  const msg = pick(key, params?.count);
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? formatParam(params[name]!) : m,
  );
}

const formatParam = (v: string | number) =>
  typeof v === 'number' ? new Intl.NumberFormat(INTL_TAG[locale]).format(v) : v;

/**
 * t() for messages with markup: `{name}` placeholders may be React nodes, and `<tag>…</tag>`
 * spans are passed to the function of that name, so a translation can move the link or the bold
 * word to wherever its grammar needs it. `"Assigned to <b>{name}</b>"` with
 * `{ name, b: (s) => <strong>{s}</strong> }`.
 */
export function tx(
  key: MessageKey,
  params: Record<string, ReactNode | ((chunk: ReactNode) => ReactNode)> = {},
): ReactNode {
  const msg = pick(key, params.count);
  const fill = (text: string): ReactNode[] =>
    text.split(/(\{\w+\})/g).map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return part;
      const v = params[m[1]!];
      if (v === undefined || typeof v === 'function') return part;
      return createElement(Fragment, { key: `p${i}` }, typeof v === 'number' ? formatParam(v) : v);
    });
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  for (let m = re.exec(msg); m; m = re.exec(msg)) {
    out.push(...fill(msg.slice(last, m.index)));
    const wrap = params[m[1]!];
    const inner = fill(m[2]!);
    out.push(
      createElement(
        Fragment,
        { key: `t${m.index}` },
        typeof wrap === 'function' ? wrap(inner) : inner,
      ),
    );
    last = m.index + m[0].length;
  }
  out.push(...fill(msg.slice(last)));
  return createElement(Fragment, null, ...out);
}
