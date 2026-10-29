import type { Catalog, Translation } from '../index.ts';

export default {
  list: {
    adminsOnly: 'Bara administratörer kan hantera integrationer.',
    connectedTitle: 'Anslutna',
    empty: '// inget anslutet än',
    lastEvent: 'senaste händelse {time}',
    settingsFor: 'Inställningar för {name}',
    turnOn: 'Slå på',
    turnOff: 'Stäng av',
    turnOnName: 'Slå på {name}',
    turnOffName: 'Stäng av {name}',
    disconnect: 'Koppla från',
    disconnectName: 'Koppla från {name}',
    confirmDisconnectTitle: 'Koppla från {name}?',
    confirmDisconnectBody: 'Länkar som redan finns på ärenden blir kvar.',
    addTitle: 'Lägg till en integration',
    connect: 'Anslut',
  },
  status: {
    active: 'aktiv',
    error: 'fel',
    off: 'av',
  },
  summary: {
    githubApp: 'GitHub App-installation',
    email: 'e-post',
    webhook: 'webhook',
    webhooks: 'webhooks',
    polling: 'avfrågning',
    sync: 'synk',
    jiraModes: { links: 'länkar', mirror: 'spegling', sync: 'tvåvägssynk' },
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
    connect: 'Anslut',
    keepSecret: 'Lämna tomt för att behålla det nuvarande.',
    savedButError: 'Sparat, men: {error}',
    connected: '{provider} är ansluten',
  },
  connect: {
    title: 'Anslut {provider}',
    accessTokenTab: 'Åtkomsttoken',
    setUpElsewhere: 'Den här integrationen konfigureras någon annanstans.',
  },
  edit: {
    label: 'Inställningar för {name}',
    webhookUrl: 'Webhook-URL',
    appRepos: 'Välj repon på GitHub, i appens installationsinställningar.',
  },
  forge: {
    deliveryHeading: 'Hur Ordo får veta om ändringar',
    webhooks: 'Webhooks (direkt)',
    webhooksHint: '{provider} måste kunna nå {origin}.',
    polling: 'Avfrågning (varannan minut)',
    pollingHint: 'För instanser som {provider} inte kan nå.',
    pollingHintLocal: 'För instanser som {provider} inte kan nå – som den här verkar vara.',
    commentOnPullRequests: 'Kommentera pull requests med en länk till ärendet',
    repositories: 'Repon',
    accessToken: 'Åtkomsttoken',
    ownerNamePerLine: 'En ägare/namn per rad.',
    github: {
      docs: 'En finkornig token (fine-grained) med läsåtkomst till pull requests och innehåll, plus webhooks (läs och skriv) så att Ordo kan lägga till dem.',
      token: 'Personlig åtkomsttoken',
      apiUrl: 'API-URL',
      apiUrlHint: 'Ändra bara för GitHub Enterprise Server (https://host/api/v3).',
      webUrl: 'Webbadress',
    },
    gitlab: {
      docs: 'En personlig token, grupp- eller projekttoken med scopet ”api” (Maintainer, för att kunna lägga till webhooks).',
      baseUrl: 'GitLab-URL',
      projects: 'Projekt',
      projectsHint: 'En grupp/projektsökväg per rad.',
    },
    forgejo: {
      docs: 'En åtkomsttoken med läsåtkomst till repon och skrivåtkomst till deras webhooks (repo-admin).',
      baseUrl: 'Serverns URL',
    },
  },
  githubApp: {
    intro:
      'GitHub-appen är det smidigaste sättet: installera den på ditt konto eller din organisation, välj repon, klart. GitHub måste kunna nå {url}.',
    install: 'Installera {app} på GitHub',
    org: 'GitHub-organisation (valfritt)',
    orgHint:
      'Äger appen. Lämna tomt för att skapa den under ditt personliga konto. Appen är privat: den kan bara installeras där den ägs.',
    create: 'Skapa GitHub-appen',
    needsInstanceAdmin:
      'En instansadmin behöver skapa GitHub-appen en gång. Tills dess kan du ansluta med en token.',
  },
  slackApp: {
    tab: 'Lägg till i Slack',
    manualTab: 'Manuellt',
    intro: 'Anslut en Slack-arbetsyta med ett klick via den här instansens Slack-app.',
    add: 'Lägg till i Slack',
    needsHttps:
      'Slack skickar bara tillbaka personer till https-adresser, och den här instansen finns på {url}. Sätt ORDO_PUBLIC_URL till en https-adress, eller anslut manuellt.',
    needsInstanceAdmin:
      'En instansadmin behöver konfigurera Slack-appen en gång. Tills dess kan du ansluta manuellt med en token.',
    setupIntro:
      'Konfigurera Slack-appen en gång; sedan kan alla arbetsytors admins lägga till Ordo i Slack med ett klick.',
    step1: '1. Hur Slack når Ordo',
    step2: '2. Skapa appen',
    step2Body:
      'Slack öppnas med Ordos manifest ifyllt. Välj vilken arbetsyta som ska äga appen och skapa den.',
    createApp: 'Skapa Slack-appen',
    step3: '3. Kopiera uppgifterna',
    step3Body: 'Från Basic Information → App Credentials.',
    step3Socket:
      'Från Basic Information → App Credentials, och en token på appnivå (App-Level Tokens → Generate, med connections:write).',
    clientId: 'Klient-ID',
    clientSecret: 'Klienthemlighet',
    save: 'Spara Slack-appen',
    saved: 'Slack-appen sparad',
    change: 'Ändra Slack-appen',
    changeHint: 'Tomma hemligheter behålls. Anslutna arbetsytor byter till det nya leveranssättet.',
    connectedWith: 'Ansluten med Lägg till i Slack till {team}. Token hanteras av Slack.',
  },
  chat: {
    deliveryHeading: 'Hur Ordo får meddelanden från {provider}',
    channels: 'Kanaler',
    channelId: 'Kanal-id',
    channelNamePlaceholder: 'Namn (valfritt)',
    channelName: 'Kanalens namn',
    removeChannel: 'Ta bort kanal',
    fromTeams: 'Från de här teamen:',
    fromPublicTeams: 'Från alla publika team:',
    private: 'privat',
    newIssuesGoTo: 'Nya ärenden härifrån hamnar i {select}',
    defaultTeam: 'arbetsytans standardteam',
    threads: 'Synka kommentarer i trådar',
    threadsHint:
      'Senare aktivitet på ett ärende hamnar i tråden under dess första inlägg här, och svar där blir kommentarer.',
    addChannel: 'Lägg till kanal',
    events: {
      issueCreated: 'Nya ärenden',
      issueStatus: 'Statusändringar',
      issueCompleted: 'Slutförda ärenden',
      commentCreated: 'Kommentarer',
      projectUpdateCreated: 'Projektuppdateringar',
    },
    botToken: 'Bot-token',
    accessToken: 'Åtkomsttoken',
    slack: {
      docs: 'Skapa en Slack-app från manifestet i Ordos dokumentation, installera den i din arbetsyta och klistra sedan in dess tokens.',
      channelHint:
        'Kanal-id ser ut som C0123ABCD (channel details → About). Bjud in appen till kanalen.',
      events: 'Events API',
      eventsHint: 'Slack skickar till Ordo; Slack måste kunna nå den här servern.',
      socket: 'Socket Mode',
      socketHint: 'Ordo håller en anslutning öppen mot Slack. Fungerar bakom NAT och brandväggar.',
      signingSecret: 'Signing secret',
      appToken: 'App-level token',
      appTokenHint: 'Med scopet connections:write.',
    },
    discord: {
      docs: 'Skapa en applikation i Discord Developer Portal, lägg till en bot med Message Content intent och bjud in den med scopen bot och applications.commands.',
      channelHint:
        'Kanal-id är siffror (slå på Developer Mode och högerklicka sedan → Copy Channel ID).',
      interactions: 'Interactions endpoint',
      interactionsHint:
        'Discord skickar snedstreckskommandon till Ordo; Discord måste kunna nå den här servern.',
      gateway: 'Gateway',
      gatewayHint:
        'Ordo håller en anslutning öppen mot Discord. Fungerar bakom NAT; svarar också på !ordo-meddelanden och förhandsvisar länkar.',
      applicationId: 'Application id',
      publicKey: 'Public key',
      publicKeyHint: 'Finns under General Information; den verifierar förfrågningar från Discord.',
    },
    matrix: {
      docs: 'Registrera ett konto för boten på din hemserver och klistra in åtkomsttoken från en ny inloggning. Ordo synkar från din hemserver, så inget behöver nå Ordo.',
      encryption: 'Totalsträckskryptering',
      encryptionHint:
        'Låter boten läsa och skriva i krypterade rum. Kräver en token från en egen inloggning, inte en från Element eller en annan klient som redan har konfigurerat kryptering.',
      channelHint: 'Rum-id ser ut som !abc123:example.org (Room settings → Advanced).',
      homeserverUrl: 'Hemserverns URL',
    },
    telegram: {
      docs: 'Skapa en bot med @BotFather och klistra in dess token. För att se ärendelänkar i grupper behöver du stänga av botens sekretessläge (Group Privacy).',
      channelHint: 'Grupp-id är negativa tal, t.ex. -1001234567890.',
      webhook: 'Webhook',
      webhookHint:
        'Telegram skickar till Ordo; Telegram måste kunna nå den här servern över HTTPS.',
      longpoll: 'Long polling',
      longpollHint: 'Ordo frågar Telegram efter uppdateringar. Fungerar bakom NAT.',
    },
  },
  email: {
    connected: 'E-postintag anslutet',
    intro:
      'E-post till den här adressen blir ett ärende i teamet nedan – i triage, om teamet har det – kopplat till avsändarens kund. Svar i samma tråd blir kommentarer. Autosvar och studsar ignoreras.',
    teamNoTriage: '{team} (ingen triage: nya ärenden hamnar i teamets standardstatus)',
    address: 'Adress',
    addressHint: 'Adressen folk skriver till; visas bara i Ordo.',
    imap: 'Läs en brevlåda (IMAP)',
    imapHint:
      'Ordo läser ny e-post varje minut och markerar den som läst. Fungerar bakom NAT och brandväggar.',
    webhook: 'Ta emot via webhook',
    webhookHint:
      'Något som tar emot din e-post (en e-post-worker, en pipe i e-postservern) skickar varje rått meddelande till Ordo med POST.',
    imapServer: 'IMAP-server',
    port: 'Port',
    tls: 'TLS (port 993); avmarkera för STARTTLS på 143',
    username: 'Användarnamn',
    password: 'Lösenord',
    passwordHint: 'Ett applösenord, om leverantören har sådana.',
    folder: 'Mapp',
    postRaw: 'Skicka varje meddelande rått ({type}) med POST till webhook-URL:en ovan.',
    webhookAfterConnect: 'Webhook-URL:en visas när integrationen är ansluten.',
    issuesGoTo: 'Ärenden hamnar i {team}.',
  },
  jira: {
    connected: 'Jira anslutet',
    intro:
      'Jira Cloud eller Data Center. Cloud loggar in med din Atlassian-e-post och en API-token, Data Center med en personlig åtkomsttoken.',
    siteUrl: 'Jira-adress',
    email: 'E-post för Atlassian-kontot',
    emailHint: 'Bara Jira Cloud. Lämna tomt för Data Center.',
    token: 'API-token eller personlig åtkomsttoken',
    modeTitle: 'Vad den gör',
    modes: {
      links: 'Bara länkar',
      linksHint:
        'Jira-nycklar och -adresser i Ordo-ärenden och kommentarer blir länkar som visar Jira-statusen, med en länk tillbaka i Jira.',
      mirror: 'Spegla Jira i Ordo',
      mirrorHint:
        'Ärenden i projekten nedan dyker upp i sitt team och följer Jira: titel, beskrivning, status, prioritet, ansvarig och kommentarer. Ordo skriver inget till Jira.',
      sync: 'Tvåvägssynk',
      syncHint:
        'Som speglingen, och ändringar i Ordo går till Jira också. Nya Ordo-ärenden kan skapas i Jira.',
    },
    projects: 'Jira-projekt',
    projectsHintLinks:
      'Valfritt: vilka projekts nycklar (PROJ-123) som känns igen. Tomt betyder alla projekt som token ser. Adresser fungerar alltid.',
    projectsHintSync: 'Varje projekts ärenden hamnar i teamet som valts för det.',
    projectKey: 'Projektnyckel',
    team: 'Team',
    issueType: 'Ärendetyp',
    issueTypeHint: 'För ärenden som Ordo skapar i Jira',
    createInOrdo: 'Nya Jira-ärenden dyker upp i Ordo',
    createInJira: 'Nya ärenden i teamet skapas i Jira',
    addProject: 'Lägg till projekt',
    removeProject: 'Ta bort projekt',
    backlinks: 'Lägg till en länk tillbaka till Ordo på Jira-ärenden',
    deliveryTitle: 'Hur Ordo får veta om ändringar',
    webhook: 'Webhook',
    webhookHint:
      'En administratör lägger till en webhook i Jira (System → WebHooks) med adressen som visas efter anslutningen. Jira måste nå den här servern.',
    poll: 'Avfrågning (varannan minut)',
    pollHint: 'Ordo frågar Jira vad som har ändrats. Fungerar bakom NAT och brandväggar.',
    webhookSecret: 'Webhook-hemlighet',
    webhookSecretHint:
      'Valfritt. Ange samma hemlighet i Jiras webhook; då tar Ordo bara emot signerade leveranser.',
  },
  gitAccounts: {
    title: 'Git-användarnamn',
    description:
      'Dina användarnamn på de kodplattformar som {workspace} är anslutet till, så att dina pull requests visas som dina.',
    remove: 'Ta bort {username}',
    placeholder: 'användarnamn',
    usernameLabel: 'Ditt användarnamn på {service}',
  },
  chatAccounts: {
    title: 'Chatt',
    description:
      'Länka dina chattkonton för att få notiser som direktmeddelanden och skapa ärenden från chatten som dig själv.',
    linkAnother: 'Länka ett till',
    linkAccount: 'Länka konto',
    send: 'Skicka {command}',
    copyCode: 'Kopiera kod',
    validity: 'gäller i 15 minuter, en gång',
    linkedAccount: 'länkat konto',
    linkedAgo: 'länkat {time}',
    notificationsOn: 'Notiser på',
    notificationsOff: 'Notiser av',
    turnNotificationsOn: 'Slå på notiser',
    turnNotificationsOff: 'Stäng av notiser',
    unlink: 'Ta bort länk',
    confirmUnlinkTitle: 'Ta bort länken till det här {service}-kontot?',
    confirmUnlinkBody: 'Du slutar få notiser där.',
  },
  providers: {
    github:
      'Koppla pull requests, grenar och commits till ärenden och flytta ärenden i takt med att PR:erna går framåt.',
    gitlab: 'Koppla merge requests, grenar och commits från GitLab.com eller ert eget GitLab.',
    forgejo: 'Koppla pull requests, grenar och commits från Forgejo, Gitea eller Codeberg.',
    slack:
      'Posta ärendeaktivitet i kanaler, skicka notiser som DM, skapa ärenden från meddelanden och visa förhandsvisningar av länkar.',
    discord:
      'Posta ärendeaktivitet i kanaler, skicka notiser som DM, skapa ärenden från meddelanden och förhandsvisa länkar.',
    matrix:
      'Posta ärendeaktivitet i rum, skicka notiser som meddelanden och skapa ärenden från meddelanden.',
    telegram:
      'Posta ärendeaktivitet i grupper, skicka notiser som meddelanden och skapa ärenden från meddelanden.',
    email: 'Gör e-post till en adress till ärenden i triage, kopplade till avsändarens kund.',
    jira: 'Länka Jira-ärenden, spegla Jira-projekt till team eller håll ärenden synkade åt båda hållen.',
  },
  providerNames: {
    email: 'E-post',
  },
} satisfies Translation<Catalog['integrations']>;
