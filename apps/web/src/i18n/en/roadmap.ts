/** The roadmap timeline: projects as bars, grouped by initiative. */
export default {
  title: 'Roadmap',
  /** Checkbox: also show completed and canceled projects. */
  showClosed: 'closed',
  zoom: { weeks: 'weeks', months: 'months', quarters: 'quarters' },
  emptyTitle: 'nothing on the roadmap',
  emptyBody: 'Projects with a start or target date show up here, grouped by initiative.',
  noInitiative: 'No initiative',
  noDates: 'No dates',
  /** Tooltip on a project's bar. */
  barTitle: '{name}: {start} → {end} · {percent}% done',
  initiativeTarget: '{name} target · {date}',
};
