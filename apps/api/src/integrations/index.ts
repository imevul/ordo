import { discordProvider } from './discord.ts';
import { forgejo } from './forgejo.ts';
import { github } from './github.ts';
import { gitlab } from './gitlab.ts';
import { matrixProvider } from './matrix.ts';
import { registerProvider } from './registry.ts';
import { slackProvider } from './slack.ts';
import { telegramProvider } from './telegram.ts';

/** Every integration that ships with Ordo. */
export function registerBuiltinProviders() {
  for (const provider of [
    github,
    gitlab,
    forgejo,
    slackProvider,
    discordProvider,
    matrixProvider,
    telegramProvider,
  ])
    registerProvider(provider);
}
