/** Settings → Integrations (forges, chat apps, email intake) and the Account cards for Git and chat. */
export default {
  list: {
    adminsOnly: 'Only admins can manage integrations.',
    connectedTitle: 'Connected',
    empty: '// nothing connected yet',
    /** After the integration's summary line, e.g. "acme/app · webhooks · last event 2 hours ago". */
    lastEvent: 'last event {time}',
    settingsFor: 'Settings for {name}',
    turnOn: 'Turn on',
    turnOff: 'Turn off',
    turnOnName: 'Turn on {name}',
    turnOffName: 'Turn off {name}',
    disconnect: 'Disconnect',
    disconnectName: 'Disconnect {name}',
    confirmDisconnectTitle: 'Disconnect {name}?',
    confirmDisconnectBody: 'Links already on issues stay.',
    addTitle: 'Add an integration',
    connect: 'Connect',
  },
  /** Status chip on a connected integration. */
  status: {
    active: 'active',
    error: 'error',
    off: 'off',
  },
  /** The summary line under a connected integration. */
  summary: {
    githubApp: 'GitHub App installation',
    email: 'email',
    webhook: 'webhook',
    webhooks: 'webhooks',
    polling: 'polling',
    sync: 'sync',
    channels: { one: '{count} channel', other: '{count} channels' },
    delivery: {
      events: 'Events API',
      socket: 'Socket Mode',
      interactions: 'interactions endpoint',
      gateway: 'gateway',
      webhook: 'webhook',
      longpoll: 'long polling',
    },
  },
  form: {
    connect: 'Connect',
    keepSecret: 'Leave empty to keep the current one.',
    savedButError: 'Saved, but: {error}',
    connected: '{provider} connected',
  },
  connect: {
    title: 'Connect {provider}',
    accessTokenTab: 'Access token',
    setUpElsewhere: 'This integration is set up elsewhere.',
  },
  edit: {
    label: '{name} settings',
    webhookUrl: 'Webhook URL',
    appRepos: "Choose repositories on GitHub, in the app's installation settings.",
  },
  /** Forges connected with a token: GitHub, GitLab, Forgejo. */
  forge: {
    deliveryHeading: 'How Ordo hears about changes',
    webhooks: 'Webhooks (instant)',
    webhooksHint: '{provider} must be able to reach {origin}.',
    polling: 'Polling (every two minutes)',
    pollingHint: "For instances {provider} can't reach.",
    /** When this instance runs on localhost or a local network name. */
    pollingHintLocal: "For instances {provider} can't reach — like this one looks to be.",
    commentOnPullRequests: 'Comment on pull requests with a link to the issue',
    repositories: 'Repositories',
    accessToken: 'Access token',
    ownerNamePerLine: 'One owner/name per line.',
    github: {
      docs: 'A fine-grained token with read access to pull requests and contents, plus webhooks (read & write) to let Ordo add them.',
      token: 'Personal access token',
      apiUrl: 'API URL',
      apiUrlHint: 'Change only for GitHub Enterprise Server (https://host/api/v3).',
      webUrl: 'Web URL',
    },
    gitlab: {
      docs: 'A personal, group or project access token with the "api" scope (Maintainer, to add webhooks).',
      baseUrl: 'GitLab URL',
      projects: 'Projects',
      projectsHint: 'One group/project path per line.',
    },
    forgejo: {
      docs: 'An access token with read access to repositories and write access to their webhooks (repository admin).',
      baseUrl: 'Server URL',
    },
  },
  githubApp: {
    intro:
      'The GitHub App is the smoothest way: install it on your account or organisation, pick the repositories, done. GitHub needs to reach {url}.',
    install: 'Install {app} on GitHub',
    org: 'GitHub organisation (optional)',
    orgHint:
      "Owns the app. Leave empty to create it under your personal account. The app is private: it can only be installed where it's owned.",
    create: 'Create the GitHub App',
    needsInstanceAdmin:
      'An instance admin has to create the GitHub App once. Until then, connect with a token.',
  },
  slackApp: {
    tab: 'Add to Slack',
    manualTab: 'Manual',
    intro: 'Connect a Slack workspace in one click with this instance’s Slack app.',
    add: 'Add to Slack',
    needsHttps:
      'Slack only sends people back to https addresses, and this instance is at {url}. Set ORDO_PUBLIC_URL to an https address, or connect manually.',
    needsInstanceAdmin:
      'An instance admin has to set up the Slack app once. Until then, connect manually with a token.',
    setupIntro:
      'Set up the Slack app once; then any workspace admin can add Ordo to Slack in one click.',
    step1: '1. How Slack reaches Ordo',
    step2: '2. Create the app',
    step2Body:
      'Slack opens with Ordo’s manifest filled in. Pick a workspace to own the app and create it.',
    createApp: 'Create the Slack app',
    step3: '3. Copy its credentials',
    step3Body: 'From Basic Information → App Credentials.',
    step3Socket:
      'From Basic Information → App Credentials, and an app-level token (App-Level Tokens → Generate, with connections:write).',
    clientId: 'Client ID',
    clientSecret: 'Client secret',
    save: 'Save the Slack app',
    saved: 'Slack app saved',
    change: 'Change the Slack app',
    changeHint: 'Blank secrets stay as they are. Connected workspaces switch to the new delivery.',
    connectedWith: 'Connected with Add to Slack to {team}. Tokens are managed by Slack.',
  },
  chat: {
    deliveryHeading: 'How Ordo hears from {provider}',
    channels: 'Channels',
    channelId: 'Channel id',
    channelNamePlaceholder: 'Name (optional)',
    channelName: 'Channel name',
    removeChannel: 'Remove channel',
    fromTeams: 'From these teams:',
    fromPublicTeams: 'From every public team:',
    /** Suffix on a private team's key, e.g. "ENG · private". */
    private: 'private',
    /** {select} is a team picker. */
    newIssuesGoTo: 'New issues from here go to {select}',
    defaultTeam: 'the workspace default team',
    addChannel: 'Add channel',
    events: {
      issueCreated: 'New issues',
      issueStatus: 'Status changes',
      issueCompleted: 'Completed issues',
      commentCreated: 'Comments',
      projectUpdateCreated: 'Project updates',
    },
    botToken: 'Bot token',
    accessToken: 'Access token',
    slack: {
      docs: 'Create a Slack app from the manifest in the Ordo docs, install it to your workspace, then paste its tokens.',
      channelHint:
        'Channel ids look like C0123ABCD (channel details → About). Invite the app to the channel.',
      events: 'Events API',
      eventsHint: 'Slack posts to Ordo; it must reach this server.',
      socket: 'Socket Mode',
      socketHint: 'Ordo keeps a connection open to Slack. Works behind NAT and firewalls.',
      signingSecret: 'Signing secret',
      appToken: 'App-level token',
      appTokenHint: 'With the connections:write scope.',
    },
    discord: {
      docs: 'Create an application in the Discord developer portal, add a bot with the Message Content intent, and invite it with the bot and applications.commands scopes.',
      channelHint:
        'Channel ids are numbers (enable developer mode, then right-click → Copy channel ID).',
      interactions: 'Interactions endpoint',
      interactionsHint: 'Discord posts slash commands to Ordo; it must reach this server.',
      gateway: 'Gateway',
      gatewayHint:
        'Ordo keeps a connection open to Discord. Works behind NAT; also answers !ordo messages and previews links.',
      applicationId: 'Application id',
      publicKey: 'Public key',
      publicKeyHint: 'From General information; it verifies requests from Discord.',
    },
    matrix: {
      docs: 'Register an account for the bot on your homeserver and paste its access token. Ordo syncs from your homeserver, so nothing has to reach Ordo. Encrypted rooms are not supported.',
      channelHint: 'Room ids look like !abc123:example.org (room settings → Advanced).',
      homeserverUrl: 'Homeserver URL',
    },
    telegram: {
      docs: 'Create a bot with @BotFather and paste its token. To see issue links in groups, turn the bot’s privacy mode off.',
      channelHint: 'Group ids are negative numbers, e.g. -1001234567890.',
      webhook: 'Webhook',
      webhookHint: 'Telegram posts to Ordo; it must reach this server over HTTPS.',
      longpoll: 'Long polling',
      longpollHint: 'Ordo asks Telegram for updates. Works behind NAT.',
    },
  },
  email: {
    connected: 'Email intake connected',
    intro:
      'Mail to this address becomes an issue in the team below — in triage, if the team has it — filed under the sender’s customer. Replies in the same thread become comments. Auto-replies and bounces are ignored.',
    /** Team option for a team without triage. */
    teamNoTriage: '{team} (no triage: new issues land in its default status)',
    address: 'Address',
    addressHint: 'The address people write to; shown in Ordo only.',
    imap: 'Check a mailbox (IMAP)',
    imapHint: 'Ordo reads new mail every minute and marks it read. Works behind NAT and firewalls.',
    webhook: 'Receive by webhook',
    webhookHint:
      'Something that gets your mail (an email worker, a mail server pipe) POSTs each raw message to Ordo.',
    imapServer: 'IMAP server',
    port: 'Port',
    tls: 'TLS (port 993); untick for STARTTLS on 143',
    username: 'User name',
    password: 'Password',
    passwordHint: 'An app password, where the provider has them.',
    folder: 'Folder',
    /** {type} is the MIME type message/rfc822. */
    postRaw: 'POST each message, raw ({type}), to the webhook URL above.',
    webhookAfterConnect: 'The webhook URL appears once connected.',
    issuesGoTo: 'Issues go to {team}.',
  },
  /** Account → Git usernames. */
  gitAccounts: {
    title: 'Git usernames',
    description:
      'Your usernames on the forges {workspace} is connected to, so your pull requests show as yours.',
    remove: 'Remove {username}',
    placeholder: 'username',
    usernameLabel: 'Your {service} username',
  },
  /** Account → Chat. */
  chatAccounts: {
    title: 'Chat',
    description:
      'Link your chat accounts to get notifications as direct messages and to create issues from chat as yourself.',
    linkAnother: 'Link another',
    linkAccount: 'Link account',
    /** {command} is what to send in the chat app, e.g. "/ordo link 4F7K2Q". */
    send: 'Send {command}',
    copyCode: 'Copy code',
    validity: 'valid for 15 minutes, once',
    linkedAccount: 'linked account',
    linkedAgo: 'linked {time}',
    notificationsOn: 'Notifications on',
    notificationsOff: 'Notifications off',
    turnNotificationsOn: 'Turn notifications on',
    turnNotificationsOff: 'Turn notifications off',
    unlink: 'Unlink',
    confirmUnlinkTitle: 'Unlink this {service} account?',
    confirmUnlinkBody: 'You will stop getting notifications there.',
  },
  /** Provider names and descriptions; the server's English is used for providers not listed. */
  providers: {
    github: 'Link pull requests, branches and commits to issues and move issues as PRs progress.',
    gitlab: 'Link merge requests, branches and commits from GitLab.com or your own GitLab.',
    forgejo: 'Link pull requests, branches and commits from Forgejo, Gitea or Codeberg.',
    slack:
      'Post issue activity to channels, DM people their notifications, create issues from messages and unfurl links.',
    discord:
      'Post issue activity to channels, DM people their notifications, create issues from messages and preview links.',
    matrix:
      'Post issue activity to rooms, message people their notifications and create issues from messages.',
    telegram:
      'Post issue activity to groups, message people their notifications and create issues from messages.',
    email: 'Turn email to an address into triage issues, filed under the sender’s customer.',
  },
  providerNames: {
    email: 'Email',
  },
};
