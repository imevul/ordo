import type { Catalog, Translation } from '../index.ts';

export default {
  list: {
    kicker: 'kunder',
    title: 'Kunder',
    newCustomer: 'Ny kund',
    emptyTitle: 'inga kunder än',
    emptyBody:
      'Kunder samlar önskemål: vad de bad om, kopplat till ärendena som levererar det. E-postintaget lägger till dem av sig självt.',
    name: 'Namn',
    domains: 'Domäner',
    owner: 'Ägare',
    requests: 'Önskemål',
    open: 'Öppna',
  },
  create: {
    title: 'Ny kund',
    namePlaceholder: 'Företagsnamn',
    domainsPlaceholder: 'E-postdomäner, t.ex. {example}',
    domainsHint: 'E-post från de här domänerna sorteras under den här kunden.',
    submit: 'Skapa kund',
  },
  detail: {
    notFound: 'kunden hittades inte',
    kicker: 'kunder',
    customer: 'kund',
    delete: 'Radera kund',
    confirmDeleteTitle: 'Radera kunden ”{name}”?',
    confirmDeleteBody: 'Kundens önskemål raderas också; ärendena finns kvar.',
    nameLabel: 'Kundens namn',
    requests: { one: 'Önskemål · {count}', other: 'Önskemål · {count}' },
    noRequests: '// inga önskemål än',
    noContact: 'ingen kontakt',
    source: {
      manual: 'manuell',
      email: 'e-post',
      api: 'api',
    },
    details: 'Detaljer',
    domains: 'Domäner',
    owner: 'Ägare',
    setOwner: 'Välj ägare…',
    noOwner: 'Ingen ägare',
    notes: 'Anteckningar',
  },
} satisfies Translation<Catalog['customers']>;
