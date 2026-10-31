import type { Catalog, Translation } from '../index.ts';

export default {
  repositories: {
    adminsOnly: 'Bara admins kan hantera repon.',
    title: 'Repon',
    description:
      'Var er kod finns. Projekt listar sina repon och team väljer ett standardrepo, så att en agents runner vet vad den ska checka ut. Ordo sparar bara adressen: runners använder sina egna git-inloggningar.',
    empty: '// inga repon än',
    add: 'Lägg till repo',
    browse: 'Bläddra…',
    edit: 'Redigera {name}',
    delete: 'Ta bort {name}',
    confirmDelete: 'Ta bort repot {name}? Projekt och team som använder det tappar det.',
    branch: 'standardgren {branch}',
    maxRuns: { one: 'högst {count} körning åt gången', other: 'högst {count} körningar åt gången' },
    form: {
      label: 'Repo',
      new: 'Nytt repo',
      edit: 'Redigera repo',
      name: 'Namn',
      url: 'Klon-URL',
      urlHint: 'https://…, ssh://…, git@host:ägare/repo.git eller en sökväg på runnern.',
      defaultBranch: 'Standardgren',
      maxRuns: 'Högst N körningar åt gången',
      maxRunsHint:
        'Så att agenter inte arbetar i varandras filer: körningar utöver det här antalet, från vilken agent som helst, väntar i kön. Lämna tomt för ingen gräns.',
      maxRunsPlaceholder: 'Ingen gräns',
      linked: 'Kopplat till {repo} på {integration}.',
    },
    picker: {
      label: 'Bläddra bland repon',
      integration: 'Anslutning',
      search: 'Sök repon…',
      cloneWith: 'Klona med',
      empty: '// inga repon hittades',
      private: 'privat',
      added: 'tillagt',
    },
    project: 'Repon',
    projectHint: 'Där agenter arbetar med projektets ärenden.',
    teamDefault: 'Standardrepo',
    teamDefaultHint: 'För agenter som arbetar med ärenden som inte ligger i ett projekt med repon.',
    none: 'Inget',
    manage: 'Hantera repon',
  },
} satisfies Translation<Catalog['agents']>;
