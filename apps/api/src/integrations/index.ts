import { forgejo } from './forgejo.ts';
import { github } from './github.ts';
import { gitlab } from './gitlab.ts';
import { registerProvider } from './registry.ts';

/** Every integration that ships with Ordo. */
export function registerBuiltinProviders() {
  for (const provider of [github, gitlab, forgejo]) registerProvider(provider);
}
