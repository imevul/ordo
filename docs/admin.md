# Instance administration

The first account created on an instance is its **instance admin**. Instance admins see **Instance admin** in the
workspace menu (or go to `/admin`). It's separate from workspace roles: an instance admin manages the Ordo server,
not what happens inside each workspace.

## The admin area

| Page           | What it's for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**   | Version, counts, database size, live sockets, job queue, and health checks (email, secret key, storage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Users**      | Every account. Send a password reset link (copied for you, and emailed when email works), make or revoke instance admins, disable an account (signs it out everywhere and closes its live connections), delete an account (their issues and comments stay, shown as a former member). An account that is the only owner of a workspace can't be deleted until ownership moves.                                                                                                                                                                                                                                                 |
| **Invites**    | Invite people to the instance without adding them to a workspace: one invite per email address (emailed when email works) or a shareable link, valid for 1–90 days. Optionally let them create workspaces even when that's turned off. Copy, resend or revoke open invites. Without the grant, a site invitee waits on an "ask an administrator" page until someone adds them to a workspace. Grant or take back workspace creation for any account under **Users**.                                                                                                                                                           |
| **Workspaces** | Every workspace with members, issues and owners; delete one (type its URL to confirm).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Domains**    | Email domains workspaces have claimed. Approve one when DNS verification isn't possible (internal domains). A domain belongs to one workspace at most.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Settings**   | Sign-up policy, whether members may create more workspaces, SMTP (stored encrypted, with a test button), whether outbound requests may reach private networks, the largest attachment, and the model for [AI assistance](ai.md) (off by default; API key stored encrypted, with a test button), and what workspace admins may change about it: use their own model, only turn it off, or nothing. **Offline copies**: whether browsers keep a copy of each workspace (everywhere unless someone turns it off, the default; only where someone turns it on; or never). Values set by environment variables are shown as locked. |
| **Jobs**       | Queued and failed background jobs, with the error; retry or discard dead jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Audit log**  | Sign-ins, failed sign-ins, password and 2FA changes, admin actions — or one workspace's, or everything. Filter by kind of activity, time and free text (people's names and emails too); open an entry for what changed and from which IP address, and narrow to that person.                                                                                                                                                                                                                                                                                                                                                   |

## Recovery from the command line

When nobody can sign in as an admin, use the CLI inside the container:

```bash
make admin EMAIL=you@example.com            # make someone an instance admin (and re-enable them)
make reset-password EMAIL=you@example.com   # print a one-hour password reset link
docker compose exec app node cli.mjs disable-2fa you@example.com
docker compose exec app node cli.mjs rotate-key   # after changing ORDO_SECRET_KEY, see below
```

In development the same commands run with `pnpm --filter @ordo/api cli <command>`.

**Locked out after failed attempts:** ten wrong passwords or second-factor codes within 15 minutes lock password
sign-in for that account, from every address, until the 15 minutes have passed since the last failures. Passkeys and
single sign-on still work. The failures are in the audit log, with the addresses they came from.

## Rotating the secret key

`ORDO_SECRET_KEY` encrypts the secrets Ordo stores (see [configuration](configuration.md#compose-variables-env)). To replace it, for
example after it may have leaked:

1. In `.env`, move the current value of `ORDO_SECRET_KEY` to `ORDO_SECRET_KEY_PREVIOUS`.
2. Put a new key in `ORDO_SECRET_KEY` (`head -c 32 /dev/urandom | base64`).
3. `make restart`. New secrets are encrypted with the new key; existing ones still decrypt with the previous key.
   Signed file links handed out before the restart stop working; reloading the page gets new ones.
4. `docker compose exec app node cli.mjs rotate-key`. It re-encrypts every stored secret with the new key:
   two-factor secrets, SMTP settings, SSO client secrets, webhook signing secrets, integration tokens, AI API keys,
   push notification keys, Matrix encryption state and import credentials. It lists any secret it can't decrypt
   with either key; enter those again in Ordo.
5. Once every instance runs with the new key, run `rotate-key` again. When it re-encrypts 0 secrets and reports
   nothing it can't decrypt, remove `ORDO_SECRET_KEY_PREVIOUS` and `make restart`. If you remove it too early, the
   features that depend on the remaining secrets stop working (SSO sign-in, signed webhooks, integrations, AI
   assistance, push notifications), and **Admin → Overview** shows how many stored secrets can't be decrypted.

Back up the new key with your database, and keep the previous one with it for as long as it's set.
