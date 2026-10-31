import { catalogueProblems, missingMessages } from '@ordo/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import en from './en/index.ts';
import { type Catalog, type MessageKey, setLocale, t, tx } from './index.ts';
import nb from './nb/index.ts';
import sv from './sv/index.ts';

afterEach(() => setLocale('en'));

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
    const html = renderToStaticMarkup(
      tx('issue.activity.title', {
        actor: createElement('em', null, 'Ada'),
        title: 'Fix <login>',
        b: (chunk) => createElement('strong', null, chunk),
      }),
    );
    // Values are text, not markup: the angle brackets in the title come out escaped.
    expect(html).toBe(
      '<em>Ada</em> changed the title to <strong>&quot;Fix &lt;login&gt;&quot;</strong>',
    );
    expect(renderToStaticMarkup(tx('issues.view.selected', { count: 1200 }))).toBe(
      '1,200 selected',
    );
  });
});

describe('catalogues', () => {
  it.each([
    ['sv', sv],
    ['nb', nb],
  ] as const)('%s only has messages English has, with the same placeholders', (_, cat) => {
    expect(catalogueProblems(en, cat)).toEqual([]);
  });

  it.each([
    ['sv', sv],
    ['nb', nb],
  ] as const)('%s shows every message it lacks in English', async (locale, cat) => {
    const missing = missingMessages(en, cat) as MessageKey[];
    await setLocale('en');
    const english = missing.map((key) => t(key, { count: 2 }));
    await setLocale(locale);
    expect(missing.map((key) => t(key, { count: 2 }))).toEqual(english);
    // English has them all, so none falls through to showing its key.
    expect(missing.filter((key, i) => english[i] === key)).toEqual([]);
  });
});

// The type of a translated catalogue is derived from English; this fails to compile if it drifts.
const _shape: Catalog = en;
void _shape;
