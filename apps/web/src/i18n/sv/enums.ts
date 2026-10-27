import type { Catalog, Translation } from '../index.ts';

export default {
  priority: { '0': 'Ingen prioritet', '1': 'Brådskande', '2': 'Hög', '3': 'Medel', '4': 'Låg' },
  stateType: {
    triage: 'Triage',
    backlog: 'Backlogg',
    unstarted: 'Ej påbörjad',
    started: 'Påbörjad',
    completed: 'Klar',
    canceled: 'Avbruten',
  },
  projectStatus: {
    backlog: 'Backlogg',
    planned: 'Planerat',
    started: 'Pågår',
    paused: 'Pausat',
    completed: 'Slutfört',
    canceled: 'Avbrutet',
  },
  initiativeStatus: { planned: 'Planerat', active: 'Aktivt', completed: 'Slutfört' },
  health: { on_track: 'Enligt plan', at_risk: 'I riskzonen', off_track: 'Avviker' },
  role: { owner: 'Ägare', admin: 'Admin', member: 'Medlem', guest: 'Gäst' },
  noEstimate: 'Ingen uppskattning',
  points: { one: '{count} poäng', other: '{count} poäng' },
} satisfies Translation<Catalog['enums']>;
