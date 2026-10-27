import type { Catalog, Translation } from '../index.ts';

export default {
  list: {
    adminsOnly: 'Bare administratorer kan administrere integrasjoner.',
    connectedTitle: 'Tilkoblet',
    empty: '// ingenting tilkoblet ennå',
    lastEvent: 'siste hendelse {time}',
    settingsFor: 'Innstillinger for {name}',
    turnOn: 'Slå på',
    turnOff: 'Slå av',
    turnOnName: 'Slå på {name}',
    turnOffName: 'Slå av {name}',
    disconnect: 'Koble fra',
    disconnectName: 'Koble fra {name}',
    confirmDisconnectTitle: 'Koble fra {name}?',
    confirmDisconnectBody: 'Lenker som allerede ligger på saker, blir værende.',
    addTitle: 'Legg til en integrasjon',
    connect: 'Koble til',
  },
  status: {
    active: 'aktiv',
    error: 'feil',
    off: 'av',
  },
  summary: {
    githubApp: 'GitHub App-installasjon',
    email: 'e-post',
    webhook: 'webhook',
    webhooks: 'webhooks',
    polling: 'polling',
    sync: 'synk',
    channels: { one: '{count} kanal', other: '{count} kanaler' },
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
    connect: 'Koble til',
    keepSecret: 'La stå tomt for å beholde den nåværende.',
    savedButError: 'Lagret, men: {error}',
    connected: '{provider} er koblet til',
  },
  connect: {
    title: 'Koble til {provider}',
    accessTokenTab: 'Tilgangstoken',
    setUpElsewhere: 'Denne integrasjonen settes opp et annet sted.',
  },
  edit: {
    label: 'Innstillinger for {name}',
    webhookUrl: 'Webhook-URL',
    appRepos: 'Velg repoer på GitHub, i appens installasjonsinnstillinger.',
  },
  forge: {
    deliveryHeading: 'Slik får Ordo vite om endringer',
    webhooks: 'Webhooks (umiddelbart)',
    webhooksHint: '{provider} må kunne nå {origin}.',
    polling: 'Polling (annethvert minutt)',
    pollingHint: 'For instanser som {provider} ikke kan nå.',
    pollingHintLocal: 'For instanser som {provider} ikke kan nå – slik denne ser ut til å være.',
    commentOnPullRequests: 'Kommenter pull requests med en lenke til saken',
    repositories: 'Repoer',
    accessToken: 'Tilgangstoken',
    ownerNamePerLine: 'Én eier/navn per linje.',
    github: {
      docs: 'Et finmasket token (fine-grained) med lesetilgang til pull requests og innhold, pluss webhooks (lese og skrive) så Ordo kan legge dem til.',
      token: 'Personlig tilgangstoken',
      apiUrl: 'API-URL',
      apiUrlHint: 'Endre bare for GitHub Enterprise Server (https://host/api/v3).',
      webUrl: 'Nettadresse',
    },
    gitlab: {
      docs: 'Et personlig token, gruppe- eller prosjekttoken med scopet «api» (Maintainer, for å kunne legge til webhooks).',
      baseUrl: 'GitLab-URL',
      projects: 'Prosjekter',
      projectsHint: 'Én gruppe/prosjektsti per linje.',
    },
    forgejo: {
      docs: 'Et tilgangstoken med lesetilgang til repoer og skrivetilgang til webhookene deres (repo-admin).',
      baseUrl: 'Serverens URL',
    },
  },
  githubApp: {
    intro:
      'GitHub-appen er den enkleste veien: installer den på kontoen eller organisasjonen din, velg repoer, ferdig. GitHub må kunne nå {url}.',
    install: 'Installer {app} på GitHub',
    org: 'GitHub-organisasjon (valgfritt)',
    orgHint:
      'Eier appen. La stå tomt for å opprette den under din personlige konto. Appen er privat: den kan bare installeres der den eies.',
    create: 'Opprett GitHub-appen',
    needsInstanceAdmin:
      'En instansadmin må opprette GitHub-appen én gang. Inntil da kan du koble til med et token.',
  },
  slackApp: {
    tab: 'Legg til i Slack',
    manualTab: 'Manuelt',
    intro: 'Koble til et Slack-arbeidsområde med ett klikk via denne instansens Slack-app.',
    add: 'Legg til i Slack',
    needsHttps:
      'Slack sender bare folk tilbake til https-adresser, og denne instansen er på {url}. Sett ORDO_PUBLIC_URL til en https-adresse, eller koble til manuelt.',
    needsInstanceAdmin:
      'En instansadmin må sette opp Slack-appen én gang. Inntil da kan du koble til manuelt med et token.',
    setupIntro:
      'Sett opp Slack-appen én gang; deretter kan alle admins i arbeidsområdene legge til Ordo i Slack med ett klikk.',
    step1: '1. Hvordan Slack når Ordo',
    step2: '2. Opprett appen',
    step2Body:
      'Slack åpnes med Ordos manifest fylt ut. Velg hvilket arbeidsområde som skal eie appen, og opprett den.',
    createApp: 'Opprett Slack-appen',
    step3: '3. Kopier legitimasjonen',
    step3Body: 'Fra Basic Information → App Credentials.',
    step3Socket:
      'Fra Basic Information → App Credentials, og et token på appnivå (App-Level Tokens → Generate, med connections:write).',
    clientId: 'Klient-ID',
    clientSecret: 'Klienthemmelighet',
    save: 'Lagre Slack-appen',
    saved: 'Slack-appen er lagret',
    change: 'Endre Slack-appen',
    changeHint:
      'Tomme hemmeligheter beholdes. Tilkoblede arbeidsområder bytter til den nye leveringsmåten.',
    connectedWith: 'Koblet til med Legg til i Slack til {team}. Tokenet håndteres av Slack.',
  },
  chat: {
    deliveryHeading: 'Slik får Ordo meldinger fra {provider}',
    channels: 'Kanaler',
    channelId: 'Kanal-ID',
    channelNamePlaceholder: 'Navn (valgfritt)',
    channelName: 'Kanalnavn',
    removeChannel: 'Fjern kanal',
    fromTeams: 'Fra disse teamene:',
    fromPublicTeams: 'Fra alle offentlige team:',
    private: 'privat',
    newIssuesGoTo: 'Nye saker herfra havner i {select}',
    defaultTeam: 'standardteamet i arbeidsområdet',
    addChannel: 'Legg til kanal',
    events: {
      issueCreated: 'Nye saker',
      issueStatus: 'Statusendringer',
      issueCompleted: 'Fullførte saker',
      commentCreated: 'Kommentarer',
      projectUpdateCreated: 'Prosjektoppdateringer',
    },
    botToken: 'Bot-token',
    accessToken: 'Tilgangstoken',
    slack: {
      docs: 'Opprett en Slack-app fra manifestet i Ordo-dokumentasjonen, installer den i arbeidsområdet ditt, og lim inn tokenene.',
      channelHint:
        'Kanal-ID-er ser ut som C0123ABCD (channel details → About). Inviter appen til kanalen.',
      events: 'Events API',
      eventsHint: 'Slack sender til Ordo; Slack må kunne nå denne serveren.',
      socket: 'Socket Mode',
      socketHint: 'Ordo holder en tilkobling åpen mot Slack. Fungerer bak NAT og brannmurer.',
      signingSecret: 'Signing secret',
      appToken: 'App-level token',
      appTokenHint: 'Med scopet connections:write.',
    },
    discord: {
      docs: 'Opprett en applikasjon i Discord Developer Portal, legg til en bot med Message Content intent, og inviter den med scopene bot og applications.commands.',
      channelHint:
        'Kanal-ID-er er tall (slå på Developer Mode, og høyreklikk deretter → Copy Channel ID).',
      interactions: 'Interactions endpoint',
      interactionsHint:
        'Discord sender skråstrekkommandoer til Ordo; Discord må kunne nå denne serveren.',
      gateway: 'Gateway',
      gatewayHint:
        'Ordo holder en tilkobling åpen mot Discord. Fungerer bak NAT; svarer også på !ordo-meldinger og forhåndsviser lenker.',
      applicationId: 'Application id',
      publicKey: 'Public key',
      publicKeyHint: 'Ligger under General Information; den bekrefter forespørsler fra Discord.',
    },
    matrix: {
      docs: 'Registrer en konto for boten på hjemmeserveren din, og lim inn tilgangstokenet. Ordo synkroniserer fra hjemmeserveren, så ingenting trenger å nå Ordo. Krypterte rom støttes ikke.',
      channelHint: 'Rom-ID-er ser ut som !abc123:example.org (Room settings → Advanced).',
      homeserverUrl: 'Hjemmeserverens URL',
    },
    telegram: {
      docs: 'Opprett en bot med @BotFather, og lim inn tokenet. For å se sakslenker i grupper må du slå av personvernmodusen til boten (Group Privacy).',
      channelHint: 'Gruppe-ID-er er negative tall, f.eks. -1001234567890.',
      webhook: 'Webhook',
      webhookHint: 'Telegram sender til Ordo; Telegram må kunne nå denne serveren over HTTPS.',
      longpoll: 'Long polling',
      longpollHint: 'Ordo spør Telegram etter oppdateringer. Fungerer bak NAT.',
    },
  },
  email: {
    connected: 'E-postinntak er koblet til',
    intro:
      'E-post til denne adressen blir en sak i teamet nedenfor – i triage, hvis teamet har det – knyttet til avsenderens kunde. Svar i samme tråd blir kommentarer. Autosvar og returmeldinger ignoreres.',
    teamNoTriage: '{team} (ingen triage: nye saker havner i teamets standardstatus)',
    address: 'Adresse',
    addressHint: 'Adressen folk skriver til; vises bare i Ordo.',
    imap: 'Les en postkasse (IMAP)',
    imapHint:
      'Ordo leser ny e-post hvert minutt og merker den som lest. Fungerer bak NAT og brannmurer.',
    webhook: 'Motta via webhook',
    webhookHint:
      'Noe som mottar e-posten din (en e-post-worker, en pipe i e-postserveren) sender hver rå melding til Ordo med POST.',
    imapServer: 'IMAP-server',
    port: 'Port',
    tls: 'TLS (port 993); fjern avhukingen for STARTTLS på 143',
    username: 'Brukernavn',
    password: 'Passord',
    passwordHint: 'Et app-passord, der leverandøren har det.',
    folder: 'Mappe',
    postRaw: 'Send hver melding rå ({type}) med POST til webhook-URL-en ovenfor.',
    webhookAfterConnect: 'Webhook-URL-en vises når integrasjonen er koblet til.',
    issuesGoTo: 'Saker havner i {team}.',
  },
  gitAccounts: {
    title: 'Git-brukernavn',
    description:
      'Brukernavnene dine på kodeplattformene {workspace} er koblet til, slik at pull requestene dine vises som dine.',
    remove: 'Fjern {username}',
    placeholder: 'brukernavn',
    usernameLabel: 'Brukernavnet ditt på {service}',
  },
  chatAccounts: {
    title: 'Chat',
    description:
      'Koble til chattekontoene dine for å få varsler som direktemeldinger og opprette saker fra chatten som deg selv.',
    linkAnother: 'Koble til en til',
    linkAccount: 'Koble til konto',
    send: 'Send {command}',
    copyCode: 'Kopier kode',
    validity: 'gyldig i 15 minutter, én gang',
    linkedAccount: 'tilkoblet konto',
    linkedAgo: 'koblet til {time}',
    notificationsOn: 'Varsler på',
    notificationsOff: 'Varsler av',
    turnNotificationsOn: 'Slå på varsler',
    turnNotificationsOff: 'Slå av varsler',
    unlink: 'Koble fra',
    confirmUnlinkTitle: 'Koble fra denne {service}-kontoen?',
    confirmUnlinkBody: 'Du slutter å få varsler der.',
  },
  providers: {
    github:
      'Koble pull requests, grener og commits til saker, og flytt saker etter hvert som PR-ene kommer videre.',
    gitlab: 'Koble merge requests, grener og commits fra GitLab.com eller deres eget GitLab.',
    forgejo: 'Koble pull requests, grener og commits fra Forgejo, Gitea eller Codeberg.',
    slack:
      'Legg ut saksaktivitet i kanaler, send varsler som DM, opprett saker fra meldinger og vis forhåndsvisning av lenker.',
    discord:
      'Legg ut saksaktivitet i kanaler, send varsler som DM, opprett saker fra meldinger og forhåndsvis lenker.',
    matrix:
      'Legg ut saksaktivitet i rom, send varsler som meldinger og opprett saker fra meldinger.',
    telegram:
      'Legg ut saksaktivitet i grupper, send varsler som meldinger og opprett saker fra meldinger.',
    email: 'Gjør e-post til en adresse om til saker i triage, knyttet til avsenderens kunde.',
  },
  providerNames: {
    email: 'E-post',
  },
} satisfies Translation<Catalog['integrations']>;
