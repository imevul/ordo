import type { Locale } from '@ordo/shared';
import { serverT } from '../i18n/index.ts';

/**
 * Email templates in the Hotline Pink style. Email clients ignore stylesheets and most CSS,
 * so everything is inline, table-free and dark-only, with a plain-text twin. Each is written in
 * its recipient's language (`serverT`).
 */
export interface Email {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function layout(opts: {
  kicker: string;
  /** HTML: escape anything a person typed. */
  title: string;
  body: string;
  cta?: { label: string; url: string };
  footer: string;
}) {
  const cta = opts.cta
    ? `<p style="margin:28px 0 8px"><a href="${esc(opts.cta.url)}" style="display:inline-block;background:#ff1493;color:#09090b;font:600 13px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;padding:12px 18px">${esc(opts.cta.label)} &rarr;</a></p>
       <p style="margin:0;color:#8e7985;font:12px/1.5 ui-monospace,monospace;word-break:break-all">${esc(opts.cta.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#09090b">
<div style="max-width:560px;margin:0 auto;padding:40px 24px;font:15px/1.6 'Space Grotesk','Segoe UI',system-ui,sans-serif;color:#fff4fa">
  <div style="font:600 13px/1 ui-monospace,monospace;letter-spacing:.04em;margin-bottom:28px"><span style="display:inline-block;width:5px;height:16px;background:#ff1493;vertical-align:-3px;margin-right:10px"></span>ORDO</div>
  <div style="background:#1c191c;border:1px solid #49313e;padding:28px">
    <div style="font:12px/1 ui-monospace,monospace;color:#ff1493;letter-spacing:.06em"><span style="color:#b8aab2">// </span>${esc(opts.kicker)}</div>
    <h1 style="margin:10px 0 16px;font-size:24px;line-height:1.2;letter-spacing:-.02em">${opts.title}</h1>
    ${opts.body}
    ${cta}
  </div>
  <p style="margin:24px 0 0;color:#8e7985;font:11px/1.6 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase">${esc(opts.footer)}</p>
</div></body></html>`;
}

const p = (text: string) => `<p style="margin:0 0 12px;color:#b8aab2">${text}</p>`;
/** A message with HTML-escaped values; `<b>` in it becomes the bright inline emphasis. */
const rich = (text: string) => text.replace(/<b>/g, '<b style="color:#fff4fa">');

export function passwordResetEmail(locale: Locale, name: string, url: string): Email {
  const t = serverT(locale);
  return {
    subject: t('email.passwordReset.subject'),
    html: layout({
      kicker: t('email.passwordReset.kicker'),
      title: t('email.passwordReset.title', { name: esc(name) }),
      body: p(esc(t('email.passwordReset.body'))) + p(esc(t('email.passwordReset.ignore'))),
      cta: { label: t('email.passwordReset.cta'), url },
      footer: t('email.footer'),
    }),
    text: t('email.passwordReset.text', { name, url }),
  };
}

export function verifyEmailEmail(locale: Locale, name: string, url: string, change = false): Email {
  const t = serverT(locale);
  const k = change ? 'change' : 'verify';
  return {
    subject: t(`email.${k}.subject`),
    html: layout({
      kicker: t(`email.${k}.kicker`),
      title: t(`email.${k}.title`, { name: esc(name) }),
      body: p(esc(t(`email.${k}.body`))),
      cta: { label: t(`email.${k}.cta`), url },
      footer: t('email.footer'),
    }),
    text: t(`email.${k}.text`, { url }),
  };
}

export function inviteEmail(
  locale: Locale,
  opts: {
    inviter: string;
    workspace: string;
    url: string;
    role: 'owner' | 'admin' | 'member' | 'guest';
  },
): Email {
  const t = serverT(locale);
  const role = t(`email.invite.role.${opts.role}`);
  return {
    subject: t('email.invite.subject', { inviter: opts.inviter, workspace: opts.workspace }),
    html: layout({
      kicker: t('email.invite.kicker'),
      title: t('email.invite.title', { workspace: esc(opts.workspace) }),
      body: p(
        rich(
          t('email.invite.body', {
            inviter: esc(opts.inviter),
            workspace: esc(opts.workspace),
            role: esc(role),
          }),
        ),
      ),
      cta: { label: t('email.invite.cta'), url: opts.url },
      footer: t('email.footer'),
    }),
    text: t('email.invite.text', {
      inviter: opts.inviter,
      workspace: opts.workspace,
      role,
      url: opts.url,
    }),
  };
}

export type SecurityNotice =
  | 'twoFactorOn'
  | 'twoFactorOff'
  | 'emailChanged'
  | 'passkeyAdded'
  | 'passkeyRemoved'
  | 'totpOff';

export function securityEmail(
  locale: Locale,
  opts: { notice: SecurityNotice; params?: Record<string, string>; url?: string },
): Email {
  const t = serverT(locale);
  const title = t(`email.security.${opts.notice}.title`);
  const body = t(`email.security.${opts.notice}.body`, opts.params);
  const notYou = t('email.security.notYou');
  return {
    subject: title,
    html: layout({
      kicker: t('email.security.kicker'),
      title,
      body: p(esc(body)) + p(esc(notYou)),
      cta: opts.url ? { label: t('email.security.cta'), url: opts.url } : undefined,
      footer: t('email.footer'),
    }),
    text: `${title}\n\n${body}\n\n${notYou}`,
  };
}

export interface DigestItem {
  identifier: string;
  title: string;
  line: string;
  url: string;
}

export function digestEmail(
  locale: Locale,
  opts: { workspace: string; items: DigestItem[]; settingsUrl: string },
): Email {
  const t = serverT(locale);
  const n = opts.items.length;
  const rows = opts.items
    .map(
      (i) => `<div style="padding:10px 0;border-top:1px solid #2a1f26">
        <a href="${esc(i.url)}" style="color:#fff4fa;text-decoration:none"><span style="font:12px ui-monospace,monospace;color:#8e7985">${esc(i.identifier)}</span> ${esc(i.title)}</a>
        <div style="color:#b8aab2;font-size:13px">${esc(i.line)}</div></div>`,
    )
    .join('');
  const updates = (workspace: string) => t('email.digest.updates', { count: n, workspace });
  return {
    subject:
      n === 1 ? `${opts.items[0]!.identifier}: ${opts.items[0]!.line}` : updates(opts.workspace),
    html: layout({
      kicker: t('email.digest.kicker'),
      title: n === 1 ? esc(opts.items[0]!.title) : updates(esc(opts.workspace)),
      body: rows,
      footer: t('email.digest.footer'),
    }),
    text: `${opts.items.map((i) => `${i.identifier} ${i.title}\n  ${i.line}\n  ${i.url}`).join('\n\n')}\n\n${t('email.digest.settings', { url: opts.settingsUrl })}`,
  };
}
