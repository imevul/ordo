import type { Catalog, Translation } from '../index.ts';

export default {
  repositories: {
    adminsOnly: 'Bare administratorer kan administrere repoer.',
    title: 'Repoer',
    description:
      'Hvor koden deres ligger. Prosjekter lister repoene sine og team velger et standardrepo, slik at en agents runner vet hva den skal sjekke ut. Ordo lagrer bare adressen: runnere bruker sin egen git-pålogging.',
    empty: '// ingen repoer ennå',
    add: 'Legg til repo',
    browse: 'Bla gjennom…',
    edit: 'Rediger {name}',
    delete: 'Slett {name}',
    confirmDelete: 'Slette repoet {name}? Prosjekter og team som bruker det, mister det.',
    branch: 'standardgren {branch}',
    maxRuns: { one: 'høyst {count} kjøring om gangen', other: 'høyst {count} kjøringer om gangen' },
    form: {
      label: 'Repo',
      new: 'Nytt repo',
      edit: 'Rediger repo',
      name: 'Navn',
      url: 'Klone-URL',
      urlHint: 'https://…, ssh://…, git@vert:eier/repo.git eller en sti på runneren.',
      defaultBranch: 'Standardgren',
      maxRuns: 'Høyst N kjøringer om gangen',
      maxRunsHint:
        'Så agenter ikke jobber i hverandres filer: kjøringer utover dette antallet, fra hvilken som helst agent, venter i køen. La stå tomt for ingen grense.',
      maxRunsPlaceholder: 'Ingen grense',
      linked: 'Koblet til {repo} på {integration}.',
    },
    picker: {
      label: 'Bla gjennom repoer',
      integration: 'Tilkobling',
      search: 'Søk i repoer…',
      cloneWith: 'Klon med',
      empty: '// fant ingen repoer',
      private: 'privat',
      added: 'lagt til',
    },
    project: 'Repoer',
    projectHint: 'Der agenter jobber med prosjektets saker.',
    teamDefault: 'Standardrepo',
    teamDefaultHint: 'For agenter som jobber med saker som ikke ligger i et prosjekt med repoer.',
    none: 'Ingen',
    manage: 'Administrer repoer',
  },
} satisfies Translation<Catalog['agents']>;
