/** Agents (Settings → Agents, the issue's runs) and Settings → Repositories. */
export default {
  adminsOnly: 'Only admins can manage agents.',
  title: 'Agents',
  /** {command} is `ordo agent run` */
  description:
    "Agents are members that aren't people. Assign an issue to one and a runner picks it up: {command} on a laptop or server, or your own program. Ordo never runs anything itself; the runner decides what to launch.",
  empty: '// no agents yet',
  add: 'Add agent',
  disabled: 'disabled',
  agentTag: 'agent',
  agentHint: 'An agent: a runner works on what is assigned to it',
  teams: 'Teams',
  noTeams: 'no teams',
  keyCount: { one: '{count} key', other: '{count} keys' },
  /** What an agent's runs cost this month; {cost} and {budget} are like "$4.20". */
  spent: '{cost} this month',
  spentOfBudget: '{cost} of {budget} this month',
  /** Tag on an agent paused because it spent its monthly budget. */
  budgetPaused: 'budget reached',
  edit: 'Edit {name}',
  newKey: 'New key',
  disable: 'Disable',
  enable: 'Enable',
  confirmDisable:
    'Disable {name}? Its queued and running runs are cancelled and its keys stop working.',
  keys: {
    title: 'Keys',
    empty: 'No keys. A runner needs one.',
    /** {prefix} is the start of the key, {time} like "3 hours ago" */
    used: '{prefix}… · last used {time}',
    unused: '{prefix}… · never used',
    revoke: 'Revoke',
    confirmRevoke: 'Revoke the key "{name}"? Runners using it stop.',
    name: 'What is it for?',
    namePlaceholder: 'homelab runner',
    create: 'Create key',
  },
  form: {
    label: 'Agent',
    new: 'New agent',
    edit: 'Edit agent',
    name: 'Name',
    namePlaceholder: 'Claude',
    color: 'Colour',
    teams: 'Teams it works in',
    teamsHint: 'It sees and can be assigned issues of these teams only.',
    instructions: 'Instructions',
    instructionsHint:
      'Added to every run’s prompt: how your team works, what to check before a pull request.',
    instructionsPlaceholder: 'Run the tests before opening a pull request. Never push to main.',
    concurrency: 'Runs at once',
    concurrencyHint: 'Across all of its runners.',
    followPullRequests: 'Follow up on pull requests',
    followPullRequestsHint:
      'When checks fail or a reviewer requests changes on a pull request of an issue it has, it gets a run.',
    waitForBlockers: 'Wait for blocking issues',
    waitForBlockersHint:
      'A run on a blocked issue waits until the issues blocking it are done or cancelled. Turn off for agents that only triage.',
    pickTeam: 'Pick at least one team.',
    budget: 'Monthly budget (USD)',
    budgetHint:
      'When its runs have cost this much in a calendar month (UTC), it pauses until the next one. Leave empty for no budget.',
    /** {cost} is like "$4.20". */
    budgetSpent:
      'Its runs cost {cost} so far this month. Reaching the budget pauses it until next month; leave empty for no budget.',
    budgetNone: 'No budget',
    budgetInvalid: 'The budget has to be more than zero, or empty.',
  },
  /** What runs used, as their runners reported it. */
  usage: {
    /** {tokens} is a short number like "1.2M". */
    tokens: { one: '{tokens} token', other: '{tokens} tokens' },
    /** Tooltip; each value is a short number like "12K". */
    breakdown:
      'Input {input} · output {output} · cache read {cacheRead} · cache write {cacheWrite}',
    /** Before the per-agent totals; {month} is like "November". */
    thisMonth: 'Totals for {month}',
    /** {cost} and {budget} are like "$4.20". */
    ofBudget: '{cost} of {budget}',
    budget: 'Share of the monthly budget',
    runs: { one: '{count} run', other: '{count} runs' },
  },
  schedules: {
    /** Next to a recurring issue assigned to the agent; opens Settings → Templates. */
    manage: 'Manage',
  },
  token: {
    title: 'Agent key',
    body: "Copy it now: it isn't shown again. Start a runner with it:",
    fileHint: 'Or put it in a runner file (with the key in a .env file next to it):',
  },
  runs: {
    title: 'Agent runs',
    runAgain: 'Run again',
    /** On a run waiting for an answer: requeue it without one. */
    resume: 'Resume',
    /** Above the agent's question on a waiting run. Replying on the issue resumes it. */
    asked: 'Asked · reply on the issue to continue',
    cancel: 'Cancel',
    /** On a failed or cancelled run: the same agent, issue and reason, as a new run. */
    restart: 'Restart',
    /** On a failed run: set it aside without restarting it. */
    dismiss: 'Dismiss',
    /** Tag on a run that restarts a failed one. */
    restarted: 'restart',
    progress: 'Progress',
    /** On a queued run held back by its issue's blockers. */
    waitingOn: 'Waiting on {issues}',
    runAnyway: 'Run anyway',
    runAnywayHint: 'Start this run without waiting for the issues that block it.',
    /** Why a run failed, next to its status. */
    failure: {
      usage_limit: 'usage limit',
      timeout: 'timed out',
      runner_lost: 'runner stopped responding',
      checkout: 'checkout failed',
      error: 'error',
    },
    /** {time} is like "Oct 31 · 01:00". */
    restartsAt: 'Restarts by itself at {time}, when the limit resets.',
    noAutoRestart:
      'Failed on the usage limit several times in a row, so it won’t restart by itself. Restart it once the limit is raised.',
    session: 'Open session',
    /** {runner} is the runner's name, e.g. jonas-laptop/claude */
    on: 'on {runner}',
    attempt: 'attempt {count}',
    empty: 'Not picked up yet.',
    status: {
      queued: 'queued',
      claimed: 'claimed',
      running: 'running',
      waiting: 'waiting for an answer',
      succeeded: 'done',
      failed: 'failed',
      cancelled: 'cancelled',
    },
    queued: 'Queued for {name}',
    /** Why a run exists, when it isn't an assignment. */
    trigger: {
      assigned: 'assigned',
      mention: 'mentioned',
      rerun: 'run again',
      pull_request: 'pull request',
      scheduled: 'scheduled',
    },
    /** For pull request runs; {ref} is like "#42". */
    pullRequest: {
      ready_for_review: '{ref} ready for review',
      checks_failed: 'checks failed on {ref}',
      changes_requested: 'changes requested on {ref}',
    },
  },
  /** The workspace-wide list of runs (sidebar → Agent runs). */
  runsPage: {
    pause: 'Pause new runs',
    resume: 'Resume runs',
    pauseHint: 'Runners start nothing new while paused; runs already going finish.',
    pausedBanner:
      'New agent runs are paused. Queued runs wait until an admin resumes them; runs already going finish.',
    nav: 'Agent runs',
    kicker: 'agent runs',
    title: 'Agent runs',
    agent: 'Agent',
    allAgents: 'All agents',
    status: { open: 'Open', finished: 'Finished', all: 'All' },
    /** {name} is an agent; {time} is like "Oct 31 · 01:00". */
    pausedLimit:
      '{name} hit its usage limit and is paused until {time}. Runs that failed on the limit restart then.',
    paused: '{name} is paused until {time}.',
    pausedBudget:
      '{name} spent its monthly budget and is paused until {time}. Raise the budget, or resume it for the rest of the month.',
    raiseBudget: 'Raise budget',
    resumeNow: 'Resume now',
    resumeNowHint: 'Lift the pause and restart the runs that failed on the limit now',
    resumeBudgetHint: 'Let it work past its budget for the rest of the month',
    columns: {
      status: 'Status',
      issue: 'Issue',
      agent: 'Agent',
      runner: 'Runner',
      usage: 'Cost · tokens · time',
      updated: 'Updated',
    },
    more: 'more',
    less: 'less',
    waitingForSlot: 'waiting for a free slot',
    /** {repository} is a repository's name. */
    waitingForSlotHint: '{repository} already has as many runs as it allows.',
    emptyOpen: 'Nothing running, and no failed runs waiting for you',
    emptyTitle: 'No runs yet',
    emptyBody: 'Assign an issue to an agent and its run shows up here.',
    noAgents: 'Add an agent under Settings → Agents, then assign it an issue.',
    /** Tooltip on a run's status, which links to its page. */
    open: 'Open the run',
  },
  /** One run's page (Agent runs → a run). */
  runPage: {
    kicker: 'run',
    notFound: 'Run not found',
    /** Page title; {name} is the agent, {identifier} the issue, e.g. "Claude on ENG-42". */
    title: '{name} on {identifier}',
    details: 'Details',
    issue: 'Issue',
    agent: 'Agent',
    trigger: 'Why it ran',
    pullRequest: 'Pull request',
    requestedBy: 'Asked for by',
    nobody: 'nobody',
    runner: 'Runner',
    attempts: 'Attempts',
    session: 'Session',
    queuedAt: 'Queued',
    startedAt: 'Started',
    finishedAt: 'Finished',
    took: 'Took',
    /** {time} is like "Oct 31 · 14:51"; heartbeats move it on. */
    leaseUntil: 'Lease until {time}',
    /** {time} is like "2 minutes ago": the lease was last renewed then. */
    heartbeat: 'last heartbeat {time}',
    /** <a>…</a> links to the failed run this one restarts. */
    restarts: 'This run restarts <a>an earlier one</a> that failed or was cancelled.',
    restartedBy: 'Restarted as',
    mentionedIn: 'Mentioned in a comment',
    progress: 'Latest progress',
    result: 'Result',
    summary: 'Summary',
    error: 'Error',
    noResult: 'No summary or error yet.',
    timeline: 'Timeline',
    noTimeline: 'This run is from before Ordo kept timelines; only its times are known.',
    prompt: 'Prompt',
    promptHint:
      "What Ordo gave the agent on its latest pickup, without the instructions, parent or related issues: the agent's instructions are in its settings, the runner's aren't stored, and the issue page shows the parent and related issues you can see.",
    noPrompt: 'Not picked up yet.',
    showPrompt: 'Show prompt',
    hidePrompt: 'Hide prompt',
    /** Who did a timeline step when nobody did: Ordo itself. */
    system: 'Ordo',
    event: {
      queued: 'Queued',
      queuedRestart: 'Queued as a restart',
      ran_anyway: 'Told to run without waiting for blocking issues',
      /** {runner} like jonas-laptop/claude, {attempt} a number */
      claimed: 'Picked up by {runner} · attempt {attempt}',
      claimedNoRunner: 'Picked up · attempt {attempt}',
      started: 'Started',
      progress: 'Progress',
      asked: 'Asked a question',
      resumed: 'Resumed after a reply',
      resumedNoAnswer: 'Resumed without an answer',
      /** {runner} like jonas-laptop/claude */
      lapsed: '{runner} stopped responding; back in the queue',
      lapsedFailed: '{runner} stopped responding on the last attempt',
      lapsedNoRunner: 'The runner stopped responding; back in the queue',
      lapsedFailedNoRunner: 'The runner stopped responding on the last attempt',
      succeeded: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
      dismissed: 'Dismissed',
      finished: 'Finished',
    },
  },
  repositories: {
    adminsOnly: 'Only admins can manage repositories.',
    title: 'Repositories',
    description:
      'Where your code lives. Projects list their repositories and teams pick a default, so an agent’s runner knows what to check out. Ordo keeps only the address: runners bring their own git credentials.',
    empty: '// no repositories yet',
    add: 'Add repository',
    browse: 'Browse…',
    edit: 'Edit {name}',
    delete: 'Delete {name}',
    confirmDelete: 'Delete the repository {name}? Projects and teams using it lose it.',
    /** {branch} is the default branch, e.g. main */
    branch: 'default branch {branch}',
    maxRuns: { one: 'at most {count} run at a time', other: 'at most {count} runs at a time' },
    form: {
      label: 'Repository',
      new: 'New repository',
      edit: 'Edit repository',
      name: 'Name',
      url: 'Clone URL',
      urlHint: 'https://…, ssh://…, git@host:owner/repo.git, or a path on the runner.',
      defaultBranch: 'Default branch',
      maxRuns: 'At most N runs at a time',
      maxRunsHint:
        'So agents don’t work over each other’s files: runs of any agent past this number wait in the queue. Leave empty for no limit.',
      maxRunsPlaceholder: 'No limit',
      /** {repo} is owner/name, {integration} the connection's name, e.g. GitHub */
      linked: 'Linked to {repo} on {integration}.',
    },
    picker: {
      label: 'Browse repositories',
      integration: 'Connection',
      search: 'Search repositories…',
      cloneWith: 'Clone with',
      empty: '// no repositories found',
      private: 'private',
      added: 'added',
    },
    project: 'Repositories',
    projectHint: 'Where agents work on this project’s issues.',
    teamDefault: 'Default repository',
    teamDefaultHint: 'For agents working on issues that aren’t in a project with repositories.',
    none: 'None',
    manage: 'Manage repositories',
  },
};
