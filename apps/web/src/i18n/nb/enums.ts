import type { Catalog, Translation } from '../index.ts';

export default {
  priority: { '0': 'Ingen prioritet', '1': 'Haster', '2': 'Høy', '3': 'Middels', '4': 'Lav' },
  stateType: {
    triage: 'Triage',
    backlog: 'Backlog',
    unstarted: 'Ikke startet',
    started: 'Startet',
    completed: 'Fullført',
    canceled: 'Avbrutt',
  },
  projectStatus: {
    backlog: 'Backlog',
    planned: 'Planlagt',
    started: 'Pågår',
    paused: 'Satt på pause',
    completed: 'Fullført',
    canceled: 'Avbrutt',
  },
  initiativeStatus: { planned: 'Planlagt', active: 'Aktivt', completed: 'Fullført' },
  health: { on_track: 'I rute', at_risk: 'I faresonen', off_track: 'Ute av rute' },
  role: { owner: 'Eier', admin: 'Admin', member: 'Medlem', guest: 'Gjest' },
  noEstimate: 'Uten estimat',
  points: { one: '{count} poeng', other: '{count} poeng' },
} satisfies Translation<Catalog['enums']>;
