# Email intake

Turns email to an address — `support@`, `bugs@` — into issues. Each message becomes an issue in the team you pick,
in its **triage** if the team has triage (otherwise in its default status), with:

- the subject as the title and the message as the description,
- the message's attachments on the issue,
- a [customer request](../user-guide.md#customers-and-requests) from the sender: mail from `@acme.com` is filed
  under the customer with that domain (created if there's none yet); free-mail senders (Gmail, Outlook, iCloud…)
  each get a customer of their own,
- a link to the message under the issue's _Links_.

Replies in the same thread (by `In-Reply-To` / `References`) are added as comments instead of new issues, as long as
the issue is still in this address's team; a reply to an issue that has moved to another team starts a new one. The same
message delivered twice is only processed once. Out-of-office replies, bounces and bulk mail are ignored. Triage rules
can match mail with the source **email**.

Everything is done by the integration's bot. Nobody gets an email back from Ordo.

## Connect

**Settings → Integrations → Email**, then choose how mail reaches Ordo:

### Check a mailbox (IMAP)

Ordo reads the folder every minute, makes issues of unread mail, and marks it read. Nothing has to reach Ordo, so this
works behind NAT and firewalls. Use a mailbox that only receives intake mail, since Ordo reads all of it.

| Provider          | Server                  | Notes                                                                          |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Gmail / Workspace | `imap.gmail.com`        | Turn on IMAP; use an [app password](https://myaccount.google.com/apppasswords) |
| Fastmail          | `imap.fastmail.com`     | Use an app password                                                            |
| Microsoft 365     | `outlook.office365.com` | Needs basic auth for IMAP enabled on the mailbox                               |
| Your own server   | its host name           | Port 993 with TLS, or 143 with STARTTLS (untick TLS)                           |

Ordo checks the login when you connect and shows the server's error if it fails. Servers on private networks are
refused unless an instance admin allows private network targets.

### Receive by webhook

Something that receives your mail POSTs each message, raw (`Content-Type: message/rfc822`), to the webhook URL shown
in the integration's settings. Ordo answers `202 Accepted` and processes it in the background. For example:

- a **mail server** delivering to a pipe: `curl -s --data-binary @- -H 'Content-Type: message/rfc822' "$URL"`,
- a **Cloudflare Email Worker**:

  ```js
  export default {
    async email(message, env) {
      await fetch(env.ORDO_EMAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'message/rfc822' },
        body: message.raw,
      });
    },
  };
  ```

The URL contains the integration's secret token; treat it like a password. Messages up to 25 MB are accepted;
attachments larger than the instance's attachment limit are left out.
