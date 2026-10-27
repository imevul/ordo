/** The insights panel beside issue views, its charts, and the breakdown labels. */
export default {
  title: 'Insights',
  close: 'Close insights',
  measure: 'Measure',
  issues: 'Issues',
  points: 'Points',
  burnUp: {
    title: 'Burn-up',
    /** Screen-reader name of the chart. */
    labelIssues: 'Burn-up: scope and completed issues per day',
    labelPoints: 'Burn-up: scope and completed points per day',
    scope: 'Scope',
    completed: 'Completed',
    /** Shown before a cycle has started; {date} is YYYY-MM-DD. */
    starts: '// starts {date}',
  },
  flow: {
    title: 'Created vs completed · 12 weeks',
    labelIssues: 'issues created and completed per week, last 12 weeks',
    labelPoints: 'points created and completed per week, last 12 weeks',
    created: 'Created',
    completed: 'Completed',
  },
  breakdown: {
    title: 'Breakdown',
    by: 'Break down by',
    /** Options of the "Break down by" menu. */
    slice: {
      state: 'by status',
      assignee: 'by assignee',
      priority: 'by priority',
      label: 'by label',
      project: 'by project',
      team: 'by team',
      cycle: 'by cycle',
    },
    empty: '// nothing to count',
    more: { one: '+ {count} more', other: '+ {count} more' },
    noAssignee: 'No assignee',
    noLabels: 'No labels',
    noProject: 'No project',
    noCycle: 'No cycle',
    someone: 'Someone',
  },
  durations: {
    title: 'Time to complete · 90 days',
    empty: '// nothing completed lately',
    cycleTime: 'cycle time',
    cycleTimeHint: 'From started to done',
    leadTime: 'lead time',
    leadTimeHint: 'From created to done',
    /** Under the median: the 75th percentile. */
    p75: 'median · p75 {value}',
    completed: { one: '{count} issue completed', other: '{count} issues completed' },
    /** Durations: "6 h", "3.5 d". */
    hours: '{count} h',
    days: '{count} d',
  },
  chart: {
    /** Column heading of the table that screen readers get for a chart. */
    date: 'Date',
    /** Tooltip of a bar: "Bug: 12 (40%)". */
    bar: '{label}: {value}',
    barShare: '{label}: {value} ({percent}%)',
  },
};
