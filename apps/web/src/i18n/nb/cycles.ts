import type { Catalog, Translation } from '../index.ts';

export default {
  kicker: 'sykluser',
  newCycle: 'Ny syklus',
  teamNotFound: 'fant ikke teamet',
  cycleNotFound: 'fant ikke syklusen',
  empty: {
    title: 'ingen sykluser ennå',
    body: 'Sykluser er tidsavgrensede iterasjoner, vanligvis én eller to uker. Planlegg hva teamet skal få ferdig i hver av dem.',
    action: 'Opprett første syklus',
  },
  current: 'Pågående',
  upcoming: 'Kommende',
  past: 'Tidligere',
  active: 'aktiv',
  issueProgress: { one: '{completed}/{count} sak', other: '{completed}/{count} saker' },
  pointProgress: { one: '{completed}/{count} p', other: '{completed}/{count} p' },
  modal: {
    editTitle: 'Rediger {name}',
    newTitle: 'Ny syklus',
    name: 'Navn (valgfritt)',
    starts: 'Starter',
    ends: 'Slutter',
    create: 'Opprett syklus',
    created: 'Syklusen er opprettet',
    updated: 'Syklusen er oppdatert',
  },
} satisfies Translation<Catalog['cycles']>;
