/** Labels for the fixed values in @ordo/shared (priorities, state types, roles…), keyed by value. */
export default {
  priority: {
    '0': 'No priority',
    '1': 'Urgent',
    '2': 'High',
    '3': 'Medium',
    '4': 'Low',
  },
  stateType: {
    triage: 'Triage',
    backlog: 'Backlog',
    unstarted: 'Unstarted',
    started: 'Started',
    completed: 'Completed',
    canceled: 'Canceled',
  },
  projectStatus: {
    backlog: 'Backlog',
    planned: 'Planned',
    started: 'In Progress',
    paused: 'Paused',
    completed: 'Completed',
    canceled: 'Canceled',
  },
  initiativeStatus: {
    planned: 'Planned',
    active: 'Active',
    completed: 'Completed',
  },
  health: {
    on_track: 'On track',
    at_risk: 'At risk',
    off_track: 'Off track',
  },
  role: {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
    guest: 'Guest',
  },
  noEstimate: 'No estimate',
  points: { one: '{count} point', other: '{count} points' },
};
