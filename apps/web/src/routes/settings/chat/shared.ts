import { t } from '../../../i18n/index.ts';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  /** A yes/no setting; new connections start with it on. */
  checkbox?: boolean;
  placeholder?: string;
  hint?: string;
  /** Only for these delivery modes. */
  for?: string[];
}

interface ChatForm {
  docs: string;
  /** What a channel id looks like here. */
  channelHint: string;
  deliveries: { key: string; label: string; hint: string }[];
  fields: Field[];
}

/**
 * What each chat service needs. See docs/integrations for the matching app setup. A function:
 * labels follow the language.
 */
export const chatForms = (): Record<string, ChatForm> => ({
  slack: {
    docs: t('integrations.chat.slack.docs'),
    channelHint: t('integrations.chat.slack.channelHint'),
    deliveries: [
      {
        key: 'events',
        label: t('integrations.chat.slack.events'),
        hint: t('integrations.chat.slack.eventsHint'),
      },
      {
        key: 'socket',
        label: t('integrations.chat.slack.socket'),
        hint: t('integrations.chat.slack.socketHint'),
      },
    ],
    fields: [
      {
        key: 'botToken',
        label: t('integrations.chat.botToken'),
        secret: true,
        placeholder: 'xoxb-…',
      },
      {
        key: 'signingSecret',
        label: t('integrations.chat.slack.signingSecret'),
        secret: true,
        for: ['events'],
      },
      {
        key: 'appToken',
        label: t('integrations.chat.slack.appToken'),
        secret: true,
        placeholder: 'xapp-…',
        hint: t('integrations.chat.slack.appTokenHint'),
        for: ['socket'],
      },
    ],
  },
  discord: {
    docs: t('integrations.chat.discord.docs'),
    channelHint: t('integrations.chat.discord.channelHint'),
    deliveries: [
      {
        key: 'interactions',
        label: t('integrations.chat.discord.interactions'),
        hint: t('integrations.chat.discord.interactionsHint'),
      },
      {
        key: 'gateway',
        label: t('integrations.chat.discord.gateway'),
        hint: t('integrations.chat.discord.gatewayHint'),
      },
    ],
    fields: [
      {
        key: 'applicationId',
        label: t('integrations.chat.discord.applicationId'),
        placeholder: '1234567890',
      },
      { key: 'botToken', label: t('integrations.chat.botToken'), secret: true },
      {
        key: 'publicKey',
        label: t('integrations.chat.discord.publicKey'),
        secret: true,
        hint: t('integrations.chat.discord.publicKeyHint'),
        for: ['interactions'],
      },
    ],
  },
  matrix: {
    docs: t('integrations.chat.matrix.docs'),
    channelHint: t('integrations.chat.matrix.channelHint'),
    deliveries: [],
    fields: [
      {
        key: 'homeserverUrl',
        label: t('integrations.chat.matrix.homeserverUrl'),
        placeholder: 'https://matrix.example.org',
      },
      { key: 'accessToken', label: t('integrations.chat.accessToken'), secret: true },
      {
        key: 'encryption',
        label: t('integrations.chat.matrix.encryption'),
        hint: t('integrations.chat.matrix.encryptionHint'),
        checkbox: true,
      },
    ],
  },
  telegram: {
    docs: t('integrations.chat.telegram.docs'),
    channelHint: t('integrations.chat.telegram.channelHint'),
    deliveries: [
      {
        key: 'webhook',
        label: t('integrations.chat.telegram.webhook'),
        hint: t('integrations.chat.telegram.webhookHint'),
      },
      {
        key: 'longpoll',
        label: t('integrations.chat.telegram.longpoll'),
        hint: t('integrations.chat.telegram.longpollHint'),
      },
    ],
    fields: [
      {
        key: 'botToken',
        label: t('integrations.chat.botToken'),
        secret: true,
        placeholder: '123456:ABC…',
      },
    ],
  },
});
