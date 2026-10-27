import type { Catalog, Translation } from '../index.ts';

export default {
  list: {
    kicker: 'visninger',
    title: 'Visninger',
    emptyTitle: 'ingen lagrede visninger',
    emptyBody:
      'Filtrer en hvilken som helst saksliste, og velg «Lagre visning» for å beholde den her for hele arbeidsområdet – eller bare for deg.',
    private: 'privat',
  },
  view: {
    notFound: 'fant ikke visningen',
    kicker: 'visninger',
    shared: 'delt',
    private: 'privat',
    favorite: 'Favoritt',
    delete: 'Slett visning',
    deleted: 'Visningen ble slettet',
    confirmDeleteTitle: 'Slette «{name}»?',
    confirmDeleteBody: 'Sakene påvirkes ikke.',
  },
} satisfies Translation<Catalog['views']>;
