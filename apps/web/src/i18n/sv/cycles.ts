import type { Catalog, Translation } from '../index.ts';

export default {
  kicker: 'cykler',
  newCycle: 'Ny cykel',
  teamNotFound: 'teamet hittades inte',
  cycleNotFound: 'cykeln hittades inte',
  empty: {
    title: 'inga cykler än',
    body: 'Cykler är tidsbegränsade iterationer, oftast en eller två veckor. Planera vad teamet ska bli klart med i varje.',
    action: 'Skapa första cykeln',
  },
  current: 'Pågående',
  upcoming: 'Kommande',
  past: 'Tidigare',
  active: 'aktiv',
  issueProgress: { one: '{completed}/{count} ärende', other: '{completed}/{count} ärenden' },
  pointProgress: { one: '{completed}/{count} p', other: '{completed}/{count} p' },
  modal: {
    editTitle: 'Redigera {name}',
    newTitle: 'Ny cykel',
    name: 'Namn (valfritt)',
    starts: 'Startar',
    ends: 'Slutar',
    create: 'Skapa cykel',
    created: 'Cykeln har skapats',
    updated: 'Cykeln har uppdaterats',
  },
} satisfies Translation<Catalog['cycles']>;
