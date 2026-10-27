import type { Catalog, Translation } from '../index.ts';

export default {
  appearance: {
    title: 'Utseende',
    description: 'Sparas i den här webbläsaren. System följer enhetens ljusa eller mörka läge.',
    theme: 'Tema',
    system: 'System',
    light: 'Ljust',
    dark: 'Mörkt',
  },
  language: {
    title: 'Språk',
    description: 'För appen, e-post och notiser. Det som inte är översatt än visas på engelska.',
  },
} satisfies Translation<Catalog['settings']>;
