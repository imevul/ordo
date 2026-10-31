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
  /** Under a cycle burn-up while the view is filtered: history only covers the whole cycle. */
  burnUpFiltered: '// as the filtered issues are now',
  burndown: {
    title: 'Burndown',
    labelIssues: 'Burndown: issues left per day, ideal line and forecast',
    labelPoints: 'Burndown: points left per day, ideal line and forecast',
    remaining: 'Left',
    ideal: 'Ideal',
    forecast: 'Forecast',
    /** The label on the target date line. */
    target: 'target',
    /** {date} is a short date like "Nov 20". */
    forecastOn: 'Forecast: done {date}',
    late: { one: '{count} day after the target', other: '{count} days after the target' },
    early: {
      one: 'on track, {count} day before the target',
      other: 'on track, {count} days before the target',
    },
    onTarget: 'on track, on the target date',
    noForecast: '// not enough recent progress to forecast',
    done: '// all done',
    /** The recent pace behind the forecast. */
    rateIssues: '{rate} issues a week lately',
    ratePoints: '{rate} points a week lately',
  },
  cumulativeFlow: {
    title: 'Cumulative flow',
    labelIssues: 'Cumulative flow: issues per status type per day',
    labelPoints: 'Cumulative flow: points per status type per day',
  },
  velocity: {
    title: 'Velocity',
    labelIssues: 'Velocity: issues committed and completed per cycle',
    labelPoints: 'Velocity: points committed and completed per cycle',
    committed: 'Committed',
    completed: 'Completed',
    /** The average line: "avg 12.5". */
    average: 'avg {value}',
    /** Under the chart: "Average of the last 5 finished cycles: 12.5 points". */
    summaryIssues: {
      one: 'Average of the last finished cycle: {value} issues',
      other: 'Average of the last {count} finished cycles: {value} issues',
    },
    summaryPoints: {
      one: 'Average of the last finished cycle: {value} points',
      other: 'Average of the last {count} finished cycles: {value} points',
    },
    empty: '// no cycles have started yet',
    /** A cycle's column label when it has no name: "C4". */
    short: 'C{number}',
  },
  page: {
    title: 'Insights',
    kicker: 'Charts',
    scope: 'Scope',
    workspace: 'All teams',
    teams: 'Teams',
    projects: 'Projects',
    range: 'Range',
    /** Range options. */
    weeks: { one: 'Last week', other: 'Last {count} weeks' },
    sinceStart: 'Since the start',
    loading: '// loading…',
    velocityHint: 'Pick a team to see its velocity across cycles.',
    burndownHint: 'Pick a project to see its burndown and forecast.',
  },
  chart: {
    /** Column heading of the table that screen readers get for a chart. */
    date: 'Date',
    /** Column heading of the table for a chart over cycles. */
    cycle: 'Cycle',
    /** Tooltip of a bar: "Bug: 12 (40%)". */
    bar: '{label}: {value}',
    barShare: '{label}: {value} ({percent}%)',
  },
};
