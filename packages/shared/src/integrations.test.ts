import { describe, expect, it } from 'vitest';
import {
  emailSettingsSchema,
  githubSettingsSchema,
  gitlabSettingsSchema,
  jiraSettingsSchema,
  slackSettingsSchema,
} from './integrations.ts';

const TEAM = '00000000-0000-4000-8000-000000000001';

describe('integration settings schemas', () => {
  it('fills in defaults for what forms leave empty', () => {
    expect(
      gitlabSettingsSchema.parse({
        config: { baseUrl: '', projects: 'acme/app', delivery: '' },
        secrets: { token: ' glpat-x ', webhookSecret: '' },
      }),
    ).toEqual({
      config: {
        baseUrl: 'https://gitlab.com',
        projects: ['acme/app'],
        delivery: 'webhook',
        commentOnPullRequests: false,
      },
      secrets: { token: 'glpat-x' },
    });
  });

  it('keeps an app installation to its preferences', () => {
    const app = {
      mode: 'app',
      apiUrl: 'https://api.github.com',
      webUrl: 'https://github.com',
      commentOnPullRequests: true,
    };
    expect(githubSettingsSchema.parse({ config: app, secrets: {} })).toEqual({
      config: app,
      secrets: {},
    });
  });

  it('accepts its own output, so stored settings merge with updates', () => {
    const once = slackSettingsSchema.parse({
      config: { delivery: 'events', channels: [{ id: 'C1' }, { id: 'C1' }] },
      secrets: { botToken: 'xoxb-1', signingSecret: 's' },
    });
    expect(once.config.channels).toEqual([{ id: 'C1', teamIds: [], events: [] }]);
    expect(slackSettingsSchema.parse(once)).toEqual(once);

    const jira = jiraSettingsSchema.parse({
      config: {
        siteUrl: 'https://acme.atlassian.net/',
        mode: 'sync',
        projects: [{ key: ' abc ', teamId: TEAM, createInJira: true }, { key: '' }],
      },
      secrets: { token: 't', email: 'me@acme.test' },
    });
    expect(jira.config).toMatchObject({
      siteUrl: 'https://acme.atlassian.net',
      cloud: true,
      projects: [
        { key: 'ABC', teamId: TEAM, issueType: 'Task', createInOrdo: true, createInJira: true },
      ],
    });
    expect(jiraSettingsSchema.parse({ config: jira.config, secrets: jira.secrets })).toEqual(jira);
  });

  it('drops IMAP settings when mail arrives by webhook', () => {
    expect(
      emailSettingsSchema.parse({
        config: { delivery: 'webhook', teamId: TEAM, host: 'imap.example.com', port: '143' },
        secrets: { password: 'p' },
      }),
    ).toEqual({ config: { delivery: 'webhook', teamId: TEAM }, secrets: {} });
    expect(
      emailSettingsSchema.parse({
        config: { delivery: 'imap', teamId: TEAM, host: 'imap.example.com', username: 'u' },
        secrets: { password: 'p' },
      }).config,
    ).toMatchObject({ port: 993, secure: true, mailbox: 'INBOX' });
  });
});
