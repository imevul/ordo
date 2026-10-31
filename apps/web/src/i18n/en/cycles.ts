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
  /** The Workload panel on a cycle's page: each person's load against their capacity. */
  workload: {
    title: 'Workload',
    open: 'Workload',
    close: 'Close workload',
    loading: 'Loading workload…',
    /** Says what load and capacity are measured in. */
    unitPoints: 'In points',
    unitIssues: 'In issues (nothing is estimated)',
    unassigned: 'Unassigned',
    outsideTeam: 'not on the team',
    /** Load against capacity, e.g. "5 / 8". */
    loadOfCapacity: '{load} / {capacity}',
    /** Load with no capacity set. */
    loadOnly: '{load}',
    over: { one: '{count} over', other: '{count} over' },
    unestimated: { one: '{count} unestimated', other: '{count} unestimated' },
    noCapacity: 'No capacity set',
    /** Where the capacity comes from, shown on hover. */
    source: {
      cycle: 'Set for this cycle',
      member: "This person's default",
      team: "The team's default",
    },
    editCapacity: 'Capacity of {name} in this cycle',
    /** Hint under the capacity input. */
    capacityHint: 'Empty uses their default.',
    capacitySaved: 'Capacity updated',
    noIssues: 'Nothing assigned',
    showIssues: 'Show issues of {name}',
    hint: 'Drag an issue onto someone to assign it to them.',
    moved: '{identifier} assigned to {name}',
    unassignedToast: '{identifier} unassigned',
  },
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
