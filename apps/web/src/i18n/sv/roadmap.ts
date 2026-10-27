import type { Catalog, Translation } from '../index.ts';

export default {
  title: 'Färdplan',
  showClosed: 'avslutade',
  zoom: { weeks: 'veckor', months: 'månader', quarters: 'kvartal' },
  emptyTitle: 'inget på färdplanen',
  emptyBody: 'Projekt med start- eller måldatum visas här, grupperade efter initiativ.',
  noInitiative: 'Inget initiativ',
  noDates: 'Inga datum',
  barTitle: '{name}: {start} → {end} · {percent} % klart',
  initiativeTarget: 'Måldatum för {name} · {date}',
} satisfies Translation<Catalog['roadmap']>;
