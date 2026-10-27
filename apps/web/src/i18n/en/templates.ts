/** Settings → Templates: issue templates and the schedules that repeat them. */
export default {
  title: 'Issue templates',
  description:
    'Starting points for new issues: a title, a description and default properties. Pick one under Template when creating an issue. Templates for all teams appear everywhere; team templates only in their team.',
  newTemplate: 'New template',
  empty: '// no templates yet',
  /** tag on a template that isn't tied to one team */
  allTeamsTag: 'all teams',
  repeatLabel: 'Repeat {name}',
  repeatTitle: 'Create an issue from this template on a schedule',
  editLabel: 'Edit {name}',
  deleteLabel: 'Delete {name}',
  confirmDelete: 'Delete template “{name}”?',
  editor: {
    edit: 'Edit template',
    new: 'New template',
    namePlaceholder: 'Template name, e.g. Bug report',
    teamLocked: "A template's team can't change",
    allTeams: 'All teams',
    titlePlaceholder: 'Issue title (optional)',
    descriptionPlaceholder: 'Description the issue starts with…',
    statusPlaceholder: 'Status…',
    priorityPlaceholder: 'Priority…',
    assigneePlaceholder: 'Assign to…',
    labelsPlaceholder: 'Labels…',
    projectPlaceholder: 'Project…',
    estimatePlaceholder: 'Estimate…',
    /** the "leave it as it is" option for status */
    teamDefault: 'Team default',
    /** the "leave it as it is" option for priority */
    notSet: 'Not set',
    hint: "// properties left unset keep the new issue's own",
    create: 'Create template',
  },
  repeat: {
    label: 'Repeat template',
    title: 'Repeat “{name}”',
    body: 'A new issue from this template is created on the first date, then on every repeat — by the Ordo bot, notifying its assignee as usual.',
    team: 'Team',
    every: 'Every',
    firstOn: 'First on',
    /** submit button */
    submit: 'Repeat',
  },
  /** unit names in the "Every [n] [unit]" picker, picked by n */
  unit: {
    day: { one: 'day', other: 'days' },
    week: { one: 'week', other: 'weeks' },
    month: { one: 'month', other: 'months' },
  },
  cadence: {
    day: { one: 'every day', other: 'every {count} days' },
    week: { one: 'every week', other: 'every {count} weeks' },
    month: { one: 'every month', other: 'every {count} months' },
  },
  schedule: {
    /** "every week in ENG · next 2026-05-04" */
    next: '{cadence} in {team} · next {date}',
    paused: '{cadence} in {team} · paused',
    resume: 'Resume',
    pause: 'Pause',
    stop: 'Stop repeating',
  },
};
