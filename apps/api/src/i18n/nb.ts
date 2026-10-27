import type { Translation } from '@ordo/shared';
import type en from './en.ts';

/** Norwegian Bokmål. Anything missing falls back to English (en.ts). */
export default {
  email: {
    footer: 'Sendt av Ordo-instansen din',
    passwordReset: {
      subject: 'Tilbakestill passordet ditt i Ordo',
      kicker: 'tilbakestill passord',
      title: 'Hei {name},',
      body: 'Noen (forhåpentligvis du) ba om å tilbakestille passordet ditt. Lenken virker én gang, i én time.',
      ignore:
        'Hvis det ikke var deg, kan du se bort fra denne e-posten – passordet ditt forblir det samme.',
      cta: 'Velg et nytt passord',
      text: 'Hei {name},\n\nTilbakestill passordet ditt i Ordo (gyldig i én time):\n{url}\n\nHvis det ikke var deg, kan du se bort fra denne e-posten.',
    },
    verify: {
      subject: 'Bekreft e-postadressen din',
      kicker: 'bekreft e-post',
      title: 'Velkommen, {name}',
      body: 'Bekreft at dette er e-postadressen din. Lenken er gyldig i to dager.',
      cta: 'Bekreft e-post',
      text: 'Bekreft e-postadressen din i Ordo:\n{url}',
    },
    change: {
      subject: 'Bekreft den nye e-postadressen din',
      kicker: 'bytt e-post',
      title: 'Bekreft den nye adressen din',
      body: 'Bekreft adressen, så blir det den du logger inn med.',
      cta: 'Bekreft adressen',
      text: 'Bekreft den nye e-postadressen din i Ordo:\n{url}',
    },
    invite: {
      subject: '{inviter} har invitert deg til {workspace} i Ordo',
      kicker: 'invitasjon',
      title: 'Bli med i {workspace}',
      body: '{inviter} har invitert deg til arbeidsområdet <b>{workspace}</b> som {role}.',
      cta: 'Godta invitasjonen',
      text: '{inviter} har invitert deg til {workspace} i Ordo som {role}.\n\nGodta: {url}',
      role: { owner: 'eier', admin: 'admin', member: 'medlem', guest: 'gjest' },
    },
    security: {
      kicker: 'sikkerhet',
      notYou: 'Hvis det ikke var deg: bytt passord og kontakt administratoren din.',
      cta: 'Åpne kontoinnstillingene',
      twoFactorOn: {
        title: 'Tofaktorautentisering er på',
        body: 'For å logge inn i Ordo trengs det nå også en kode fra autentiseringsappen din.',
      },
      twoFactorOff: {
        title: 'Tofaktorautentisering er av',
        body: 'For å logge inn i Ordo trengs det nå bare passordet ditt.',
      },
      emailChanged: {
        title: 'E-postadressen din i Ordo er endret',
        body: 'Kontoen din bruker nå {email}.',
      },
    },
    digest: {
      kicker: 'innboks',
      updates: {
        one: '{count} oppdatering i {workspace}',
        other: '{count} oppdateringer i {workspace}',
      },
      footer: 'Velg hvilke e-poster du får under Innstillinger → Varsler',
      settings: 'Varslingsinnstillinger: {url}',
    },
  },
  notification: {
    issue_assigned: '{actor} gjorde deg ansvarlig',
    issue_unassigned: '{actor} fjernet deg som ansvarlig',
    issue_comment: '{actor} kommenterte',
    issue_mention: '{actor} nevnte deg',
    issue_status_changed: '{actor} flyttet den til {state}',
    issue_priority_urgent: '{actor} markerte den som hastende',
    comment_reaction: '{actor} reagerte på kommentaren din',
    issue_sla_breached: 'Brøt SLA-en',
    someone: 'Noen',
  },
  chat: {
    issue_assigned: '{actor} gjorde deg ansvarlig for {issue}',
    issue_unassigned: '{actor} fjernet deg som ansvarlig for {issue}',
    issue_comment: '{actor} kommenterte {issue}',
    issue_mention: '{actor} nevnte deg i {issue}',
    issue_status_changed: '{actor} flyttet {issue} til {state}',
    issue_priority_urgent: '{actor} markerte {issue} som hastende',
    comment_reaction: '{actor} reagerte på kommentaren din i {issue}',
    issue_sla_breached: '{issue} brøt SLA-en',
    unassigned: 'Ingen ansvarlig',
    priority: { '1': 'Haster', '2': 'Høy', '3': 'Middels', '4': 'Lav' },
  },
} satisfies Translation<typeof en>;
