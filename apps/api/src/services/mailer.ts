import type { FastifyInstance } from 'fastify';
import nodemailer, { type Transporter } from 'nodemailer';
import type { DbOrTx } from '../db/client.ts';
import { enqueue } from '../lib/jobs/index.ts';
import type { Email } from './mail-templates.ts';

const SMTP_AAD = 'instance_settings:smtp:url';

/** SMTP URLs saved through the admin UI are encrypted; ones from ORDO_SMTP_URL are plain. */
export const encryptSmtpUrl = (app: FastifyInstance, url: string) =>
  app.keyring.encrypt(url, SMTP_AAD);

export class Mailer {
  private transport: { url: string; t: Transporter } | null = null;

  constructor(private app: FastifyInstance) {}

  get enabled() {
    return this.app.settings.get('smtp') !== null;
  }

  private config() {
    const smtp = this.app.settings.get('smtp');
    if (!smtp) return null;
    const url = smtp.url.startsWith('v1.')
      ? this.app.keyring.decrypt(smtp.url, SMTP_AAD)
      : smtp.url;
    return { url, from: smtp.from };
  }

  /** Sends immediately. Most callers should queue with `queueEmail` instead. */
  async send(to: string, email: Email) {
    const config = this.config();
    if (!config) {
      this.app.log.info({ to, subject: email.subject }, 'SMTP not configured; email not sent');
      return;
    }
    if (this.transport?.url !== config.url) {
      this.transport?.t.close();
      this.transport = { url: config.url, t: nodemailer.createTransport(config.url) };
    }
    await this.transport.t.sendMail({
      from: config.from,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  }

  /** Checks the connection and credentials (admin "send test email"). */
  async verify() {
    const config = this.config();
    if (!config) throw new Error('SMTP is not configured');
    await nodemailer.createTransport(config.url).verify();
  }
}

/** Queues an email in the caller's transaction; the `email.send` job delivers it with retries. */
export function queueEmail(db: DbOrTx, to: string, email: Email) {
  return enqueue(db, 'email.send', { to, email }, { maxAttempts: 6 });
}
