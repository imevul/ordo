import type { Catalog, Translation } from '../index.ts';

export default {
  list: {
    kicker: 'kunder',
    title: 'Kunder',
    newCustomer: 'Ny kunde',
    emptyTitle: 'ingen kunder ennå',
    emptyBody:
      'Kunder samler forespørsler: hva de ba om, koblet til sakene som leverer det. E-postinntaket legger dem til av seg selv.',
    name: 'Navn',
    domains: 'Domener',
    owner: 'Eier',
    requests: 'Forespørsler',
    open: 'Åpne',
  },
  create: {
    title: 'Ny kunde',
    namePlaceholder: 'Firmanavn',
    domainsPlaceholder: 'E-postdomener, f.eks. {example}',
    domainsHint: 'E-post fra disse domenene arkiveres under denne kunden.',
    submit: 'Opprett kunde',
  },
  detail: {
    notFound: 'fant ikke kunden',
    kicker: 'kunder',
    customer: 'kunde',
    delete: 'Slett kunde',
    confirmDeleteTitle: 'Slette kunden «{name}»?',
    confirmDeleteBody: 'Forespørslene deres slettes også; sakene blir værende.',
    nameLabel: 'Kundens navn',
    requests: { one: 'Forespørsler · {count}', other: 'Forespørsler · {count}' },
    noRequests: '// ingen forespørsler ennå',
    noContact: 'ingen kontakt',
    source: {
      manual: 'manuell',
      email: 'e-post',
      api: 'api',
    },
    details: 'Detaljer',
    domains: 'Domener',
    owner: 'Eier',
    setOwner: 'Velg eier…',
    noOwner: 'Ingen eier',
    notes: 'Notater',
  },
} satisfies Translation<Catalog['customers']>;
