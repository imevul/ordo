import type { Catalog, Translation } from '../index.ts';

export default {
  connect: {
    title: 'Anslut en AI-agent',
    description:
      'Ordo kör en MCP-server för {workspace}. Agenter som Claude, Claude Code, Cursor eller VS Code ansluter till den och agerar som du: de ser de team du ser, och det de ändrar visas under ditt namn. De flesta loggar in med OAuth – du godkänner dem i webbläsaren och kan koppla från dem nedan. Andra använder en av dina API-nycklar. Se {doc}.',
    blockedKicker: '// api-nycklar är blockerade här',
    blockedBody:
      '{workspace} kräver SSO och tillåter inte API-nycklar. Logga in agenter med OAuth i stället, eller be en admin att tillåta nycklar under Inställningar → Autentisering.',
    serverUrl: 'Serverns URL',
    serverUrlHint: 'En URL per arbetsyta. Transporten är Streamable HTTP.',
    signInWith: 'Logga in med',
    signInWithHint: 'OAuth kräver ingen nyckel; använd en nyckel för klienter som saknar OAuth.',
    apiKey: 'API-nyckel',
  },
  key: {
    title: 'Skapa en nyckel för agenten',
    description:
      'En personlig API-nyckel som visas en gång. Du kan återkalla den när som helst under API-nycklar.',
    defaultName: 'AI-agent',
    nameLabel: 'Nyckelns namn',
    create: 'Skapa nyckel',
    copyNow: '// kopiera den nu – den visas inte igen',
    fillIntoSnippets: 'Fyll i den här nyckeln i konfigurationsexemplen nedan',
  },
  setup: {
    title: 'Konfigurera själv',
    cantConnect: '{client} kan inte ansluta på det här sättet.',
    clientsLabel: 'MCP-klient',
    replacePlaceholder: 'Ersätt {placeholder} med din nyckel.',
    otherClient: 'Annan',
    claudeOauth:
      'I claude.ai eller Claude Desktop: Settings → Connectors → Add custom connector, och klistra in URL:en. Claude öppnar sedan Ordo så att du kan godkänna den.',
    claudeKey:
      'Bara Claude Desktop: Settings → Developer → Edit config (claude_desktop_config.json), starta sedan om Claude. Använder bryggan mcp-remote, som kräver Node.js.',
    claudeCodeOauth:
      'Kör i en terminal, skriv sedan /mcp i Claude Code och välj servern för att logga in. --scope user gör Ordo tillgängligt i alla projekt.',
    claudeCodeKey: 'Kör i en terminal. --scope user gör Ordo tillgängligt i alla projekt.',
    cursorOauth:
      '~/.cursor/mcp.json (alla projekt) eller .cursor/mcp.json i ett projekt. Cursor ber dig logga in första gången den ansluter.',
    cursorKey: '~/.cursor/mcp.json (alla projekt) eller .cursor/mcp.json i ett projekt.',
    vscodeOauth:
      '.vscode/mcp.json, eller ”MCP: Open User Configuration”. VS Code ber dig logga in när servern startar.',
    vscodeKey:
      '.vscode/mcp.json, eller ”MCP: Open User Configuration”. VS Code frågar efter nyckeln en gång och sparar den i sin hemliga lagring.',
    otherOauth:
      'Alla MCP-klienter som stöder transporten Streamable HTTP och OAuth. Klienten tar reda på hur den loggar in utifrån URL:en.',
    otherKey: 'Alla MCP-klienter som stöder transporten Streamable HTTP och egna headers.',
  },
  agent: {
    title: 'Eller låt agenten göra det',
    description:
      'Klistra in det här i din kodagent. Den lägger till servern i sin egen MCP-konfiguration och testar anslutningen med ett anrop.',
    includeKey: 'Ta med nyckeln jag just skapade i prompten',
    promptOauth: `Anslut dig till Ordo, vårt ärendehanteringssystem, via dess MCP-server.

- Serverns URL: {url}
- Transport: Streamable HTTP (arbetsytan ”{workspace}”)
- Autentisering: OAuth. Servern talar om för din MCP-klient hur den loggar in; jag godkänner det i min webbläsare.

Steg:
1. Ta reda på vilken MCP-klient du kör i och lägg till servern i dess MCP-konfiguration på användarnivå under namnet ”{name}”, utan headers. I Claude Code är det:
   claude mcp add --transport http --scope user {name} {url}
   I Cursor eller VS Code redigerar du i stället deras MCP-konfigurationsfil (se Ordo → Inställningar → AI-agenter för exakt format).
2. Berätta hur jag startar inloggningen (i Claude Code: kör /mcp och välj ”{name}”), eller ladda om MCP-servrarna om din klient startar den själv.
3. När jag har godkänt, verifiera anslutningen genom att anropa verktyget list_teams och visa mig teamnycklarna du får tillbaka.
   - 404 betyder att URL:en är fel eller att jag inte är medlem i den arbetsytan.

Ordos verktyg agerar som mig, med mina behörigheter. Fråga mig innan du skapar eller ändrar ärenden, om jag inte har bett dig göra det.`,
    promptKey: `Anslut dig till Ordo, vårt ärendehanteringssystem, via dess MCP-server.

- Serverns URL: {url}
- Transport: Streamable HTTP (arbetsytan ”{workspace}”)
- Autentisering: min personliga API-nyckel för Ordo, skickad som HTTP-headern "Authorization: Bearer <key>".
  {keyLine}

Steg:
1. Ta reda på vilken MCP-klient du kör i och lägg till servern i dess MCP-konfiguration på användarnivå under namnet ”{name}”. I Claude Code är det:
   claude mcp add --transport http --scope user {name} {url} --header "Authorization: Bearer $ORDO_API_KEY"
   I Cursor, VS Code eller Claude Desktop redigerar du i stället deras MCP-konfigurationsfil (se Ordo → Inställningar → AI-agenter för exakt format).
2. Ladda om MCP-servrarna, eller säg till om jag behöver starta om dig.
3. Verifiera anslutningen genom att anropa verktyget list_teams och visa mig teamnycklarna du får tillbaka.
   - 401 betyder att nyckeln är fel eller har återkallats.
   - 403 betyder att arbetsytan kräver SSO och inte tillåter API-nycklar.
   - 404 betyder att URL:en är fel eller att jag inte är medlem i den arbetsytan.

Ordos verktyg agerar som mig, med mina behörigheter. Fråga mig innan du skapar eller ändrar ärenden, om jag inte har bett dig göra det.`,
    promptKeyGiven:
      'Nyckeln är {key}. Spara den i din klients MCP-konfiguration eller i en miljövariabel, aldrig i en fil som checkas in i git, och upprepa den inte för mig.',
    promptKeyLater:
      'Jag ger dig nyckeln när du ber om den (eller så finns den i miljövariabeln ORDO_API_KEY). Skriv aldrig in den i en fil som checkas in i git, och upprepa den inte för mig.',
  },
  tools: {
    title: 'Vad agenten kan göra',
    description:
      'Verktygen tar emot teamnycklar, ärende-ID:n, namn på statusar och etiketter samt användarnamn.',
    read: 'läs',
    write: 'skriv',
    descriptions: {
      list_teams: 'Team du har åtkomst till, med nycklar och arbetsflödets statusar.',
      list_statuses: 'Ett teams statusar i ordning, med typ.',
      list_members: 'Personer i arbetsytan: namn, användarnamn och roll.',
      list_labels: 'Arbetsytans etiketter och teamens etiketter.',
      list_custom_fields: 'De anpassade fält ärenden kan ha, med typer och alternativ.',
      list_projects: 'Projekt med status, ansvarig, team, datum och framsteg.',
      list_cycles: 'Pågående och kommande cykler (sprintar) per team.',
      search_issues:
        'Hitta ärenden med text och filter (team, status, ansvarig, etiketter, projekt, cykel, prioritet). Bara öppna ärenden om inte includeClosed, status eller statusType anges.',
      my_issues: 'Öppna ärenden där du är ansvarig, mest brådskande först.',
      get_issue:
        'Ett ärende i sin helhet: beskrivning, kommentarer, underärenden, relationer och länkar.',
      create_issue: 'Skapa ett ärende i ett team. Statusar, etiketter och personer anges med namn.',
      update_issue:
        'Ändra ett ärende: titel, beskrivning, status, prioritet, ansvarig, etiketter, projekt, cykel, överordnat ärende, uppskattning eller förfallodatum.',
      add_comment: 'Kommentera ett ärende (Markdown, @omnämnanden notifierar personer).',
    },
  },
  apps: {
    title: 'Anslutna appar',
    description: 'Appar du har tillåtit att använda Ordos MCP-server som dig, i alla arbetsytor.',
    verified: 'Verifierad',
    used: 'använd {time}',
    added: 'tillagd {time}',
    empty: '// inga anslutna appar',
    disconnect: 'Koppla från',
    disconnectName: 'Koppla från {name}',
    confirmDisconnectTitle: 'Koppla från {name}?',
    confirmDisconnectBody:
      'Den förlorar åtkomsten direkt och måste be om lov igen för att återansluta.',
  },
} satisfies Translation<Catalog['mcp']>;
