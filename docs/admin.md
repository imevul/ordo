# Instance administration

The first account created on an instance is its **instance admin**. Instance admins see **Instance admin** in the
workspace menu (or go to `/admin`). It's separate from workspace roles: an instance admin manages the Ordo server,
not what happens inside each workspace.

## The admin area

| Page           | What it's for                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**   | Version, counts, database size, live sockets, job queue, and health checks (email, secret key, storage).                                                                                                                                                                                                                                                                       |
| **Users**      | Every account. Send a password reset link (copied for you, and emailed when email works), make or revoke instance admins, disable an account (signs it out everywhere and closes its live connections), delete an account (their issues and comments stay, shown as a former member). An account that is the only owner of a workspace can't be deleted until ownership moves. |
| **Workspaces** | Every workspace with members, issues and owners; delete one (type its URL to confirm).                                                                                                                                                                                                                                                                                         |
| **Domains**    | Email domains workspaces have claimed. Approve one when DNS verification isn't possible (internal domains). A domain belongs to one workspace at most.                                                                                                                                                                                                                         |
| **Settings**   | Sign-up policy, whether members may create more workspaces, SMTP (stored encrypted, with a test button), whether outbound requests may reach private networks, the largest attachment, and the model for [AI assistance](ai.md) (off by default; API key stored encrypted, with a test button). Values set by environment variables are shown as locked.                       |
| **Jobs**       | Queued and failed background jobs, with the error; retry or discard dead jobs.                                                                                                                                                                                                                                                                                                 |
| **Audit log**  | Sign-ins, failed sign-ins, password and 2FA changes, admin actions — or everything across all workspaces.                                                                                                                                                                                                                                                                      |

## Recovery from the command line

When nobody can sign in as an admin, use the CLI inside the container:

```bash
make admin EMAIL=you@example.com            # make someone an instance admin (and re-enable them)
make reset-password EMAIL=you@example.com   # print a one-hour password reset link
docker compose exec app node cli.mjs disable-2fa you@example.com
docker compose exec app node cli.mjs rotate-key   # after changing ORDO_SECRET_KEY, see configuration.md
```

In development the same commands run with `pnpm --filter @ordo/api cli <command>`.
