import type { IntegrationProvider } from './types.ts';

const providers = new Map<string, IntegrationProvider>();

export function registerProvider(provider: IntegrationProvider) {
  providers.set(provider.key, provider);
}

/** Tests register fakes and remove them again. */
export function unregisterProvider(key: string) {
  providers.delete(key);
}

export const getProvider = (key: string) => providers.get(key);
export const listProviders = () => [...providers.values()];
