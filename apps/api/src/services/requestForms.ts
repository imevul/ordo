import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_LOCALE,
  type PublicRequestForm,
  REQUEST_FORM_MAX_FILE_MB,
  REQUEST_FORM_MAX_FILES,
  type RequestForm,
  type RequestFormField,
  type SaveRequestFormInput,
  type SubmitRequestFormInput,
} from '@ordo/shared';
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { issueTemplates, requestFormSubmissions, requestForms, teams } from '../db/schema.ts';
import { badRequest, HttpError, notFound, one } from '../lib/errors.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { type Access, assertTeamAccess } from './access.ts';
import { createAttachment } from './attachments.ts';
import { auditCtx } from './audit.ts';
import { automationBot } from './automation.ts';
import { type Ctx, emit, type RequestMeta } from './context.ts';
import { addCustomerRequest, customerForEmail } from './customers.ts';
import { deleteFile, saveFile } from './files.ts';
import { createIssue } from './issues.ts';
import { requestDoneEmail, requestReceivedEmail } from './mail-templates.ts';
import { queueEmail } from './mailer.ts';
import { requestFormCaptchaSecretAad } from './secretKey.ts';
import { landingState } from './triage.ts';

type FormRow = typeof requestForms.$inferSelect;

/** Everyone behind one address together: past this, the form takes requests but sends no mail. */
const MAX_CONFIRMATIONS_PER_ADDRESS_HOUR = 3;
/** One form, every address: a flood from many IPs at once stops here. */
const MAX_SUBMISSIONS_PER_FORM_HOUR = 100;

const newToken = () => randomBytes(24).toString('base64url');
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

const toRequestForm = (f: FormRow): RequestForm => ({
  id: f.id,
  teamId: f.teamId,
  token: f.token,
  enabled: f.enabled,
  title: f.title,
  intro: f.intro,
  fields: f.fields,
  templateId: f.templateId,
  allowAttachments: f.allowAttachments,
  confirmationEmail: f.confirmationEmail,
  doneEmail: f.doneEmail,
  captchaProvider: f.captchaProvider,
  captchaSiteKey: f.captchaSiteKey,
  captchaSecretSet: !!f.captchaSecret,
});

/** The team, in this workspace, for an admin of it. A bad id looks like a missing team. */
async function assertTeamAdmin(db: DbOrTx, access: Access, teamId: string) {
  const [team] = /^[0-9a-f-]{36}$/.test(teamId)
    ? await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.workspaceId, access.workspaceId)))
    : [];
  if (!team) throw notFound('Team');
  assertTeamAccess(access, team.id, 'admin');
}

export async function getRequestForm(db: DbOrTx, access: Access, teamId: string) {
  await assertTeamAdmin(db, access, teamId);
  const [row] = await db.select().from(requestForms).where(eq(requestForms.teamId, teamId));
  return { form: row ? toRequestForm(row) : null };
}

/** Creates the team's form on first save; anything left out of `input` stays as it is. */
export async function saveRequestForm(
  app: FastifyInstance,
  ctx: Ctx,
  teamId: string,
  input: SaveRequestFormInput,
) {
  await assertTeamAdmin(ctx.tx, ctx.access, teamId);
  const { captchaSecret, ...values } = input;
  if (input.templateId) {
    const [template] = await ctx.tx
      .select({ id: issueTemplates.id })
      .from(issueTemplates)
      .where(
        and(
          eq(issueTemplates.id, input.templateId),
          eq(issueTemplates.workspaceId, ctx.workspaceId),
          or(isNull(issueTemplates.teamId), eq(issueTemplates.teamId, teamId)),
        ),
      );
    if (!template) throw notFound('Template');
  }
  if (captchaSecret && !app.keyring.available)
    throw badRequest('Set ORDO_SECRET_KEY before adding a CAPTCHA secret');

  const [current] = await ctx.tx.select().from(requestForms).where(eq(requestForms.teamId, teamId));
  const id = current?.id ?? randomUUID();
  const provider =
    input.captchaProvider !== undefined ? input.captchaProvider : current?.captchaProvider;
  const siteKey =
    input.captchaSiteKey !== undefined ? input.captchaSiteKey : current?.captchaSiteKey;
  if (provider && (!siteKey || !(captchaSecret || current?.captchaSecret)))
    throw badRequest('A CAPTCHA provider needs a site key and a secret key');
  const set = {
    ...values,
    // Turning CAPTCHA off forgets its keys, so a stale secret can't linger.
    ...(provider
      ? captchaSecret && {
          captchaSecret: app.keyring.encrypt(captchaSecret, requestFormCaptchaSecretAad(id)),
        }
      : { captchaProvider: null, captchaSiteKey: null, captchaSecret: null }),
  };
  const row = one(
    current
      ? await ctx.tx
          .update(requestForms)
          .set({ ...set, updatedAt: new Date().toISOString() })
          .where(eq(requestForms.id, id))
          .returning()
      : await ctx.tx
          .insert(requestForms)
          .values({ ...set, id, workspaceId: ctx.workspaceId, teamId, token: newToken() })
          .returning(),
  );
  await auditCtx(ctx, {
    action: 'request_form.updated',
    targetType: 'team',
    targetId: teamId,
    data: { enabled: row.enabled, captcha: row.captchaProvider },
  });
  emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
  return toRequestForm(row);
}

/** A new link: the old one stops working, for when it spread further than it should have. */
export async function rotateRequestFormLink(ctx: Ctx, teamId: string) {
  await assertTeamAdmin(ctx.tx, ctx.access, teamId);
  const row = one(
    await ctx.tx
      .update(requestForms)
      .set({ token: newToken(), updatedAt: new Date().toISOString() })
      .where(eq(requestForms.teamId, teamId))
      .returning(),
    'Request form',
  );
  await auditCtx(ctx, {
    action: 'request_form.link_rotated',
    targetType: 'team',
    targetId: teamId,
  });
  emit(ctx, { kind: 'team', action: 'updated', id: teamId, teamId });
  return toRequestForm(row);
}

/** The form behind a public link. Switched off looks exactly like a link that never existed. */
export async function loadOpenForm(db: DbOrTx, token: string) {
  const [row] = await db
    .select()
    .from(requestForms)
    .where(and(eq(requestForms.token, token), eq(requestForms.enabled, true)));
  if (!row) throw notFound('Form');
  return row;
}

/** Per file: the instance's limit, capped, as nobody signed in stands behind these uploads. */
export const maxFormFileMb = (app: FastifyInstance) =>
  Math.min(app.settings.get('maxAttachmentMb'), REQUEST_FORM_MAX_FILE_MB);

export const toPublicForm = (app: FastifyInstance, f: FormRow): PublicRequestForm => ({
  title: f.title,
  intro: f.intro,
  fields: f.fields,
  attachments: f.allowAttachments
    ? { maxFiles: REQUEST_FORM_MAX_FILES, maxFileMb: maxFormFileMb(app) }
    : null,
  captcha:
    f.captchaProvider && f.captchaSiteKey
      ? { provider: f.captchaProvider, siteKey: f.captchaSiteKey }
      : null,
});

/** The answers to the team's own questions, checked against the form, in its order. */
function checkAnswers(fields: RequestFormField[], answers: SubmitRequestFormInput['answers']) {
  const lines: string[] = [];
  for (const f of fields) {
    const given = answers[f.id];
    const value = typeof given === 'string' ? given.trim() : given;
    // A label is often a question already: "Which plan?", not "Which plan?:".
    const label = /[?:!]$/.test(f.label) ? f.label : `${f.label}:`;
    if (f.type === 'checkbox') {
      if (f.required && value !== true) throw badRequest(`"${f.label}" is required`);
      lines.push(`**${label}** ${value === true ? 'yes' : 'no'}`);
      continue;
    }
    if (typeof value !== 'string' || !value) {
      if (f.required) throw badRequest(`"${f.label}" is required`);
      continue;
    }
    if (f.type === 'select' && !f.options?.includes(value))
      throw badRequest(`"${f.label}" has no such option`);
    lines.push(f.type === 'textarea' ? `**${label}**\n\n${value}` : `**${label}** ${value}`);
  }
  return lines;
}

async function assertCaptcha(
  app: FastifyInstance,
  form: FormRow,
  token: string | undefined,
  ip: string | null,
) {
  if (!form.captchaProvider) return;
  let secret: string | null = null;
  try {
    secret = form.captchaSecret
      ? app.keyring.decrypt(form.captchaSecret, requestFormCaptchaSecretAad(form.id))
      : null;
  } catch (err) {
    app.log.error({ err, form: form.id }, 'request form: the CAPTCHA secret does not decrypt');
  }
  const passed =
    !!secret && !!token && (await app.verifyCaptcha(form.captchaProvider, secret, token, ip));
  if (!passed)
    throw new HttpError(400, 'CAPTCHA verification failed', 'captcha_failed').as('captcha_failed');
}

/**
 * Files one public submission as an issue in the team's triage, linked to the customer behind the
 * email address. Nobody is signed in, so the workspace's Ordo bot files it. The address is
 * unverified: it says who they claim to be, nothing more.
 */
export async function submitRequestForm(
  app: FastifyInstance,
  form: FormRow,
  input: SubmitRequestFormInput,
  files: { filename: string; body: Buffer }[],
  meta: RequestMeta,
) {
  // A bot that took the bait gets the same answer as everyone, and learns nothing.
  if (input.website) return;
  await assertCaptcha(app, form, input.captchaToken, meta.ip);
  const answers = checkAnswers(form.fields, input.answers);
  const [{ recent }] = (await app.db
    .select({ recent: sql<number>`count(*)::int` })
    .from(requestFormSubmissions)
    .where(
      and(
        eq(requestFormSubmissions.formId, form.id),
        gte(requestFormSubmissions.createdAt, hourAgo()),
      ),
    )) as [{ recent: number }];
  if (recent >= MAX_SUBMISSIONS_PER_FORM_HOUR)
    throw new HttpError(429, 'This form is busy; try again later', 'rate_limited').as(
      'request_form_busy',
    );

  const botId = await automationBot(app.db, form.workspaceId);
  const name = input.name.replace(/\s+/g, ' ');
  const title = input.title.replace(/\s+/g, ' ');
  const locale = input.locale ?? DEFAULT_LOCALE;
  const description = [input.description, ...answers].filter(Boolean);

  // Stored first, outside the transaction, like uploads; the sweep collects any left behind.
  const saved: { id: string }[] = [];
  try {
    for (const file of files)
      saved.push(
        await saveFile(app, {
          workspaceId: form.workspaceId,
          ownerId: botId,
          kind: 'attachment',
          filename: file.filename,
          body: file.body,
        }),
      );
    await runInWorkspace(
      app,
      { workspaceId: form.workspaceId, actorId: botId, source: 'form', meta },
      async (ctx) => {
        const issue = await fileIssue(ctx, form, title, description);
        const customerId = await customerForEmail(ctx, input.email, name);
        await addCustomerRequest(
          ctx,
          issue.id,
          {
            customerId,
            body: input.description.slice(0, 2000),
            contact: `${name} <${input.email}>`,
          },
          'form',
        );
        for (const file of saved)
          await createAttachment(ctx, file.id, { id: issue.id, teamId: issue.teamId });
        const [{ mailed }] = (await ctx.tx
          .select({ mailed: sql<number>`count(*)::int` })
          .from(requestFormSubmissions)
          .where(
            and(
              eq(requestFormSubmissions.workspaceId, ctx.workspaceId),
              eq(requestFormSubmissions.email, input.email),
              gte(requestFormSubmissions.createdAt, hourAgo()),
            ),
          )) as [{ mailed: number }];
        await ctx.tx.insert(requestFormSubmissions).values({
          workspaceId: ctx.workspaceId,
          formId: form.id,
          issueId: issue.id,
          email: input.email,
          title,
          locale,
        });
        if (form.confirmationEmail && mailed < MAX_CONFIRMATIONS_PER_ADDRESS_HOUR)
          await queueEmail(ctx.tx, input.email, requestReceivedEmail(locale, form.title));
      },
    );
  } catch (err) {
    await Promise.all(saved.map((file) => deleteFile(app, file.id)));
    throw err;
  }
}

/**
 * The issue, with the form's template as defaults. It always lands in triage, and nobody is assigned
 * unless the template says so: text from anyone on the internet shouldn't reach a team's default
 * assignee (possibly an agent) on its own.
 */
async function fileIssue(ctx: Ctx, form: FormRow, title: string, description: string[]) {
  const [template] = form.templateId
    ? await ctx.tx.select().from(issueTemplates).where(eq(issueTemplates.id, form.templateId))
    : [];
  const base = {
    teamId: form.teamId,
    title,
    stateId: await landingState(ctx, form.teamId),
    assigneeId: null,
    description: description.join('\n\n'),
  };
  if (!template) return createIssue(ctx, base);
  const events = ctx.events.length;
  const domainEvents = ctx.domainEvents.length;
  try {
    return await ctx.tx.transaction((tx) =>
      createIssue(
        { ...ctx, tx },
        {
          ...base,
          description: [...description, template.description].filter(Boolean).join('\n\n'),
          priority: template.priority ?? undefined,
          assigneeId: template.assigneeId,
          projectId: template.projectId,
          estimate: template.estimate ?? undefined,
          labelIds: template.labelIds,
        },
      ),
    );
  } catch {
    // A person or label can go stale after the template was written. The request still counts.
    ctx.events.length = events;
    ctx.domainEvents.length = domainEvents;
    return createIssue(ctx, base);
  }
}

/** Queues the "it's done" notices for these issues; each submission gets one, ever. */
export async function queueRequestDoneEmails(ctx: Ctx, issueIds: string[]) {
  if (ctx.silent || issueIds.length === 0) return;
  const rows = await ctx.tx
    .select({ submission: requestFormSubmissions })
    .from(requestFormSubmissions)
    .innerJoin(requestForms, eq(requestForms.id, requestFormSubmissions.formId))
    .where(
      and(
        inArray(requestFormSubmissions.issueId, issueIds),
        eq(requestFormSubmissions.workspaceId, ctx.workspaceId),
        isNull(requestFormSubmissions.doneNotifiedAt),
        eq(requestForms.doneEmail, true),
      ),
    );
  for (const { submission } of rows) {
    await ctx.tx
      .update(requestFormSubmissions)
      .set({ doneNotifiedAt: new Date().toISOString() })
      .where(eq(requestFormSubmissions.id, submission.id));
    await queueEmail(
      ctx.tx,
      submission.email,
      requestDoneEmail(submission.locale, submission.title),
    );
  }
}
