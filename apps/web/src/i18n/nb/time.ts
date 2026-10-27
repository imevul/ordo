import type { Catalog, Translation } from '../index.ts';

export default {
  justNow: 'akkurat nå',
  minutesShort: '{count} min',
  hoursShort: '{count} t',
  daysShort: '{count} d',
  slaLeft: 'SLA {span}',
  slaBreached: 'SLA −{span}',
} satisfies Translation<Catalog['time']>;
