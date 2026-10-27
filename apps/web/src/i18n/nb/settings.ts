import type { Catalog, Translation } from '../index.ts';

export default {
  appearance: {
    title: 'Utseende',
    description: 'Lagres i denne nettleseren. System følger enhetens lyse eller mørke modus.',
    theme: 'Tema',
    system: 'System',
    light: 'Lyst',
    dark: 'Mørkt',
  },
  language: {
    title: 'Språk',
    description: 'For appen, e-post og varsler. Det som ikke er oversatt ennå, vises på engelsk.',
  },
} satisfies Translation<Catalog['settings']>;
