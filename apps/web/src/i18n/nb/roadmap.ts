import type { Catalog, Translation } from '../index.ts';

export default {
  title: 'Veikart',
  showClosed: 'avsluttede',
  zoom: { weeks: 'uker', months: 'måneder', quarters: 'kvartaler' },
  emptyTitle: 'ingenting på veikartet',
  emptyBody: 'Prosjekter med start- eller måldato vises her, gruppert etter initiativ.',
  noInitiative: 'Uten initiativ',
  noDates: 'Uten datoer',
  barTitle: '{name}: {start} → {end} · {percent} % fullført',
  initiativeTarget: 'Måldato for {name} · {date}',
} satisfies Translation<Catalog['roadmap']>;
