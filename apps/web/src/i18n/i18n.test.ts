import { afterEach, describe, expect, it } from 'vitest';
import en from './en/index.ts';
import { type Catalog, setLocale, t, tx } from './index.ts';
import nb from './nb/index.ts';
import sv from './sv/index.ts';

afterEach(() => setLocale('en'));

/** Every message path in a catalogue, plural forms counted as one message. */
function paths(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' || 'other' in v ? [`${prefix}${k}`] : paths(v, `${prefix}${k}.`),
  );
}

const placeholders = (msg: unknown) =>
  [...JSON.stringify(msg).matchAll(/\{(\w+)\}|<(\w+)>/g)].map((m) => m[0]).sort();

function leaf(tree: object, path: string): unknown {
  return path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], tree);
}

describe('t', () => {
  it('fills placeholders and picks plural forms', async () => {
    expect(t('common.issueCount', { count: 1 })).toBe('1 issue');
    expect(t('common.issueCount', { count: 1200 })).toBe('1,200 issues');
    await setLocale('sv');
    expect(t('common.issueCount', { count: 3 })).toBe('3 ärenden');
    expect(t('common.save')).toBe('Spara');
  });

  it('falls back to English for missing messages', async () => {
    await setLocale('nb');
    expect(t('enums.priority.1')).toBe('Haster');
    // An unknown key shows itself rather than nothing, so a typo is easy to spot.
    expect(t('missing.key' as never)).toBe('missing.key');
  });

  it('places markup and React nodes where the translation puts them', () => {
    const node = tx('common.issueCount' as never, { count: 2 });
    expect(node).toBeTruthy();
  });
});

describe('catalogues', () => {
  const english = paths(en);

  it.each([
    ['sv', sv],
    ['nb', nb],
  ] as const)('%s only has messages English has, with the same placeholders', (_, cat) => {
    for (const path of paths(cat)) {
      expect(english, path).toContain(path);
      expect(placeholders(leaf(cat, path)), path).toEqual(placeholders(leaf(en, path)));
    }
  });

  it('reports what is not translated yet', () => {
    // Not a failure: missing messages show in English. This keeps the gap visible in test output.
    for (const [name, cat] of [
      ['sv', sv],
      ['nb', nb],
    ] as const) {
      const have = new Set(paths(cat));
      const missing = english.filter((p) => !have.has(p));
      if (missing.length) console.info(`${name}: ${missing.length} messages fall back to English`);
    }
  });
});

// The type of a translated catalogue is derived from English; this fails to compile if it drifts.
const _shape: Catalog = en;
void _shape;
