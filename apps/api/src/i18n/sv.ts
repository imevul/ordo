import type { Translation } from '@ordo/shared';
import type en from './en.ts';

/** Swedish. Anything missing falls back to English (en.ts). */
export default {
  email: {
    footer: 'Skickat av din Ordo-instans',
    passwordReset: {
      subject: 'Återställ ditt lösenord i Ordo',
      kicker: 'återställ lösenord',
      title: 'Hej {name},',
      body: 'Någon (förhoppningsvis du) bad om att få återställa ditt lösenord. Länken fungerar en gång, i en timme.',
      ignore:
        'Om det inte var du kan du strunta i det här mejlet – ditt lösenord förblir detsamma.',
      cta: 'Välj ett nytt lösenord',
      text: 'Hej {name},\n\nÅterställ ditt lösenord i Ordo (gäller i en timme):\n{url}\n\nOm det inte var du kan du strunta i det här mejlet.',
    },
    verify: {
      subject: 'Bekräfta din e-postadress',
      kicker: 'bekräfta e-post',
      title: 'Välkommen, {name}',
      body: 'Bekräfta att det här är din e-postadress. Länken gäller i två dagar.',
      cta: 'Bekräfta e-post',
      text: 'Bekräfta din e-postadress i Ordo:\n{url}',
    },
    change: {
      subject: 'Bekräfta din nya e-postadress',
      kicker: 'byt e-post',
      title: 'Bekräfta din nya adress',
      body: 'Bekräfta adressen så blir det den du loggar in med.',
      cta: 'Bekräfta adressen',
      text: 'Bekräfta din nya e-postadress i Ordo:\n{url}',
    },
    invite: {
      subject: '{inviter} har bjudit in dig till {workspace} i Ordo',
      kicker: 'inbjudan',
      title: 'Gå med i {workspace}',
      body: '{inviter} har bjudit in dig till arbetsytan <b>{workspace}</b> som {role}.',
      cta: 'Tacka ja',
      text: '{inviter} har bjudit in dig till {workspace} i Ordo som {role}.\n\nTacka ja: {url}',
      role: { owner: 'ägare', admin: 'admin', member: 'medlem', guest: 'gäst' },
    },
    security: {
      kicker: 'säkerhet',
      notYou: 'Om det inte var du: byt lösenord och kontakta din administratör.',
      cta: 'Öppna kontoinställningarna',
      twoFactorOn: {
        title: 'Tvåstegsverifiering är på',
        body: 'För att logga in i Ordo behövs nu också en kod från din autentiseringsapp.',
      },
      twoFactorOff: {
        title: 'Tvåstegsverifiering är av',
        body: 'För att logga in i Ordo behövs nu bara ditt lösenord.',
      },
      passkeyAdded: {
        title: 'En lösennyckel har lagts till på ditt Ordo-konto',
        body: 'Lösennyckeln ”{name}” kan nu logga in på ditt konto.',
      },
      passkeyRemoved: {
        title: 'En lösennyckel har tagits bort från ditt Ordo-konto',
        body: 'Lösennyckeln ”{name}” kan inte längre logga in på ditt konto.',
      },
      emailChanged: {
        title: 'Din e-postadress i Ordo har ändrats',
        body: 'Ditt konto använder nu {email}.',
      },
    },
    digest: {
      kicker: 'inkorg',
      updates: {
        one: '{count} uppdatering i {workspace}',
        other: '{count} uppdateringar i {workspace}',
      },
      footer: 'Välj vilka mejl du får under Inställningar → Notiser',
      settings: 'Notisinställningar: {url}',
    },
  },
  notification: {
    issue_assigned: '{actor} gjorde dig ansvarig',
    issue_unassigned: '{actor} tog bort dig som ansvarig',
    issue_comment: '{actor} kommenterade',
    issue_mention: '{actor} nämnde dig',
    issue_status_changed: '{actor} flyttade det till {state}',
    issue_priority_urgent: '{actor} markerade det som brådskande',
    comment_reaction: '{actor} reagerade på din kommentar',
    issue_sla_breached: 'Missade sin SLA',
    someone: 'Någon',
  },
  chat: {
    issue_assigned: '{actor} gjorde dig ansvarig för {issue}',
    issue_unassigned: '{actor} tog bort dig som ansvarig för {issue}',
    issue_comment: '{actor} kommenterade {issue}',
    issue_mention: '{actor} nämnde dig i {issue}',
    issue_status_changed: '{actor} flyttade {issue} till {state}',
    issue_priority_urgent: '{actor} markerade {issue} som brådskande',
    comment_reaction: '{actor} reagerade på din kommentar i {issue}',
    issue_sla_breached: '{issue} missade sin SLA',
    unassigned: 'Ingen ansvarig',
    priority: { '1': 'Brådskande', '2': 'Hög', '3': 'Medel', '4': 'Låg' },
  },
} satisfies Translation<typeof en>;
