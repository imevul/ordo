import { lookup } from 'node:dns/promises';
import { type EmailConfig, emailSettingsSchema } from '@ordo/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import { type AddressObject, simpleParser } from 'mailparser';
import { issueLinks, issues, teams, workflowStates } from '../db/schema.ts';
import { BlockedTargetError, isPrivateAddress } from '../lib/safeFetch.ts';
import { createAttachment } from '../services/attachments.ts';
import { createComment } from '../services/comments.ts';
import type { Ctx } from '../services/context.ts';
import { addCustomerRequest, customerForEmail } from '../services/customers.ts';
import { saveFile } from '../services/files.ts';
import { createIssue } from '../services/issues.ts';
import { upsertIssueLink } from '../services/links.ts';
import { configOf, type IntegrationContext, type IntegrationProvider } from './types.ts';

/**
 * Email intake: mail sent to an address becomes an issue in a team's triage, filed under the
 * sender's customer as a request. Replies in the same thread become comments. Mail arrives by IMAP
 * (Ordo checks a mailbox every minute; works behind NAT) or by webhook (anything that can POST
 * the raw message, e.g. an email worker or a mail server's pipe).
 */

const cfg = configOf<EmailConfig>();

/** Message ids as they appear in headers: "<abc@host>" → "abc@host". */
const ids = (value: string | string[] | undefined) =>
  [value ?? []]
    .flat()
    .flatMap((v) => v.match(/<[^>]+>/g) ?? [v])
    .map((v) => v.replace(/^<|>$/g, '').trim())
    .filter(Boolean);

const firstAddress = (a: AddressObject | AddressObject[] | undefined) =>
  [a ?? []].flat().flatMap((x) => x.value)[0];

/** Out-of-office replies, bounces and mailing-list noise don't make issues. */
function isAutomatic(headers: Map<string, unknown>, from: string) {
  const auto = String(headers.get('auto-submitted') ?? 'no').toLowerCase();
  const precedence = String(headers.get('precedence') ?? '').toLowerCase();
  return (
    auto !== 'no' ||
    ['bulk', 'junk', 'auto_reply', 'list'].includes(precedence) ||
    headers.has('x-autoreply') ||
    headers.has('x-autorespond') ||
    /^(mailer-daemon|postmaster|no-?reply)@/i.test(from)
  );
}

/** A team's triage status if it has triage, else its default. */
async function landingState(ctx: Ctx, teamId: string) {
  const [team] = await ctx.tx
    .select({ triage: teams.triageEnabled })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!team) throw new Error('The intake team no longer exists; pick another in the settings');
  if (!team.triage) return undefined;
  const [triage] = await ctx.tx
    .select({ id: workflowStates.id })
    .from(workflowStates)
    .where(and(eq(workflowStates.teamId, teamId), eq(workflowStates.type, 'triage')));
  return triage?.id;
}

/** Turns one raw message into an issue (or a comment on the issue its thread started). */
export async function ingestEmail(ictx: IntegrationContext, raw: string | Buffer) {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const from = firstAddress(mail.from);
  if (!from?.address) return;
  if (isAutomatic(mail.headers, from.address)) return;
  const messageId = ids(mail.messageId)[0] ?? null;
  const thread = [...ids(mail.inReplyTo), ...ids(mail.references as string[] | undefined)];
  const contact = from.name ? `${from.name} <${from.address}>` : from.address;
  const body = (mail.text ?? '').trim().slice(0, 50_000);
  const subject = (mail.subject ?? '').trim() || '(no subject)';
  const { teamId } = cfg(ictx.integration);
  const maxBytes = ictx.app.settings.get('maxAttachmentMb') * 1024 * 1024;

  const seen = (db: Pick<typeof ictx.app.db, 'select'>) =>
    messageId
      ? db
          .select({ id: issueLinks.id })
          .from(issueLinks)
          .where(
            and(
              eq(issueLinks.workspaceId, ictx.integration.workspaceId),
              eq(issueLinks.provider, 'email'),
              eq(issueLinks.externalId, messageId),
            ),
          )
          .then((rows) => rows.length > 0)
      : Promise.resolve(false);
  if (await seen(ictx.app.db)) return;

  // Files are stored first, outside the transaction, like uploads.
  const files: { id: string }[] = [];
  for (const a of mail.attachments ?? []) {
    if (a.related || a.size > maxBytes) continue;
    files.push(
      await saveFile(ictx.app, {
        workspaceId: ictx.integration.workspaceId,
        ownerId: ictx.integration.botUserId!,
        kind: 'attachment',
        filename: a.filename ?? 'attachment',
        body: a.content,
      }),
    );
  }

  await ictx.run(async (ctx) => {
    // The same message again (a redelivery, a mailbox re-scan) changes nothing.
    if (await seen(ctx.tx)) return;
    const [earlier] = thread.length
      ? await ctx.tx
          .select({ issueId: issueLinks.issueId })
          .from(issueLinks)
          .where(
            and(
              eq(issueLinks.workspaceId, ctx.workspaceId),
              eq(issueLinks.provider, 'email'),
              inArray(issueLinks.externalId, thread),
            ),
          )
      : [];
    const issue = earlier
      ? { id: earlier.issueId, reply: true }
      : {
          ...(await createIssue(ctx, {
            teamId,
            title: subject.slice(0, 500),
            description: body,
            stateId: await landingState(ctx, teamId),
          })),
          reply: false,
        };
    if (issue.reply) {
      await createComment(ctx, issue.id, {
        body: `**${contact.replace(/[*_`[\]]/g, '')}** wrote:\n\n${body || '(empty message)'}`,
      });
    } else {
      const customerId = await customerForEmail(ctx, from.address!, from.name);
      await addCustomerRequest(
        ctx,
        issue.id,
        { customerId, body: body.slice(0, 2000), contact },
        'email',
      );
    }
    if (messageId) {
      await upsertIssueLink(ctx, {
        issueId: issue.id,
        provider: 'email',
        kind: 'message',
        externalId: messageId,
        url: `mailto:${from.address}`,
        title: issue.reply ? `Re: ${subject}` : subject,
        author: contact,
        integrationId: ictx.integration.id,
      });
    }
    const [owner] = await ctx.tx
      .select({ teamId: issues.teamId })
      .from(issues)
      .where(eq(issues.id, issue.id));
    for (const file of files)
      await createAttachment(ctx, file.id, { id: issue.id, teamId: owner!.teamId });
  });
}

/** Where IMAP connects: the host's address, refusing private ones unless the instance allows it. */
async function imapTarget(ictx: IntegrationContext, host: string) {
  const { address } = await lookup(host);
  if (!ictx.app.settings.get('allowPrivateNetworkTargets') && isPrivateAddress(address))
    throw new BlockedTargetError(host);
  return address;
}

async function withMailbox<T>(
  ictx: IntegrationContext,
  fn: (client: ImapFlow, mailbox: string) => Promise<T>,
): Promise<T> {
  const c = cfg(ictx.integration);
  const client = new ImapFlow({
    host: await imapTarget(ictx, c.host!),
    port: c.port ?? 993,
    secure: c.secure ?? true,
    // Certificates are checked against the name, not the address we connect to.
    tls: { servername: c.host },
    auth: { user: c.username!, pass: ictx.secrets.password! },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client, c.mailbox || 'INBOX');
  } finally {
    await client.logout().catch(() => {});
  }
}

export const emailProvider: IntegrationProvider = {
  key: 'email',
  name: 'Email',
  description: 'Turn email to an address into triage issues, filed under the sender’s customer.',
  category: 'other',

  settings: emailSettingsSchema,

  async install(ictx) {
    // Fail now, with the server's answer, rather than on the first poll.
    if (cfg(ictx.integration).delivery === 'imap')
      await withMailbox(ictx, async (client, mailbox) => {
        await client.mailboxOpen(mailbox, { readOnly: true });
      });
  },

  deliveryId: (req) => /^message-id:\s*(.+)$/im.exec(req.body)?.[1]?.trim() ?? null,

  async handleInbound(ictx, req) {
    if (cfg(ictx.integration).delivery !== 'webhook') return;
    await ingestEmail(ictx, req.body);
  },

  pollIntervalSeconds: 60,

  /** Unread mail in the mailbox, oldest first; each is marked read once it's an issue. */
  async poll(ictx) {
    if (cfg(ictx.integration).delivery !== 'imap') return;
    await withMailbox(ictx, async (client, mailbox) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const unseen = (await client.search({ seen: false }, { uid: true })) || [];
        // One bad message mustn't hold up the rest: it stays unread for the next round, and the
        // integration shows the error.
        const failed: string[] = [];
        for (const uid of unseen.slice(0, 50)) {
          try {
            const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
            // biome-ignore lint/complexity/useOptionalChain: fetchOne returns false when nothing matched
            if (message && message.source) await ingestEmail(ictx, message.source);
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          } catch (err) {
            ictx.log.warn({ err, uid }, 'email intake: message failed');
            failed.push(err instanceof Error ? err.message : String(err));
          }
        }
        if (failed.length)
          throw new Error(`${failed.length} message(s) couldn't be filed: ${failed[0]}`);
      } finally {
        lock.release();
      }
    });
  },
};
