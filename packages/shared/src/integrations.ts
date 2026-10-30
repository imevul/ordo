import { z } from 'zod';
import { chatChannelsSchema } from './schemas.ts';
import type { ChatChannel } from './types.ts';

/**
 * What admins enter when connecting an integration by hand, per provider: one schema over
 * `{ config, secrets }`, because some fields depend on others (the delivery decides which secrets
 * are needed). The API parses with these and stores the output; the web forms can check with them.
 *
 * Forms send strings ("" for an empty field, lists as lines), and an update merges the new fields
 * into the stored ones, so the schemas take what's stored back as input and drop keys they don't
 * know. Errors carry the field's path (`secrets.token`, `config.repos.1`).
 */

/** Empty form fields mean "not given". */
const blank = (v: unknown) => (v === '' || v === null ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

/** A required secret: a pasted token, trimmed. */
const token = (message: string) =>
  z.preprocess(blank, z.string({ error: message }).trim().min(1, message));
const optionalToken = optional(z.string().trim());

/** A server address, as the URL parser writes it and without trailing slashes. */
const serverUrl = (message: string) =>
  z
    .string({ error: message })
    .trim()
    .pipe(z.url({ protocol: /^https?$/, normalize: true, error: message }))
    .transform((v) => v.replace(/\/+$/, ''));

const choice = <const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess(blank, z.enum(values).default(fallback));
const flag = (fallback: boolean) => z.preprocess(blank, z.boolean().default(fallback));

/** "owner/name" lines or commas (or a list) → a clean list without duplicates. */
const nameList = (item: z.ZodType<string>) =>
  z.preprocess((value) => {
    const raw = Array.isArray(value) ? value.join('\n') : String(value ?? '');
    return [
      ...new Set(
        raw
          .split(/[\s,]+/)
          .map((r) => r.trim().replace(/^\/+|\/+$/g, ''))
          .filter(Boolean),
      ),
    ];
  }, z.array(item).max(500));
const repoName = z.string().regex(/^[\w.-]+\/[\w.-]+$/, {
  error: (iss) => `"${String(iss.input)}" isn't a repository name (owner/name)`,
});

/** A chat integration's channel feeds; each channel once. */
const channels = z.preprocess(
  blank,
  chatChannelsSchema.default([]).transform((list): ChatChannel[] => {
    const seen = new Set<string>();
    return list.filter((c) => !seen.has(c.id) && seen.add(c.id));
  }),
);

/** Secrets without the ones left out. */
const compact = (secrets: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) as Record<string, string>;

const need = (ctx: z.RefinementCtx, path: (string | number)[], message: string) =>
  ctx.addIssue({ code: 'custom', path, message });

const forgeDelivery = choice(['webhook', 'poll'], 'webhook');

// ─── forges ───────────────────────────────────────────────────────────────

export const GITHUB_API_URL = 'https://api.github.com';
export const GITHUB_WEB_URL = 'https://github.com';

/** `app`: installed through the instance's GitHub App; `token`: a personal access token. */
export type GithubConfig =
  | { mode: 'app'; apiUrl?: string; webUrl?: string; commentOnPullRequests: boolean }
  | {
      mode: 'token';
      apiUrl: string;
      webUrl: string;
      repos: string[];
      delivery: 'webhook' | 'poll';
      commentOnPullRequests: boolean;
    };

export const githubSettingsSchema = z
  .object({
    config: z.object({
      mode: choice(['token', 'app'], 'token'),
      apiUrl: optional(serverUrl('The API URL is not valid, e.g. https://api.github.com')),
      webUrl: optional(serverUrl('The web URL is not valid, e.g. https://github.com')),
      repos: nameList(repoName),
      delivery: forgeDelivery,
      commentOnPullRequests: flag(false),
    }),
    secrets: z.object({ token: optionalToken, webhookSecret: optionalToken }),
  })
  .superRefine(({ config, secrets }, ctx) => {
    // Installed through the GitHub App: only the preferences are editable.
    if (config.mode === 'app') return;
    if (!secrets.token) need(ctx, ['secrets', 'token'], 'A personal access token is required');
    if (!config.repos.length)
      need(ctx, ['config', 'repos'], 'List at least one repository (owner/name)');
  })
  .transform(({ config, secrets }): { config: GithubConfig; secrets: Record<string, string> } =>
    config.mode === 'app'
      ? {
          config: {
            mode: 'app',
            apiUrl: config.apiUrl,
            webUrl: config.webUrl,
            commentOnPullRequests: config.commentOnPullRequests,
          },
          secrets: {},
        }
      : {
          config: {
            mode: 'token',
            apiUrl: config.apiUrl ?? GITHUB_API_URL,
            webUrl: config.webUrl ?? GITHUB_WEB_URL,
            repos: config.repos,
            delivery: config.delivery,
            commentOnPullRequests: config.commentOnPullRequests,
          },
          secrets: compact(secrets),
        },
  );

export type GitlabConfig = {
  baseUrl: string;
  projects: string[];
  delivery: 'webhook' | 'poll';
  commentOnPullRequests: boolean;
};

export const gitlabSettingsSchema = z
  .object({
    config: z.object({
      baseUrl: z.preprocess(
        blank,
        serverUrl('The GitLab URL is not valid, e.g. https://gitlab.com').default(
          'https://gitlab.com',
        ),
      ),
      projects: nameList(z.string()).refine(
        (list) => list.length > 0,
        'List at least one project (group/project)',
      ),
      delivery: forgeDelivery,
      commentOnPullRequests: flag(false),
    }),
    secrets: z.object({
      token: token('An access token with the "api" scope is required'),
      webhookSecret: optionalToken,
    }),
  })
  .transform(({ config, secrets }) => ({
    config: config satisfies GitlabConfig,
    secrets: compact(secrets),
  }));

export type ForgejoConfig = {
  baseUrl: string;
  repos: string[];
  delivery: 'webhook' | 'poll';
  commentOnPullRequests: boolean;
};

export const forgejoSettingsSchema = z
  .object({
    config: z.object({
      baseUrl: serverUrl('The server URL is required, e.g. https://codeberg.org'),
      repos: nameList(repoName).refine(
        (list) => list.length > 0,
        'List at least one repository (owner/name)',
      ),
      delivery: forgeDelivery,
      commentOnPullRequests: flag(false),
    }),
    secrets: z.object({
      token: token('An access token is required'),
      webhookSecret: optionalToken,
    }),
  })
  .transform(({ config, secrets }) => ({
    config: config satisfies ForgejoConfig,
    secrets: compact(secrets),
  }));

// ─── chat ─────────────────────────────────────────────────────────────────

export type SlackConfig = {
  /** `app`: added with "Add to Slack" through the instance's Slack app. */
  mode?: 'app';
  delivery: 'events' | 'socket';
  channels: ChatChannel[];
  /** The Slack workspace's name (app mode), for people. */
  team?: string;
};

export const slackSettingsSchema = z
  .object({
    config: z.object({
      mode: optional(z.enum(['token', 'app'])),
      delivery: choice(['events', 'socket'], 'events'),
      channels,
      team: optional(z.string().trim().max(200)),
    }),
    secrets: z.object({
      botToken: token('The bot token starts with xoxb-').refine(
        (v) => v.startsWith('xoxb-'),
        'The bot token starts with xoxb-',
      ),
      signingSecret: optionalToken,
      appToken: optionalToken,
    }),
  })
  .superRefine(({ config, secrets }, ctx) => {
    // Installed with "Add to Slack": the delivery and its secrets come from the app.
    if (config.mode === 'app') return;
    if (config.delivery === 'events' && !secrets.signingSecret)
      need(ctx, ['secrets', 'signingSecret'], 'The signing secret is required for the Events API');
    if (config.delivery === 'socket' && !secrets.appToken?.startsWith('xapp-'))
      need(
        ctx,
        ['secrets', 'appToken'],
        'Socket Mode needs an app-level token (xapp-…) with connections:write',
      );
  })
  .transform(({ config, secrets }): { config: SlackConfig; secrets: Record<string, string> } =>
    config.mode === 'app'
      ? {
          config: {
            mode: 'app',
            delivery: config.delivery,
            channels: config.channels,
            ...(config.team && { team: config.team }),
          },
          secrets: { botToken: secrets.botToken },
        }
      : {
          config: { delivery: config.delivery, channels: config.channels },
          secrets: compact(secrets),
        },
  );

export type DiscordConfig = {
  delivery: 'interactions' | 'gateway';
  applicationId: string;
  channels: ChatChannel[];
};

export const discordSettingsSchema = z
  .object({
    config: z.object({
      delivery: choice(['interactions', 'gateway'], 'interactions'),
      applicationId: z
        .string({ error: 'The application id is a number' })
        .trim()
        .regex(/^\d{5,25}$/, 'The application id is a number'),
      channels,
    }),
    secrets: z.object({
      botToken: token('The bot token is required'),
      publicKey: optional(
        z
          .string()
          .trim()
          .regex(/^[0-9a-f]{64}$/i, 'The public key is 64 hex characters')
          .transform((v) => v.toLowerCase()),
      ),
    }),
  })
  .superRefine(({ config, secrets }, ctx) => {
    if (config.delivery === 'interactions' && !secrets.publicKey)
      need(
        ctx,
        ['secrets', 'publicKey'],
        'The public key (64 hex characters) is required for the interactions endpoint',
      );
  })
  .transform(({ config, secrets }) => ({
    config: config satisfies DiscordConfig,
    secrets: compact(secrets),
  }));

export type MatrixConfig = {
  homeserverUrl: string;
  /** The token's device takes part in end-to-end encrypted rooms. */
  encryption: boolean;
  channels: ChatChannel[];
};

export const matrixSettingsSchema = z
  .object({
    config: z.object({
      homeserverUrl: serverUrl('The homeserver URL is not valid, e.g. https://matrix.example.org'),
      encryption: flag(false),
      channels,
    }),
    secrets: z.object({ accessToken: token("The bot account's access token is required") }),
  })
  .transform(({ config, secrets }) => ({
    config: config satisfies MatrixConfig,
    secrets: compact(secrets),
  }));

export type TelegramConfig = {
  delivery: 'webhook' | 'longpoll';
  channels: ChatChannel[];
};

export const telegramSettingsSchema = z
  .object({
    config: z.object({ delivery: choice(['webhook', 'longpoll'], 'webhook'), channels }),
    secrets: z.object({
      botToken: token('The bot token looks like 123456:ABC… (from @BotFather)').refine(
        (v) => /^\d+:[\w-]{20,}$/.test(v),
        'The bot token looks like 123456:ABC… (from @BotFather)',
      ),
      webhookSecret: optionalToken,
    }),
  })
  .transform(({ config, secrets }) => ({
    config: config satisfies TelegramConfig,
    secrets: compact(secrets),
  }));

// ─── trackers and mail ────────────────────────────────────────────────────

export const JIRA_MODES = ['links', 'mirror', 'sync'] as const;
export type JiraMode = (typeof JIRA_MODES)[number];

export interface JiraProjectMap {
  key: string;
  teamId: string | null;
  /** Issue type for issues Ordo creates in Jira. */
  issueType: string;
  /** New Jira issues appear in Ordo (mirror and sync). */
  createInOrdo: boolean;
  /** New Ordo issues in the team are created in Jira (sync). */
  createInJira: boolean;
}

export type JiraConfig = {
  siteUrl: string;
  /** Cloud signs in with an email and API token, Data Center with a personal access token. */
  cloud: boolean;
  mode: JiraMode;
  delivery: 'webhook' | 'poll';
  projects: JiraProjectMap[];
  backlinks: boolean;
};

const jiraProject = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .refine((key) => !key || /^[A-Z][A-Z0-9_]{0,19}$/.test(key), {
      error: (iss) => `${String(iss.input).trim().toUpperCase()} isn't a Jira project key`,
    })
    .default(''),
  teamId: z.preprocess(blank, z.uuid('Choose an Ordo team').nullish()),
  issueType: z.preprocess(blank, z.string().trim().optional()),
  createInOrdo: z.boolean().optional(),
  createInJira: z.boolean().optional(),
});

export const jiraSettingsSchema = z
  .object({
    config: z.object({
      siteUrl: serverUrl('The Jira URL is not valid, e.g. https://acme.atlassian.net'),
      mode: choice(JIRA_MODES, 'links'),
      delivery: forgeDelivery,
      projects: z.preprocess(blank, z.array(jiraProject).max(50).default([])),
      backlinks: flag(true),
    }),
    secrets: z.object({
      token: token('An API token (Cloud) or personal access token is required'),
      email: optionalToken,
      webhookSecret: optionalToken,
    }),
  })
  .superRefine(({ config }, ctx) => {
    if (config.mode === 'links') return;
    config.projects.forEach((p, i) => {
      if (p.key && !p.teamId)
        need(ctx, ['config', 'projects', i, 'teamId'], `Choose an Ordo team for ${p.key}`);
    });
    if (!config.projects.some((p) => p.key))
      need(ctx, ['config', 'projects'], 'Map at least one Jira project to a team');
  })
  .transform(({ config, secrets }): { config: JiraConfig; secrets: Record<string, string> } => {
    const { mode } = config;
    const projects: JiraProjectMap[] = [];
    for (const p of config.projects) {
      if (!p.key || projects.some((o) => o.key === p.key)) continue;
      projects.push({
        key: p.key,
        teamId: p.teamId ?? null,
        issueType: p.issueType?.slice(0, 60) || 'Task',
        createInOrdo: mode !== 'links' && p.createInOrdo !== false,
        createInJira: mode === 'sync' && p.createInJira === true,
      });
    }
    return {
      config: {
        siteUrl: config.siteUrl,
        cloud: !!secrets.email,
        mode,
        delivery: config.delivery,
        projects,
        backlinks: config.backlinks,
      },
      secrets: compact(secrets),
    };
  });

export type EmailConfig = {
  delivery: 'imap' | 'webhook';
  teamId: string;
  /** The address people write to; shown in Ordo only. */
  address?: string;
  /** IMAP only, like the rest. */
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  mailbox?: string;
};

export const emailSettingsSchema = z
  .object({
    config: z.object({
      delivery: choice(['imap', 'webhook'], 'webhook'),
      teamId: z.uuid('Pick the team that receives the issues'),
      address: optional(z.string().trim().max(320)),
      host: optional(
        z
          .string()
          .trim()
          .regex(/^[a-z0-9.-]+$/i, 'Enter the IMAP server, e.g. imap.example.com'),
      ),
      port: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(993)),
      secure: flag(true),
      username: optional(z.string().trim()),
      mailbox: optional(z.string().trim()),
    }),
    secrets: z.object({ password: optional(z.string()) }),
  })
  .superRefine(({ config, secrets }, ctx) => {
    if (config.delivery !== 'imap') return;
    if (!config.host) need(ctx, ['config', 'host'], 'Enter the IMAP server, e.g. imap.example.com');
    if (!config.username) need(ctx, ['config', 'username'], 'Enter the mailbox user name');
    if (!secrets.password) need(ctx, ['secrets', 'password'], 'Enter the mailbox password');
  })
  .transform(({ config, secrets }): { config: EmailConfig; secrets: Record<string, string> } => {
    const base = { delivery: config.delivery, teamId: config.teamId, address: config.address };
    if (config.delivery !== 'imap') return { config: base, secrets: {} };
    return {
      config: {
        ...base,
        host: config.host,
        port: config.port,
        secure: config.secure,
        username: config.username,
        mailbox: config.mailbox || 'INBOX',
      },
      secrets: compact({ password: secrets.password }),
    };
  });

/** Every provider that admins connect by hand, by key. */
export const INTEGRATION_SETTINGS_SCHEMAS = {
  github: githubSettingsSchema,
  gitlab: gitlabSettingsSchema,
  forgejo: forgejoSettingsSchema,
  slack: slackSettingsSchema,
  discord: discordSettingsSchema,
  matrix: matrixSettingsSchema,
  telegram: telegramSettingsSchema,
  jira: jiraSettingsSchema,
  email: emailSettingsSchema,
} as const;
