import {
  type ChatChannel,
  type ChatEventKind,
  type ChatService,
  chatChannelsSchema,
  DEFAULT_ACCENT,
  type UserPreferences,
} from '@ordo/shared';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  chatMessages,
  comments,
  externalAccounts,
  integrations,
  issues,
  notifications,
  teamMembers,
  teams,
  users,
  workflowStates,
  workspaceMembers,
  workspaces,
} from '../db/schema.ts';
import { localeOf, type ServerT, serverT } from '../i18n/index.ts';
import { getProvider } from '../integrations/registry.ts';
import type {
  ChatMessage,
  IntegrationContext,
  IntegrationEvent,
  IntegrationRow,
} from '../integrations/types.ts';
import { enqueue, type JobContext } from '../lib/jobs/index.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { type Access, canReadTeam, computeAccess, usersWithTeamAccess } from './access.ts';
import { audit } from './audit.ts';
import { createComment } from './comments.ts';
import { activeIntegration, integrationContext, track } from './integrations.ts';
import { createIssue } from './issues.ts';
import { upsertIssueLink } from './links.ts';
import { consumeToken, createToken } from './tokens.ts';

/**
 * What Slack, Discord, Matrix and Telegram have in common. Providers turn their payloads into a
 * `ChatIncoming` and render `ChatMessage`s; everything else lives here:
 *
 * - Channel feeds: admins subscribe channels to teams and kinds of activity (`config.channels`).
 * - Accounts: people prove a chat account is theirs by sending a one-time code from it. Only
 *   proven accounts get private notifications or act as their Ordo user.
 * - Commands: `link CODE`, `unlink`, `new [TEAM] title` (replying to a message files it), `help`.
 * - Unfurls: links to issues get a preview, but only for posters who can read the issue.
 */

// ─── configuration ────────────────────────────────────────────────────────

/** Validates `config.channels` in a provider's `configure`. */
export function parseChannels(value: unknown): ChatChannel[] {
  if (value == null || value === '') return [];
  const parsed = chatChannelsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Channels: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  const seen = new Set<string>();
  return parsed.data.filter((c) => !seen.has(c.id) && seen.add(c.id));
}

export const channelsOf = (row: IntegrationRow) =>
  ((row.config.channels as ChatChannel[] | undefined) ?? []).filter((c) => c.id);

/** Threads are on unless a channel turns them off. */
const threadsOn = (c: ChatChannel | undefined) => !!c && c.threads !== false;

// ─── issues as chat cards ─────────────────────────────────────────────────

const STATE_COLORS: Record<string, string> = {
  triage: '#a78bfa',
  backlog: '#6b7280',
  unstarted: '#9ca3af',
  started: '#f59e0b',
  completed: '#22c55e',
  canceled: '#6b7280',
};

const excerpt = (text: string | null | undefined, max = 280) => {
  const flat = (text ?? '').replace(/\r/g, '').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

interface IssueCard {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamId: string;
  teamPrivate: boolean;
  state: string;
  stateType: string;
  priority: number;
  assignee: string | null;
  deleted: boolean;
  /** The workspace's accent, for cards without a status colour. */
  accent: string;
}

async function workspaceAccent(app: FastifyInstance, workspaceId: string) {
  const [ws] = await app.db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return ws?.settings.accentColor ?? DEFAULT_ACCENT;
}

export async function issueCards(app: FastifyInstance, ids: string[]) {
  if (!ids.length) return new Map<string, IssueCard>();
  const rows = await app.db
    .select({
      id: issues.id,
      number: issues.number,
      title: issues.title,
      description: issues.description,
      priority: issues.priority,
      deletedAt: issues.deletedAt,
      teamId: issues.teamId,
      key: teams.key,
      teamPrivate: teams.private,
      slug: workspaces.slug,
      settings: workspaces.settings,
      state: workflowStates.name,
      stateType: workflowStates.type,
      assignee: users.name,
    })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(workspaces, eq(workspaces.id, issues.workspaceId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .leftJoin(users, eq(users.id, issues.assigneeId))
    .where(inArray(issues.id, ids));
  return new Map(
    rows.map((r) => {
      const identifier = `${r.key}-${r.number}`;
      return [
        r.id,
        {
          id: r.id,
          identifier,
          title: r.title,
          description: r.description,
          url: `${app.env.publicUrl}/${r.slug}/issue/${identifier}`,
          teamId: r.teamId,
          teamPrivate: r.teamPrivate,
          state: r.state,
          stateType: r.stateType,
          priority: r.priority,
          assignee: r.assignee,
          deleted: !!r.deletedAt,
          accent: r.settings.accentColor ?? DEFAULT_ACCENT,
        },
      ];
    }),
  );
}

// Channel posts have no single reader, so they're in English; direct messages use the reader's language.
const cardContext = (c: IssueCard, t: ServerT) =>
  [
    c.state,
    c.priority >= 1 && c.priority <= 4
      ? t(`chat.priority.${String(c.priority) as '1' | '2' | '3' | '4'}`)
      : null,
    c.assignee ?? t('chat.unassigned'),
  ]
    .filter(Boolean)
    .join(' · ');

/** An issue as a chat message: the headline says what happened to it. */
export const issueMessage = (
  c: IssueCard,
  headline: string,
  body?: string,
  t: ServerT = serverT('en'),
): ChatMessage => ({
  headline,
  title: `${c.identifier} ${c.title}`,
  url: c.url,
  body: body || undefined,
  context: cardContext(c, t),
  color: STATE_COLORS[c.stateType] ?? c.accent,
});

// ─── channel feeds ────────────────────────────────────────────────────────

function kindsOf(event: IntegrationEvent, stateType?: string): ChatEventKind[] {
  switch (event.type) {
    case 'issue.created':
      return ['issue.created'];
    case 'issue.updated':
      if (!event.changes?.some((c) => c.field === 'state')) return [];
      return stateType === 'completed' ? ['issue.status', 'issue.completed'] : ['issue.status'];
    case 'comment.created':
      return ['comment.created'];
    case 'project_update.created':
      return ['project_update.created'];
    default:
      return [];
  }
}

const HEALTH: Record<string, string> = {
  on_track: 'on track',
  at_risk: 'at risk',
  off_track: 'off track',
};

/** The feed post for a domain event, plus the teams it belongs to; null if it isn't postable. */
async function feedMessage(app: FastifyInstance, event: IntegrationEvent) {
  const actor = event.actor?.name ?? 'Someone';
  const data = event.data as {
    id?: string;
    issue?: { id: string };
    comment?: { id?: string; body?: string };
    update?: { body?: string; health?: string };
    project?: { id: string; name?: string };
  };
  if (event.type === 'project_update.created') {
    const projectTeams = event.teamIds.length
      ? await app.db
          .select({ private: teams.private })
          .from(teams)
          .where(inArray(teams.id, event.teamIds))
      : [];
    const health = HEALTH[data.update?.health ?? ''];
    return {
      kinds: kindsOf(event),
      teamIds: event.teamIds,
      allPrivate: projectTeams.length > 0 && projectTeams.every((t) => t.private),
      message: {
        headline: `${actor} posted a project update${health ? ` (${health})` : ''}`,
        title: data.project?.name ?? 'Project',
        url: `${app.env.publicUrl}/${event.workspace.slug}/project/${data.project?.id}`,
        body: excerpt(data.update?.body, 500) || undefined,
        color: await workspaceAccent(app, event.workspace.id),
      } satisfies ChatMessage,
    };
  }
  const issueId = event.type === 'comment.created' ? data.issue?.id : data.id;
  if (!issueId) return null;
  const card = (await issueCards(app, [issueId])).get(issueId);
  if (!card || card.deleted) return null;
  const kinds = kindsOf(event, card.stateType);
  if (!kinds.length) return null;
  const message =
    event.type === 'issue.created'
      ? issueMessage(card, `${actor} created ${card.identifier}`, excerpt(card.description, 200))
      : event.type === 'comment.created'
        ? issueMessage(
            card,
            `${actor} commented on ${card.identifier}`,
            excerpt(data.comment?.body),
          )
        : issueMessage(card, `${actor} moved ${card.identifier} to ${card.state}`);
  // Inside the issue's thread the card is already above: just what happened.
  const thread: ChatMessage =
    event.type === 'comment.created'
      ? { headline: `${actor} commented`, body: excerpt(data.comment?.body, 2000), url: card.url }
      : { headline: message.headline, url: card.url };
  return {
    kinds,
    teamIds: [card.teamId],
    allPrivate: card.teamPrivate,
    message,
    issueId: card.id,
    commentId: event.type === 'comment.created' ? (data.comment?.id ?? null) : null,
    thread,
  };
}

/** Domain events → one post job per subscribed channel (so a failing channel retries alone). */
export async function chatFeed(ictx: IntegrationContext, event: IntegrationEvent) {
  const channels = channelsOf(ictx.integration).filter((c) => c.events.length);
  if (!channels.length) return;
  const feed = await feedMessage(ictx.app, event);
  if (!feed) return;
  for (const channel of channels) {
    const subscribed = channel.events.some((k) => feed.kinds.includes(k));
    // Comments on an issue with a thread here always go to it: that's the sync.
    const threaded =
      'issueId' in feed && threadsOn(channel) && feed.kinds.includes('comment.created');
    if (!subscribed && !threaded) continue;
    const allowed = channel.teamIds.length
      ? feed.teamIds.some((t) => channel.teamIds.includes(t))
      : // "Every public team": nothing from private teams unless a channel names them.
        !feed.allPrivate;
    if (!allowed) continue;
    await enqueue(
      ictx.app.db,
      'chat.post',
      {
        integrationId: ictx.integration.id,
        channel: channel.id,
        message: feed.message,
        subscribed,
        ...('issueId' in feed && {
          issueId: feed.issueId,
          commentId: feed.commentId,
          thread: feed.thread,
        }),
      } satisfies ChatPost,
      {
        dedupeKey: `cp:${ictx.integration.id}:${event.id}:${channel.id}`,
        orderingKey: `chat:${ictx.integration.id}:${channel.id}`,
      },
    );
  }
}

interface ChatPost {
  integrationId: string;
  channel: string;
  message: ChatMessage;
  /** False when the channel only gets this because the issue has a thread there. */
  subscribed?: boolean;
  issueId?: string;
  commentId?: string | null;
  /** The same, as a reply in the issue's thread. */
  thread?: ChatMessage;
}

/**
 * Posts one feed message. With threads on, the first post about an issue in a channel starts its
 * thread, and later ones go into it; every post is remembered so replies find their issue.
 */
export async function runChatPost(app: FastifyInstance, p: ChatPost, job: JobContext) {
  const found = await activeIntegration(app, p.integrationId);
  if (!found?.provider.chat) return;
  const chat = found.provider.chat;
  const ictx = integrationContext(app, found.row, job.log);
  const channel = channelsOf(found.row).find((c) => c.id === p.channel);
  const remember = async (messageRef: string | undefined, root: boolean) => {
    if (!messageRef || !p.issueId) return;
    await app.db
      .insert(chatMessages)
      .values({
        integrationId: found.row.id,
        channel: p.channel,
        messageRef,
        issueId: p.issueId,
        commentId: p.commentId ?? null,
        root,
      })
      .onConflictDoNothing();
  };
  await track(app, found.row, async () => {
    const [root] =
      p.issueId && threadsOn(channel)
        ? await app.db
            .select({ messageRef: chatMessages.messageRef })
            .from(chatMessages)
            .where(
              and(
                eq(chatMessages.integrationId, found.row.id),
                eq(chatMessages.channel, p.channel),
                eq(chatMessages.issueId, p.issueId),
                eq(chatMessages.root, true),
              ),
            )
            .limit(1)
        : [];
    if (root) {
      const name = (p.message.title ?? p.message.headline).slice(0, 100);
      const ref = await chat.post(ictx, p.channel, p.thread ?? p.message, {
        root: root.messageRef,
        name,
      });
      await remember(ref, false);
      return;
    }
    if (p.subscribed === false) return;
    await remember(await chat.post(ictx, p.channel, p.message), true);
  });
}

// ─── thread replies ───────────────────────────────────────────────────────

/** A reply in a chat thread, as providers hand it over. */
export interface ChatThreadReply {
  /** Channel, room or chat id; omitted where the service's message ids are unique on their own. */
  channel?: string;
  /** What it replies to: the thread's first message, or (Telegram) any message in the chain. */
  parent: string;
  /** The reply itself. */
  messageRef: string;
  user: { id: string; name?: string };
  /** Looks up a display name, for replies by people without a linked account. */
  displayName?: () => Promise<string | undefined>;
  /** Markdown. */
  text: string;
}

/**
 * Turns a reply in an issue's thread into a comment, by the person's linked Ordo account (if it
 * can see the issue) or by the integration's bot, naming who wrote it. Returns false when the
 * reply isn't in a thread Ordo knows, so providers can treat it as an ordinary message.
 */
export async function syncThreadReply(ictx: IntegrationContext, reply: ChatThreadReply) {
  const { app, integration } = ictx;
  const [parent] = await app.db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.integrationId, integration.id),
        eq(chatMessages.messageRef, reply.parent),
        reply.channel ? eq(chatMessages.channel, reply.channel) : undefined,
      ),
    )
    .limit(1);
  if (!parent) return false;
  if (!threadsOn(channelsOf(integration).find((c) => c.id === parent.channel))) return false;
  const [seen] = await app.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.integrationId, integration.id),
        eq(chatMessages.channel, parent.channel),
        eq(chatMessages.messageRef, reply.messageRef),
      ),
    );
  const text = reply.text.trim();
  if (seen || !text) return true;
  const [issue] = await app.db
    .select({ teamId: issues.teamId, deletedAt: issues.deletedAt })
    .from(issues)
    .where(eq(issues.id, parent.issueId));
  if (!issue || issue.deletedAt) return true;

  const actor = await chatActor(ictx, reply.user.id);
  // A linked account acts as its person, who may have lost access to the issue since.
  if (actor && !canReadTeam(actor.access, issue.teamId)) return true;
  const service = getProvider(integration.provider)?.name ?? integration.provider;
  const name = actor
    ? null
    : ((await reply.displayName?.().catch(() => undefined)) ?? reply.user.name ?? reply.user.id);
  const body = actor ? text : `**${name!.replace(/[*_`[\]]/g, '')}** via ${service}:\n\n${text}`;
  const comment = actor
    ? await runInWorkspace(
        app,
        {
          workspaceId: integration.workspaceId,
          actorId: actor.userId,
          source: `integration:${integration.id}`,
          access: actor.access,
        },
        (ctx) => createComment(ctx, parent.issueId, { body }),
      )
    : await ictx.run((ctx) => createComment(ctx, parent.issueId, { body }));
  await app.db
    .insert(chatMessages)
    .values({
      integrationId: integration.id,
      channel: parent.channel,
      messageRef: reply.messageRef,
      issueId: parent.issueId,
      commentId: comment.id,
    })
    .onConflictDoNothing();
  return true;
}

// ─── accounts ─────────────────────────────────────────────────────────────

// No 0/O, 1/I/L, U: easy to read aloud and retype. 10 characters ≈ 49 bits, valid 15 minutes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function createLinkCode(
  app: FastifyInstance,
  userId: string,
  workspaceId: string,
  integrationId: string,
) {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  await createToken(
    app.db,
    userId,
    'chat_link',
    15,
    { workspaceId, integrationId },
    { token: code, replaceSame: 'integrationId' },
  );
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export const chatSettingsUrl = (app: FastifyInstance, slug: string) =>
  `${app.env.publicUrl}/${slug}/settings/connected`;

async function workspaceSlug(app: FastifyInstance, id: string) {
  const [ws] = await app.db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, id));
  return ws?.slug ?? '';
}

/** The Ordo user a chat account was proven to belong to, if they can still act in the workspace. */
export async function chatActor(ictx: IntegrationContext, chatUserId: string) {
  const { integration } = ictx;
  const [row] = await ictx.app.db
    .select({ userId: users.id, name: users.name, role: workspaceMembers.role })
    .from(externalAccounts)
    .innerJoin(users, eq(users.id, externalAccounts.userId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, users.id),
        eq(workspaceMembers.workspaceId, integration.workspaceId),
      ),
    )
    .where(
      and(
        eq(externalAccounts.integrationId, integration.id),
        eq(externalAccounts.externalId, chatUserId),
        isNotNull(externalAccounts.verifiedAt),
        isNull(users.disabledAt),
        isNull(workspaceMembers.suspendedAt),
        eq(users.kind, 'human'),
      ),
    );
  if (!row) return null;
  const access = await computeAccess(ictx.app.db, row.userId, integration.workspaceId, row.role);
  return { userId: row.userId, name: row.name, access };
}

async function linkAccount(ictx: IntegrationContext, incoming: ChatIncoming, code: string) {
  const { app, integration } = ictx;
  const invalid: ChatMessage = {
    headline: 'That code is invalid or has expired.',
    body: `Get a new one under Account → Connected accounts: ${chatSettingsUrl(app, await workspaceSlug(app, integration.workspaceId))}`,
  };
  if (!normalizeCode(code)) return invalid;
  let token: Awaited<ReturnType<typeof consumeToken>>;
  try {
    token = await consumeToken(app.db, 'chat_link', normalizeCode(code));
  } catch {
    return invalid;
  }
  if (token.data.integrationId !== integration.id) return invalid;
  const [member] = await app.db
    .select({ name: users.name, username: users.username })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, integration.workspaceId),
        eq(workspaceMembers.userId, token.userId),
        isNull(users.disabledAt),
      ),
    );
  if (!member) return invalid;
  const values = {
    userId: token.userId,
    username: incoming.user.name ?? null,
    integrationId: integration.id,
    verifiedAt: new Date().toISOString(),
    data: { notify: true },
  };
  // Whoever proves both sides wins: a chat account moves to the Ordo user who sent the code.
  await app.db
    .insert(externalAccounts)
    .values({
      ...values,
      workspaceId: integration.workspaceId,
      provider: integration.provider,
      host: integration.id,
      externalId: incoming.user.id,
    })
    .onConflictDoUpdate({
      target: [
        externalAccounts.workspaceId,
        externalAccounts.provider,
        externalAccounts.host,
        externalAccounts.externalId,
      ],
      set: values,
    });
  await audit(app.db, {
    workspaceId: integration.workspaceId,
    actorId: token.userId,
    action: 'chat_account.linked',
    targetType: 'integration',
    targetId: integration.id,
    data: { provider: integration.provider, account: incoming.user.name ?? incoming.user.id },
  });
  return {
    headline: `Linked to ${member.name} (@${member.username}) in Ordo.`,
    body: 'Notifications for you will arrive here as direct messages. Send "unlink" to stop.',
  };
}

async function unlinkAccount(ictx: IntegrationContext, incoming: ChatIncoming) {
  const { app, integration } = ictx;
  const removed = await app.db
    .delete(externalAccounts)
    .where(
      and(
        eq(externalAccounts.integrationId, integration.id),
        eq(externalAccounts.externalId, incoming.user.id),
      ),
    )
    .returning({ userId: externalAccounts.userId });
  if (!removed.length) return { headline: 'This account isn’t linked to Ordo.' };
  await audit(app.db, {
    workspaceId: integration.workspaceId,
    actorId: removed[0]!.userId,
    action: 'chat_account.unlinked',
    targetType: 'integration',
    targetId: integration.id,
    data: { provider: integration.provider, account: incoming.user.name ?? incoming.user.id },
  });
  return { headline: 'Unlinked. You won’t get notifications here any more.' };
}

/** Accounts on chat integrations, for Account → Connected accounts. */
export async function chatServices(
  app: FastifyInstance,
  workspaceId: string,
  userId: string,
): Promise<ChatService[]> {
  const rows = await app.db
    .select()
    .from(integrations)
    .where(eq(integrations.workspaceId, workspaceId));
  const chat = rows.filter((r) => r.status !== 'disabled' && getProvider(r.provider)?.chat);
  if (!chat.length) return [];
  const accounts = await app.db
    .select()
    .from(externalAccounts)
    .where(
      and(
        eq(externalAccounts.userId, userId),
        inArray(
          externalAccounts.integrationId,
          chat.map((r) => r.id),
        ),
        isNotNull(externalAccounts.verifiedAt),
      ),
    );
  return chat.map((r) => ({
    integrationId: r.id,
    provider: r.provider,
    name: r.name,
    linkHint: getProvider(r.provider)!.chat!.linkHint(r),
    accounts: accounts
      .filter((a) => a.integrationId === r.id)
      .map((a) => ({
        id: a.id,
        username: a.username,
        notify: a.data.notify !== false,
        createdAt: a.createdAt,
      })),
  }));
}

// ─── commands ─────────────────────────────────────────────────────────────

/** A message (or slash command) addressed to Ordo, as providers hand it over. */
export interface ChatIncoming {
  channel: string;
  user: { id: string; name?: string };
  /** What follows the command prefix or mention: "new ENG Fix login". */
  text: string;
  /** Private conversation with the bot. */
  direct: boolean;
  /** The message a command refers to: a reply's parent, a Slack shortcut's or Discord menu's target. */
  quoted?: { id: string; text: string; url?: string | null; author?: string };
}

export const HELP: ChatMessage = {
  headline: 'Ordo',
  body: [
    'link CODE: connect your Ordo account (code under Account → Connected accounts)',
    'new [TEAM] title: create an issue; reply to a message to file it',
    'unlink: disconnect your account',
  ].join('\n'),
};

/** Runs a command and returns the answer for the person who sent it. */
export async function runChatCommand(
  ictx: IntegrationContext,
  incoming: ChatIncoming,
): Promise<ChatMessage> {
  const [verb = '', ...args] = incoming.text.trim().split(/\s+/);
  switch (verb.toLowerCase().replace(/^[/!]/, '')) {
    case 'link':
      return linkAccount(ictx, incoming, args.join(''));
    case 'unlink':
      return unlinkAccount(ictx, incoming);
    case 'new':
    case 'create':
    case 'issue':
      return newIssue(ictx, incoming, args);
    case '':
      return incoming.quoted ? newIssue(ictx, incoming, []) : HELP;
    default:
      return HELP;
  }
}

async function pickTeam(
  db: DbOrTx,
  workspaceId: string,
  access: Access,
  args: string[],
  channel: ChatChannel | undefined,
) {
  const all = await db
    .select({ id: teams.id, key: teams.key })
    .from(teams)
    .where(eq(teams.workspaceId, workspaceId));
  const readable = all.filter((t) => canReadTeam(access, t.id));
  const named = readable.find((t) => t.key.toLowerCase() === args[0]?.toLowerCase());
  if (named && args.length > 1) return { teamId: named.id, args: args.slice(1) };
  const [ws] = await db
    .select({ defaultTeamId: workspaces.defaultTeamId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const [joined] = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, access.userId), eq(teams.workspaceId, workspaceId)));
  const teamId = [channel?.defaultTeamId, ws?.defaultTeamId, joined?.teamId, readable[0]?.id].find(
    (id) => id && canReadTeam(access, id),
  );
  return { teamId: teamId ?? null, args };
}

async function newIssue(ictx: IntegrationContext, incoming: ChatIncoming, rawArgs: string[]) {
  const { app, integration } = ictx;
  const actor = await chatActor(ictx, incoming.user.id);
  if (!actor) {
    return {
      headline: 'Link your Ordo account first.',
      body: `Get a code under Account → Connected accounts (${chatSettingsUrl(app, await workspaceSlug(app, integration.workspaceId))}), then send "link CODE" here.`,
    };
  }
  const channel = channelsOf(integration).find((c) => c.id === incoming.channel);
  const { teamId, args } = await pickTeam(
    app.db,
    integration.workspaceId,
    actor.access,
    rawArgs,
    channel,
  );
  if (!teamId) return { headline: 'You’re not in any team that can take issues.' };
  const quoted = incoming.quoted;
  const title = (args.join(' ') || quoted?.text.split('\n').find((l) => l.trim()) || '')
    .trim()
    .slice(0, 250);
  if (!title) return { headline: 'Give the issue a title: new [TEAM] title', body: HELP.body };
  const description = quoted
    ? [
        quoted.text
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
        '',
        `— ${quoted.author ?? 'someone'}${quoted.url ? ` ([message](${quoted.url}))` : ''}`,
      ].join('\n')
    : '';
  const issue = await runInWorkspace(
    app,
    {
      workspaceId: integration.workspaceId,
      actorId: actor.userId,
      access: actor.access,
      source: `integration:${integration.id}`,
    },
    async (ctx) => {
      const created = await createIssue(ctx, { teamId, title, description });
      if (quoted?.url) {
        await upsertIssueLink(ctx, {
          issueId: created.id,
          provider: integration.provider,
          kind: 'message',
          externalId: quoted.id,
          url: quoted.url,
          title: excerpt(`${quoted.author ? `${quoted.author}: ` : ''}${quoted.text}`, 120),
          author: quoted.author ?? null,
          integrationId: integration.id,
        });
      }
      return created;
    },
  );
  const card = (await issueCards(app, [issue.id])).get(issue.id)!;
  return issueMessage(card, `Created ${card.identifier}`);
}

// ─── unfurls ──────────────────────────────────────────────────────────────

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Issue URLs of this workspace in `text`, at most five. */
export function issueUrlsIn(app: FastifyInstance, slug: string, text: string) {
  const re = new RegExp(
    `${escapeRegExp(`${app.env.publicUrl}/${slug}/issue/`)}([A-Za-z][A-Za-z0-9]{0,6}-\\d+)`,
    'g',
  );
  const out = new Map<string, string>();
  for (const m of text.matchAll(re)) if (out.size < 5) out.set(m[0], m[1]!.toUpperCase());
  return out;
}

/** Previews for issue links someone posted, limited to issues that person can read in Ordo. */
export async function unfurl(
  ictx: IntegrationContext,
  chatUserId: string,
  text: string,
): Promise<{ url: string; message: ChatMessage }[]> {
  const { app, integration } = ictx;
  const slug = await workspaceSlug(app, integration.workspaceId);
  const urls = issueUrlsIn(app, slug, text);
  if (!urls.size) return [];
  const actor = await chatActor(ictx, chatUserId);
  if (!actor) return [];
  const wanted = [...new Set(urls.values())];
  const rows = await app.db
    .select({ id: issues.id, identifier: sql<string>`${teams.key} || '-' || ${issues.number}` })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(
      and(
        eq(issues.workspaceId, integration.workspaceId),
        inArray(sql`${teams.key} || '-' || ${issues.number}`, wanted),
        isNull(issues.deletedAt),
      ),
    );
  const cards = await issueCards(
    app,
    rows.map((r) => r.id),
  );
  const byIdentifier = new Map([...cards.values()].map((c) => [c.identifier, c]));
  return [...urls].flatMap(([url, identifier]) => {
    const card = byIdentifier.get(identifier);
    if (!card || !canReadTeam(actor.access, card.teamId)) return [];
    return [{ url, message: issueMessage(card, card.identifier, excerpt(card.description, 200)) }];
  });
}

// ─── personal notifications ───────────────────────────────────────────────

/** Called with fresh notifications (in their transaction): a direct message per linked account. */
export async function queueChatNotifications(
  tx: DbOrTx,
  workspaceId: string,
  rows: { id: string; userId: string }[],
) {
  if (!rows.length) return;
  const accounts = await tx
    .select({
      id: externalAccounts.id,
      userId: externalAccounts.userId,
      data: externalAccounts.data,
    })
    .from(externalAccounts)
    .innerJoin(integrations, eq(integrations.id, externalAccounts.integrationId))
    .where(
      and(
        eq(externalAccounts.workspaceId, workspaceId),
        inArray(externalAccounts.userId, [...new Set(rows.map((r) => r.userId))]),
        isNotNull(externalAccounts.verifiedAt),
        sql`${integrations.status} <> 'disabled'`,
      ),
    );
  for (const account of accounts) {
    if (account.data.notify === false) continue;
    for (const n of rows.filter((r) => r.userId === account.userId)) {
      await enqueue(
        tx,
        'chat.notify',
        { notificationId: n.id, accountId: account.id },
        { dedupeKey: `cn:${account.id}:${n.id}`, orderingKey: `chat-dm:${account.id}` },
      );
    }
  }
}

export async function runChatNotification(
  app: FastifyInstance,
  p: { notificationId: string; accountId: string },
  job: JobContext,
) {
  const [row] = await app.db
    .select({
      n: notifications,
      account: externalAccounts,
      actor: sql<string | null>`(select name from users a where a.id = ${notifications.actorId})`,
      preferences: sql<Partial<UserPreferences> | null>`(select preferences from users r where r.id = ${notifications.userId})`,
    })
    .from(notifications)
    // The account may have been re-linked to someone else since the job was queued.
    .innerJoin(
      externalAccounts,
      and(eq(externalAccounts.id, p.accountId), eq(externalAccounts.userId, notifications.userId)),
    )
    .where(eq(notifications.id, p.notificationId));
  if (!row?.n.issueId || !row.account.integrationId || !row.account.verifiedAt) return;
  const found = await activeIntegration(app, row.account.integrationId);
  if (!found?.provider.chat) return;
  const card = (await issueCards(app, [row.n.issueId])).get(row.n.issueId);
  if (!card || card.deleted) return;
  // Access may have changed since the notification was made.
  const allowed = await usersWithTeamAccess(app.db, row.n.workspaceId, card.teamId, [row.n.userId]);
  if (!allowed.length) return;
  let body: string | undefined;
  if (row.n.commentId) {
    const [c] = await app.db
      .select({ body: comments.body })
      .from(comments)
      .where(eq(comments.id, row.n.commentId));
    body = excerpt(c?.body);
  }
  const t = serverT(localeOf(row.preferences));
  const headline = t(`chat.${row.n.type}`, {
    actor: row.actor ?? t('notification.someone'),
    issue: card.identifier,
    state: card.state,
  });
  const message = issueMessage(card, headline, body, t);
  const ictx = integrationContext(app, found.row, job.log);
  await track(app, found.row, async () => {
    const dm = await found.provider.chat!.direct(
      ictx,
      { externalId: row.account.externalId, dmChannel: row.account.data.dmChannel },
      message,
    );
    if (dm && dm !== row.account.data.dmChannel) {
      await app.db
        .update(externalAccounts)
        .set({ data: { ...row.account.data, dmChannel: dm } })
        .where(eq(externalAccounts.id, row.account.id));
    }
  });
}
