import type { Catalog, Translation } from '../index.ts';

export default {
  connect: {
    title: 'Koble til en KI-agent',
    description:
      'Ordo kjører en MCP-server for {workspace}. Agenter som Claude, Claude Code, Cursor eller VS Code kobler seg til den og handler som deg: de ser teamene du ser, og det de endrer, vises under navnet ditt. De fleste logger inn med OAuth – du godkjenner dem i nettleseren og kan koble dem fra nedenfor. Andre bruker en av API-nøklene dine. Se {doc}.',
    blockedKicker: '// api-nøkler er blokkert her',
    blockedBody:
      '{workspace} krever SSO og tillater ikke API-nøkler. Logg inn agenter med OAuth i stedet, eller be en admin om å tillate nøkler under Innstillinger → Autentisering.',
    serverUrl: 'Serverens URL',
    serverUrlHint: 'Én URL per arbeidsområde. Transporten er Streamable HTTP.',
    signInWith: 'Logg inn med',
    signInWithHint: 'OAuth trenger ingen nøkkel; bruk en nøkkel for klienter uten OAuth.',
    apiKey: 'API-nøkkel',
  },
  key: {
    title: 'Opprett en nøkkel for agenten',
    description:
      'En personlig API-nøkkel som vises én gang. Du kan trekke den tilbake når som helst under API-nøkler.',
    defaultName: 'KI-agent',
    nameLabel: 'Nøkkelnavn',
    create: 'Opprett nøkkel',
    copyNow: '// kopier den nå – den vises ikke igjen',
    fillIntoSnippets: 'Fyll inn denne nøkkelen i oppsettseksemplene nedenfor',
  },
  setup: {
    title: 'Sett det opp selv',
    cantConnect: '{client} kan ikke koble til på denne måten.',
    clientsLabel: 'MCP-klient',
    replacePlaceholder: 'Erstatt {placeholder} med nøkkelen din.',
    otherClient: 'Annen',
    claudeOauth:
      'I claude.ai eller Claude Desktop: Settings → Connectors → Add custom connector, og lim inn URL-en. Claude åpner deretter Ordo så du kan godkjenne den.',
    claudeKey:
      'Bare Claude Desktop: Settings → Developer → Edit config (claude_desktop_config.json), og start Claude på nytt. Bruker broen mcp-remote, som krever Node.js.',
    claudeCodeOauth:
      'Kjør i en terminal, skriv deretter /mcp i Claude Code og velg serveren for å logge inn. --scope user gjør Ordo tilgjengelig i alle prosjekter.',
    claudeCodeKey: 'Kjør i en terminal. --scope user gjør Ordo tilgjengelig i alle prosjekter.',
    cursorOauth:
      '~/.cursor/mcp.json (alle prosjekter) eller .cursor/mcp.json i et prosjekt. Cursor ber deg logge inn første gang den kobler til.',
    cursorKey: '~/.cursor/mcp.json (alle prosjekter) eller .cursor/mcp.json i et prosjekt.',
    vscodeOauth:
      '.vscode/mcp.json, eller «MCP: Open User Configuration». VS Code ber deg logge inn når serveren starter.',
    vscodeKey:
      '.vscode/mcp.json, eller «MCP: Open User Configuration». VS Code spør etter nøkkelen én gang og lagrer den i sitt hemmelige lager.',
    otherOauth:
      'Alle MCP-klienter som støtter transporten Streamable HTTP og OAuth. Klienten finner ut hvordan den logger inn ut fra URL-en.',
    otherKey: 'Alle MCP-klienter som støtter transporten Streamable HTTP og egne headere.',
  },
  agent: {
    title: 'Eller la agenten gjøre det',
    description:
      'Lim inn dette i kodeagenten din. Den legger serveren til i sin egen MCP-konfigurasjon og tester tilkoblingen med et kall.',
    includeKey: 'Ta med nøkkelen jeg nettopp opprettet i prompten',
    promptOauth: `Koble deg til Ordo, saksbehandlingssystemet vårt, via MCP-serveren.

- Serverens URL: {url}
- Transport: Streamable HTTP (arbeidsområdet «{workspace}»)
- Autentisering: OAuth. Serveren forteller MCP-klienten din hvordan den logger inn; jeg godkjenner det i nettleseren min.

Steg:
1. Finn ut hvilken MCP-klient du kjører i, og legg serveren til i MCP-konfigurasjonen på brukernivå under navnet «{name}», uten headere. I Claude Code er det:
   claude mcp add --transport http --scope user {name} {url}
   I Cursor eller VS Code redigerer du i stedet MCP-konfigurasjonsfilen deres (se Ordo → Innstillinger → KI-agenter for nøyaktig format).
2. Fortell meg hvordan jeg starter innloggingen (i Claude Code: kjør /mcp og velg «{name}»), eller last inn MCP-serverne på nytt hvis klienten din starter den selv.
3. Når jeg har godkjent, bekreft tilkoblingen ved å kalle verktøyet list_teams og vis meg teamnøklene du får tilbake.
   - 404 betyr at URL-en er feil, eller at jeg ikke er medlem av det arbeidsområdet.

Ordo-verktøyene handler som meg, med mine tillatelser. Spør meg før du oppretter eller endrer saker, med mindre jeg har bedt deg om det.`,
    promptKey: `Koble deg til Ordo, saksbehandlingssystemet vårt, via MCP-serveren.

- Serverens URL: {url}
- Transport: Streamable HTTP (arbeidsområdet «{workspace}»)
- Autentisering: min personlige API-nøkkel for Ordo, sendt som HTTP-headeren "Authorization: Bearer <key>".
  {keyLine}

Steg:
1. Finn ut hvilken MCP-klient du kjører i, og legg serveren til i MCP-konfigurasjonen på brukernivå under navnet «{name}». I Claude Code er det:
   claude mcp add --transport http --scope user {name} {url} --header "Authorization: Bearer $ORDO_API_KEY"
   I Cursor, VS Code eller Claude Desktop redigerer du i stedet MCP-konfigurasjonsfilen deres (se Ordo → Innstillinger → KI-agenter for nøyaktig format).
2. Last inn MCP-serverne på nytt, eller si fra om jeg må starte deg på nytt.
3. Bekreft tilkoblingen ved å kalle verktøyet list_teams og vis meg teamnøklene du får tilbake.
   - 401 betyr at nøkkelen er feil eller er trukket tilbake.
   - 403 betyr at arbeidsområdet krever SSO og ikke tillater API-nøkler.
   - 404 betyr at URL-en er feil, eller at jeg ikke er medlem av det arbeidsområdet.

Ordo-verktøyene handler som meg, med mine tillatelser. Spør meg før du oppretter eller endrer saker, med mindre jeg har bedt deg om det.`,
    promptKeyGiven:
      'Nøkkelen er {key}. Lagre den i MCP-konfigurasjonen til klienten din eller i en miljøvariabel, aldri i en fil som sjekkes inn i git, og ikke gjenta den til meg.',
    promptKeyLater:
      'Jeg gir deg nøkkelen når du ber om den (eller den ligger i miljøvariabelen ORDO_API_KEY). Skriv den aldri inn i en fil som sjekkes inn i git, og ikke gjenta den til meg.',
  },
  tools: {
    title: 'Hva agenten kan gjøre',
    description:
      'Verktøyene tar imot teamnøkler, saks-ID-er, navn på statuser og etiketter, og brukernavn.',
    read: 'les',
    write: 'skriv',
    descriptions: {
      list_teams: 'Team du har tilgang til, med nøkler og arbeidsflytens statuser.',
      list_statuses: 'Et teams statuser i rekkefølge, med type.',
      list_members: 'Personer i arbeidsområdet: navn, brukernavn og rolle.',
      list_labels: 'Etiketter for arbeidsområdet og for teamene.',
      list_custom_fields: 'De egendefinerte feltene saker kan ha, med typer og alternativer.',
      list_projects: 'Prosjekter med status, ansvarlig, team, datoer og fremdrift.',
      list_cycles: 'Nåværende og kommende sykluser (sprinter) per team.',
      search_issues:
        'Finn saker med tekst og filtre (team, status, ansvarlig, etiketter, prosjekt, syklus, prioritet). Bare åpne saker med mindre includeClosed, status eller statusType er satt.',
      my_issues: 'Åpne saker der du er ansvarlig, de mest hastende først.',
      get_issue: 'Én sak i sin helhet: beskrivelse, kommentarer, undersaker, relasjoner og lenker.',
      create_issue: 'Opprett en sak i et team. Statuser, etiketter og personer oppgis med navn.',
      update_issue:
        'Endre en sak: tittel, beskrivelse, status, prioritet, ansvarlig, etiketter, prosjekt, syklus, overordnet sak, estimat eller forfallsdato.',
      add_comment: 'Kommenter en sak (Markdown, @omtaler varsler personer).',
    },
  },
  apps: {
    title: 'Tilkoblede apper',
    description: 'Apper du har tillatt å bruke Ordos MCP-server som deg, i alle arbeidsområder.',
    verified: 'Verifisert',
    used: 'brukt {time}',
    added: 'lagt til {time}',
    empty: '// ingen tilkoblede apper',
    disconnect: 'Koble fra',
    disconnectName: 'Koble fra {name}',
    confirmDisconnectTitle: 'Koble fra {name}?',
    confirmDisconnectBody:
      'Den mister tilgangen med en gang og må be om tilgang på nytt for å koble til igjen.',
  },
} satisfies Translation<Catalog['mcp']>;
