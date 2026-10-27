/** The team's cycle list, a cycle's page and the new/edit cycle dialog. */
export default {
  kicker: 'cycles',
  newCycle: 'New cycle',
  teamNotFound: 'team not found',
  cycleNotFound: 'cycle not found',
  empty: {
    title: 'no cycles yet',
    body: 'Cycles are time-boxed iterations, typically one or two weeks. Plan what the team will finish in each.',
    action: 'Create first cycle',
  },
  /** Section headings on the cycle list. */
  current: 'Current',
  upcoming: 'Upcoming',
  past: 'Past',
  /** Badge on the cycle that is running now. */
  active: 'active',
  /** Completed out of all issues in the cycle. */
  issueProgress: { one: '{completed}/{count} issue', other: '{completed}/{count} issues' },
  /** Completed out of all estimate points. */
  pointProgress: { one: '{completed}/{count} pts', other: '{completed}/{count} pts' },
  modal: {
    editTitle: 'Edit {name}',
    newTitle: 'New cycle',
    name: 'Name (optional)',
    starts: 'Starts',
    ends: 'Ends',
    create: 'Create cycle',
    created: 'Cycle created',
    updated: 'Cycle updated',
  },
};
