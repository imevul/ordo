/**
 * Email templates in the Hotline Pink style. Email clients ignore stylesheets and most CSS,
 * so everything is inline, table-free and dark-only, with a plain-text twin.
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
  title: string;
  body: string;
  cta?: { label: string; url: string };
  footer?: string;
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
    <h1 style="margin:10px 0 16px;font-size:24px;line-height:1.2;letter-spacing:-.02em">${esc(opts.title)}</h1>
    ${opts.body}
    ${cta}
  </div>
  <p style="margin:24px 0 0;color:#8e7985;font:11px/1.6 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase">${esc(opts.footer ?? 'Sent by your Ordo instance')}</p>
</div></body></html>`;
}

const p = (text: string) => `<p style="margin:0 0 12px;color:#b8aab2">${text}</p>`;

export function passwordResetEmail(name: string, url: string): Email {
  return {
    subject: 'Reset your Ordo password',
    html: layout({
      kicker: 'password reset',
      title: `Hi ${esc(name)},`,
      body:
        p(
          'Someone (hopefully you) asked to reset your password. The link works for one hour, once.',
        ) + p("If it wasn't you, ignore this email — your password stays the same."),
      cta: { label: 'Choose a new password', url },
    }),
    text: `Hi ${name},\n\nReset your Ordo password (valid for one hour):\n${url}\n\nIf it wasn't you, ignore this email.`,
  };
}

export function verifyEmailEmail(name: string, url: string, change = false): Email {
  return {
    subject: change ? 'Confirm your new email address' : 'Verify your email address',
    html: layout({
      kicker: change ? 'email change' : 'verify email',
      title: change ? 'Confirm your new address' : `Welcome, ${esc(name)}`,
      body: p(
        change
          ? 'Confirm this address to make it the one you sign in with.'
          : 'Confirm this is your email address. The link works for two days.',
      ),
      cta: { label: change ? 'Confirm address' : 'Verify email', url },
    }),
    text: `${change ? 'Confirm your new Ordo email address' : 'Verify your Ordo email address'}:\n${url}`,
  };
}

export function inviteEmail(opts: {
  inviter: string;
  workspace: string;
  url: string;
  role: string;
}): Email {
  return {
    subject: `${opts.inviter} invited you to ${opts.workspace} on Ordo`,
    html: layout({
      kicker: 'invitation',
      title: `Join ${esc(opts.workspace)}`,
      body: p(
        `${esc(opts.inviter)} invited you to the <b style="color:#fff4fa">${esc(opts.workspace)}</b> workspace as ${esc(opts.role)}.`,
      ),
      cta: { label: 'Accept invite', url: opts.url },
    }),
    text: `${opts.inviter} invited you to ${opts.workspace} on Ordo as ${opts.role}.\n\nAccept: ${opts.url}`,
  };
}

export function securityEmail(opts: { title: string; body: string; url?: string }): Email {
  return {
    subject: opts.title,
    html: layout({
      kicker: 'security',
      title: opts.title,
      body:
        p(esc(opts.body)) +
        p("If this wasn't you, change your password and contact your administrator."),
      cta: opts.url ? { label: 'Open account settings', url: opts.url } : undefined,
    }),
    text: `${opts.title}\n\n${opts.body}\n\nIf this wasn't you, change your password and contact your administrator.`,
  };
}

export interface DigestItem {
  identifier: string;
  title: string;
  line: string;
  url: string;
}

export function digestEmail(opts: {
  workspace: string;
  items: DigestItem[];
  settingsUrl: string;
}): Email {
  const n = opts.items.length;
  const rows = opts.items
    .map(
      (i) => `<div style="padding:10px 0;border-top:1px solid #2a1f26">
        <a href="${esc(i.url)}" style="color:#fff4fa;text-decoration:none"><span style="font:12px ui-monospace,monospace;color:#8e7985">${esc(i.identifier)}</span> ${esc(i.title)}</a>
        <div style="color:#b8aab2;font-size:13px">${esc(i.line)}</div></div>`,
    )
    .join('');
  return {
    subject:
      n === 1
        ? `${opts.items[0]!.identifier}: ${opts.items[0]!.line}`
        : `${n} updates in ${opts.workspace}`,
    html: layout({
      kicker: 'inbox',
      title: n === 1 ? opts.items[0]!.title : `${n} updates in ${esc(opts.workspace)}`,
      body: rows,
      footer: 'Change which emails you get in Settings → Notifications',
    }).replace('Sent by your Ordo instance', ''),
    text: `${opts.items.map((i) => `${i.identifier} ${i.title}\n  ${i.line}\n  ${i.url}`).join('\n\n')}\n\nNotification settings: ${opts.settingsUrl}`,
  };
}
