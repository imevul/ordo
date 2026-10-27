/** Team settings: the team list, a team's general settings, workflow, members, SLAs and automations. */
export default {
  list: {
    title: 'Teams',
    description: 'Every team has its own workflow, issue identifiers, cycles and settings.',
    /** Tag on a private team. */
    private: 'private',
    memberCount: { one: '{count} member', other: '{count} members' },
  },
  create: {
    title: 'New team',
    namePlaceholder: 'Team name',
    keyPlaceholder: 'KEY',
    private: 'Private — only members and workspace admins can see it',
    created: 'Team created',
  },
  states: {
    color: 'Status color',
    name: 'Status name',
    /** Chip on the status new issues start in. */
    default: 'default',
    makeDefault: 'make default',
    deleteTitle: 'Delete status “{name}”?',
    deleteBody: 'Its issues move to another status of the same type.',
    deleteLabel: 'Delete {name}',
    /** Placeholder for adding a status of each type. */
    add: {
      triage: 'Add triage status…',
      backlog: 'Add backlog status…',
      unstarted: 'Add unstarted status…',
      started: 'Add started status…',
      completed: 'Add completed status…',
      canceled: 'Add canceled status…',
    },
  },
  settings: {
    adminsOnly: "Only team admins and workspace admins can change this team's settings.",
    saved: 'Team saved',
    deleted: 'Team deleted',
    general: 'General',
    name: 'Name',
    key: 'Key',
    keyHint: 'Renames every identifier.',
    teamColor: 'Team color {color}',
    features: 'Features',
    private: 'Private team',
    privateHint: 'Only members of this team and workspace admins can see it and its issues.',
    triage: 'Triage',
    triageHint: 'An inbox for incoming issues that need review before they enter the backlog.',
    cycles: 'Cycles',
    cyclesHint: 'Time-boxed iterations for planning work.',
    autoArchive: 'Auto-archive',
    autoArchiveHint:
      'Closed issues leave lists and boards this long after they close. They stay in search, by link and under Archived.',
    never: 'Never',
    afterMonths: { one: 'After {count} month', other: 'After {count} months' },
    estimates: 'Estimates',
    estimatesHint: 'Scale used for issue estimates.',
    scales: {
      none: 'None',
      linear: 'Linear',
      fibonacci: 'Fibonacci',
      exponential: 'Exponential',
      tshirt: 'T-shirt sizes',
    },
    workflow: 'Workflow',
    workflowDescription:
      'Statuses are grouped by type. Issues move through them from left to right on the board.',
    join: 'Join team',
    leave: 'Leave team',
    dangerZone: 'Danger zone',
    deleteTeam: 'Delete team',
    deleteTitle: 'Delete {name}?',
    deleteBody: 'This permanently deletes the team and all of its issues, cycles and statuses.',
    failed: 'Failed',
  },
  members: {
    title: { one: 'Members · {count}', other: 'Members · {count}' },
    privateDescription: 'This team is private: only its members and workspace admins can see it.',
    publicDescription:
      'Everyone except guests can see this team. Guests see it only once added here.',
    addSomeone: 'Add someone…',
    addMember: 'Add member',
    /** Tag next to a guest's name. */
    guest: 'guest',
    roleOf: 'Team role of {name}',
    member: 'Member',
    teamAdmin: 'Team admin',
    /** Lower-case role tags, shown to people who can't change roles. */
    memberTag: 'member',
    teamAdminTag: 'team admin',
    leave: 'Leave team',
    remove: 'Remove {name}',
    empty: '// nobody has joined yet',
    managedBy: {
      one: 'Members come from the directory group {groups}. Change them in your identity provider.',
      other:
        'Members come from the directory groups {groups}. Change them in your identity provider.',
    },
  },
  sla: {
    title: 'SLAs',
    description:
      'Hours an issue may stay open, counted from when it was created, by priority. Issues show the time left; assignees and subscribers hear when an SLA runs out. Applies to new issues and priority changes.',
    /** Placeholder of an empty hours field. */
    none: 'none',
    /** Unit after the hours field. */
    hours: 'hours',
  },
  cycleAutomation: {
    title: 'Cycle automation',
    description:
      'Ordo creates cycles ahead of time and, when one ends, moves its unfinished issues to the next. Changes are made by the “Ordo” bot, without notifications.',
    enabled: 'Automate cycles',
    length: 'Cycle length',
    weeks: { one: '{count} week', other: '{count} weeks' },
    cooldown: 'Cooldown between cycles',
    startDay: 'Cycles start on',
    weekdays: {
      sunday: 'Sunday',
      monday: 'Monday',
      tuesday: 'Tuesday',
      wednesday: 'Wednesday',
      thursday: 'Thursday',
      friday: 'Friday',
      saturday: 'Saturday',
    },
    planAhead: 'Plan ahead',
    cycleCount: { one: '{count} cycle', other: '{count} cycles' },
    rollOver: 'Roll over unfinished issues',
    rollOverHint: 'When a cycle ends, open issues move to the next cycle.',
    addStarted: 'Add started issues to the active cycle',
    addStartedHint:
      'Issues that move to a started status join the current cycle, if they have none.',
  },
  git: {
    title: 'Git automation',
    description:
      'Issues named in a branch, pull request title, or after “fixes” in a description or commit move through these statuses. They only ever move forward.',
    events: {
      branch: 'Branch pushed',
      draft: 'Draft PR opened',
      open: 'PR opened',
      review: 'Review requested',
      merged: 'PR merged',
    },
    /** Option that keeps the built-in behaviour; {status} is what it does. */
    default: 'Default ({status})',
    noChange: 'No change',
    /** Inside "Default (no change)". */
    noChangeLower: 'no change',
  },
};
