import { catalogueProblems, missingMessages } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import { serverCatalogues, serverT } from '../src/i18n/index.ts';

const { en, sv, nb } = serverCatalogues;

describe('server catalogues', () => {
  it.each([
    ['sv', sv],
    ['nb', nb],
  ] as const)('%s is complete and matches English placeholders', (_, cat) => {
    expect(catalogueProblems(en, cat)).toEqual([]);
    // Emails can't wait for a translation the way the app can: keep these complete.
    expect(missingMessages(en, cat)).toEqual([]);
  });

  it('formats plurals and numbers per language', () => {
    expect(serverT('en')('email.digest.updates', { count: 1200, workspace: 'Acme' })).toBe(
      '1,200 updates in Acme',
    );
    expect(serverT('sv')('email.digest.updates', { count: 1, workspace: 'Acme' })).toBe(
      '1 uppdatering i Acme',
    );
  });
});
