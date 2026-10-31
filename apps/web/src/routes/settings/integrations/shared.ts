import { type MessageKey, t } from '../../../i18n/index.ts';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

/** A provider's name or description in the current language; the server's English for providers not translated. */
export function providerText(group: 'providers' | 'providerNames', key: string, fallback: string) {
  const id = `integrations.${group}.${key}` as MessageKey;
  const text = t(id);
  return text === id ? fallback : text;
}
