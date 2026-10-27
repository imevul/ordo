import type { Catalog, Translation } from '../index.ts';

export default {
  justNow: 'just nu',
  minutesShort: '{count} min',
  hoursShort: '{count} tim',
  daysShort: '{count} d',
  slaLeft: 'SLA {span}',
  slaBreached: 'SLA −{span}',
} satisfies Translation<Catalog['time']>;
