# Self-hosting

Ordo ships as one application container plus Postgres. Everything is driven by `make`.

## Requirements

- Docker Engine with the Compose v2 plugin (`docker compose version`)
- `make`, `git`
- ~300 MB disk for the image, plus your data. 1 vCPU / 512 MB RAM is plenty for small teams.

## Install

```bash
git clone <repo-url> ordo
cd ordo
make up
```

`make up`:

1. creates `.env` from `.env.example` with a random `POSTGRES_PASSWORD` (only if `.env` doesn't exist),
2. builds the image (`docker compose build`),
3. starts Postgres and Ordo and waits until both report healthy,
4. prints the URL.

Open it and sign up — the first account is the **instance admin** and is guided through creating a
workspace and its first team. Invite others from **Settings → Members**. The admin area (users, workspaces, SMTP,
jobs) is under **Instance admin** in the workspace menu; see [admin.md](admin.md), which also covers recovering
access from the command line.

Want to look around first? `make seed` creates a demo workspace; sign in as `demo@ordo.test` /
`ordo-demo-password` (also `grace@`, `alan@`, `ada@ordo.test`). Don't seed a production instance.

## Day-to-day

|                |                                                  |
| -------------- | ------------------------------------------------ |
| `make down`    | Stop. Data stays in the `ordo-db` Docker volume. |
| `make restart` | Restart containers.                              |
| `make logs`    | Tail application logs.                           |
| `make ps`      | Container status and health.                     |
| `make psql`    | SQL shell.                                       |

## Updating

```bash
make update
```

This runs `git pull --ff-only` (when a git remote is configured), rebuilds the image with fresh base images,
and recreates the containers. Database migrations run automatically when the app starts, inside a transaction;
if one fails the app refuses to start and the previous data is untouched. **Take a backup before updating.**

## Email

Set `ORDO_SMTP_URL` and `ORDO_SMTP_FROM` in `.env` (see [configuration](configuration.md#email)) and `make up`.
Any SMTP provider works (Postmark, SES, Mailgun, Fastmail, your own Postfix…). Without it, password resets and
emailed invites aren't available — invite links can still be copied and shared by hand.

## Backups

Back up three things: the database, uploaded files, and `ORDO_SECRET_KEY` from `.env` (it encrypts stored 2FA, SSO
and integration secrets — a database restored without its key loses those secrets, everything else still works; see
[Missing or wrong secret key](#missing-or-wrong-secret-key)).
`make backup` covers the first two: it writes `backups/ordo-<timestamp>.sql.gz` and, for local storage,
`backups/ordo-<timestamp>.uploads.tar.gz`. With S3 storage, back up the bucket with your provider's tools.

```bash
make backup                                   # → backups/ordo-20260131-120000.sql.gz
make restore FILE=backups/ordo-20260131-120000.sql.gz
```

Backups are plain `pg_dump` SQL files (with `DROP … IF EXISTS`), so a restore replaces the current data; the
matching uploads archive is restored too when it sits next to the SQL file. Copy
the `backups/` directory off the machine. A simple cron entry, which also prunes both kinds of file after 14 days:

```cron
0 3 * * * cd /opt/ordo && make backup >/dev/null && find backups -name 'ordo-*.gz' -mtime +14 -delete
```

Both targets need `bash` on the host. `make backup` exits non-zero and leaves no file when the dump or the uploads
archive fails (the database container is down, the disk is full…), so the `find` doesn't prune old backups after a
failed run, and cron mails you the error if it can send mail. Both files are written as `*.tmp` and renamed only once
they're complete and pass `gzip -t`.

`make restore` checks the file with `gzip -t` before it stops the app, then loads the dump in a single transaction
that stops at the first SQL error. If anything fails, the database is rolled back to what it was, the uploads aren't
touched and the app stays stopped; fix the problem and restore again, or `docker compose start app` to run on the old
data.

### Restoring onto a new host

To move Ordo, or to rebuild it after losing the machine, you need the newest `ordo-<timestamp>.sql.gz`, its
`.uploads.tar.gz` (local storage only) and the old `.env`. Without the old `ORDO_SECRET_KEY` the move still works, but
the stored secrets are lost; see [Missing or wrong secret key](#missing-or-wrong-secret-key).

1. **On the old host**, if it still runs: `make backup`, then `make down` so nothing changes after the backup. Note the
   version you were on (`git rev-parse HEAD`, or `version` from `/api/health`).
2. **Copy** the two backup files and `.env` to the new host, e.g. `scp .env backups/ordo-20260131-120000.* new:/tmp/`.
   `.env` holds the database password and `ORDO_SECRET_KEY`, so copy it over SSH and keep it at mode `600`.
3. **On the new host**, check out the **same version** the backup came from and put `.env` in place before anything
   else, so `make up` keeps the key instead of generating a new one:

   ```bash
   git clone <repo-url> /opt/ordo && cd /opt/ordo
   git checkout <commit or tag of the old host>
   install -m 600 /tmp/.env .env
   ```

4. **Change the address** if it changes: set `ORDO_PUBLIC_URL` in `.env` (and `ORDO_BIND` / `ORDO_PORT` for the new
   proxy). Passkeys belong to the hostname, so they stop working on a new one, and people sign in with their password
   or SSO and add passkeys again.
5. **Start it and restore:**

   ```bash
   make up                                                # empty database, migrations run
   make restore FILE=/tmp/ordo-20260131-120000.sql.gz     # data, plus the uploads archive next to it
   ```

   With S3 storage there's no uploads archive: copy the `ORDO_S3_*` settings and the files stay where they are.
6. **Check it:** `/api/health` answers 200, you can sign in, **Instance admin → Overview** shows the secret key check
   passing (it counts stored secrets that can't be decrypted), and an issue with an attachment shows its image.
7. **Switch traffic:** point DNS or your proxy at the new host. When the address changed, also update what outside
   services have stored: the redirect URIs at your SSO providers (Settings → Authentication shows the new ones), webhook
   URLs at your forges and chat apps (`/api/hooks/…`), and any GitHub or Slack app you made for this instance.
8. **Update** to the latest version with `make update` once the restored instance works.

Restore onto the same version first: a dump from an older version restored over a database that newer migrations
already created can leave tables behind that the next start then fails to create. Without Docker, the same steps work
with `pg_dump` / `psql` and the files under `ORDO_DATA_DIR`; see [Running without Docker](#running-without-docker).

## HTTPS and reverse proxies

Run Ordo behind a TLS-terminating proxy and set `ORDO_PUBLIC_URL=https://ordo.example.com` in `.env` (then
`make up` again). Bind the app to localhost with `ORDO_BIND=127.0.0.1` if the proxy runs on the same host. The
proxy must forward WebSocket upgrades for `/api/ws`. HTTPS is also what lets browsers install Ordo as an app and receive
push notifications (Ordo makes its own VAPID keys for push on first use; the push services it posts to —
Google's, Mozilla's, Apple's — must be reachable from the server).

**Caddy**

```caddyfile
ordo.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

**nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name ordo.example.com;
    # ssl_certificate …; ssl_certificate_key …;

    # Above the largest attachment (25 MB unless you change it).
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

**Traefik** (labels on the `app` service)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.ordo.rule=Host(`ordo.example.com`)
  - traefik.http.routers.ordo.tls.certresolver=letsencrypt
  - traefik.http.services.ordo.loadbalancer.server.port=3000
```

## Scaling out

The API is stateless apart from WebSocket connections, and realtime events travel through Postgres
`LISTEN/NOTIFY`, so you can run several `app` replicas behind a load balancer. With Compose, drop the `ports`
mapping, put your proxy on the same network and run `docker compose up -d --scale app=3`; any orchestrator
works the same way. Sticky sessions are not required.

## Monitoring

`GET /api/health` needs no sign-in. It runs `select 1` against the database, then answers:

```json
{
  "ok": true,
  "version": "0.1.0",
  "realtimeConnections": 12,
  "jobs": { "pending": 3, "running": 1, "dead": 0 }
}
```

- **Status.** `200` means the process is up and the database answers. When the database is unreachable the request
  fails with `500`; when the process is down nothing answers. The Docker image's `HEALTHCHECK` and `make check-bundle`
  use the same URL.
- **`realtimeConnections`**: open WebSockets on _this_ instance. With several replicas each one reports its own.
- **`jobs`**: background jobs by status, counted across the whole database (every replica shares one queue). A status
  with no jobs is left out, so an idle instance answers `"jobs": {}`. Finished jobs are deleted, so the only statuses
  are `pending` (waiting, including retries that back off), `running` and `dead`. A failing job retries with
  exponential backoff and is `dead` after its last attempt (eight by default, about ten minutes of retries).

Alert on:

| Condition                                                         | Likely cause                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Not `200`, or no answer within a few seconds, two checks in a row | Database down or unreachable, the process crashed, or a migration failed at start (see the logs).                                              |
| `jobs.dead` above 0                                               | A job gave up: email, webhook deliveries, integrations, push or imports. **Instance admin → Jobs** shows the error; retry or discard it there. |
| `jobs.pending` that keeps growing for 15 minutes or more          | Jobs aren't being worked on: every replica is stuck or overloaded, or one kind of job fails over and over.                                     |

`/api/health` doesn't check email, storage or the secret key: **Instance admin → Overview** does (see
[admin.md](admin.md)), and a key that's set but _wrong_ passes there too. Watch the logs as well: in production they're
JSON lines on stdout, and `"level":50` (error) lines such as `job died` or `Encrypted with an unknown key` are worth an
alert. `make logs` shows them with Docker, `journalctl -u ordo` with systemd.

Example probes:

```bash
curl -fsS --max-time 5 https://ordo.example.com/api/health | jq -e '(.jobs.dead // 0) == 0'
```

```yaml
# A Gatus endpoint: status and body
endpoints:
  - name: ordo
    url: https://ordo.example.com/api/health
    interval: 1m
    conditions: ["[STATUS] == 200", "[BODY].ok == true", "[RESPONSE_TIME] < 5000"]
```

## Running without Docker

The production build is plain files: one bundled `server.mjs` that needs no `node_modules`, the SQL migrations and the
web app. Any machine with Node.js and access to Postgres can run it.

**Requirements:** Node.js 24 or newer (`engines` in `package.json`; the Docker image uses Node 26), Postgres 13 or
newer (see [external Postgres](configuration.md#using-an-external-postgres)), and, to build, pnpm 12.

**Build** on any machine (it can be a different one from the server):

```bash
git clone <repo-url> ordo && cd ordo
pnpm install --frozen-lockfile
pnpm build
```

**Assemble a release directory** with exactly what the image contains (this is what `make check-bundle` boots):

```bash
rel=/opt/ordo/releases/$(git rev-parse --short HEAD)
mkdir -p "$rel/public/cli"
cp apps/api/dist/server.mjs apps/api/dist/cli.mjs apps/api/dist/seed.mjs apps/api/package.json "$rel/"
cp -r apps/api/dist/pkg "$rel/pkg"           # Matrix encryption's WebAssembly
cp -r apps/api/drizzle "$rel/drizzle"        # migrations
cp -r apps/web/dist/. "$rel/public/"         # the web app
cp packages/cli/dist/ordo.mjs "$rel/public/cli/ordo.mjs"
ln -sfn "$rel" /opt/ordo/current
```

`package.json` is only read for the version number. The `.map` files next to the bundles are optional; keep them for
readable stack traces with `--enable-source-maps`.

**Configure** it in an environment file, e.g. `/etc/ordo/ordo.env` (mode `600`, owned by root). The Docker image sets
the first block for you; everything else is the same as in [configuration](configuration.md).

```bash
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
ORDO_STATIC_DIR=/opt/ordo/current/public
ORDO_MIGRATIONS_DIR=/opt/ordo/current/drizzle
ORDO_DATA_DIR=/var/lib/ordo

DATABASE_URL=postgres://ordo:…@localhost:5432/ordo
ORDO_PUBLIC_URL=https://ordo.example.com
# head -c 32 /dev/urandom | base64 — back it up with the database.
ORDO_SECRET_KEY=…
```

Keep `NODE_ENV=production`: without it the bundle looks for the development log formatter, which isn't in it, and
falls back to an insecure built-in key when `ORDO_SECRET_KEY` is empty. Without `ORDO_STATIC_DIR` it serves only the
API.

**Migrations** run when `server.mjs` starts, inside a transaction: on a fresh database it creates every table, on an
update it applies the new ones. If one fails, the process logs the error and exits with status 1, and the database is
left as it was. There's no separate migrate command; `node cli.mjs` runs them too. With several instances, start one
on the new version first and the others once it's up, so they don't race to apply the same migration.

**A systemd unit**, `/etc/systemd/system/ordo.service`:

```ini
[Unit]
Description=Ordo
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=ordo
Group=ordo
WorkingDirectory=/opt/ordo/current
EnvironmentFile=/etc/ordo/ordo.env
ExecStart=/usr/bin/node --enable-source-maps server.mjs
Restart=on-failure
RestartSec=5
# Ordo writes only to ORDO_DATA_DIR.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/ordo

[Install]
WantedBy=multi-user.target
```

```bash
useradd --system --home /var/lib/ordo --shell /usr/sbin/nologin ordo
install -d -o ordo -g ordo /var/lib/ordo
systemctl daemon-reload && systemctl enable --now ordo
journalctl -u ordo -f                    # "Ordo 0.1.0 ready on https://ordo.example.com"
```

It stops cleanly on `SIGTERM`. Put a reverse proxy in front as in
[HTTPS and reverse proxies](#https-and-reverse-proxies).

**The `make` targets** have plain equivalents:

| Docker                           | Without Docker                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `make update`                    | Build, assemble a new release directory, point `current` at it, `systemctl restart ordo`                                                                     |
| `make backup`                    | `pg_dump --clean --if-exists "$DATABASE_URL" \| gzip > ordo.sql.gz` with `set -o pipefail` and `tar -C /var/lib/ordo -czf ordo.uploads.tar.gz .`             |
| `make restore FILE=…`            | `gunzip -c ordo.sql.gz \| psql -q -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL"` with the service stopped; unpack the uploads only if it succeeded |
| `make admin EMAIL=…` and friends | `node cli.mjs promote-admin you@example.com` with the service's environment, see below                                                                       |
| `make seed`                      | `node seed.mjs` the same way (demo data; not on a production instance)                                                                                       |

`systemd-run` runs a command with the service's user, directory and environment file, read the way the service reads
it:

```bash
systemd-run --pipe --wait -p User=ordo -p WorkingDirectory=/opt/ordo/current \
  -p EnvironmentFile=/etc/ordo/ordo.env /usr/bin/node cli.mjs promote-admin you@example.com
```

The commands are in [admin.md](admin.md#recovery-from-the-command-line).

To roll back, point `current` at the previous release and restart, but only if the newer one added no migrations;
otherwise restore the backup you took before updating.

## Security notes

- The first account created on an instance is its **instance admin**.
- Every sign-in, failed sign-in, password change, API key, invite, role and team change is written to an audit log.
- Outbound requests to URLs an admin enters (SSO, webhooks, integrations) refuse private and loopback addresses unless
  `ORDO_ALLOW_PRIVATE_NETWORK_TARGETS` is on.
- Keep `ORDO_SIGNUP_MODE=invite` on public instances. To let someone in without adding them to a workspace, send a
  site invite from **Instance admin → Invites** (see [admin.md](admin.md)).
- Passwords are hashed with scrypt; session tokens and API keys are stored as SHA-256 hashes.
- Login, sign-up, password reset and 2FA steps are rate-limited per IP (20/min).
- Users can turn on TOTP two-factor authentication (with single-use recovery codes); TOTP secrets are encrypted.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `ORDO_PUBLIC_URL` is HTTPS.
- Workspaces can use their own OpenID Connect or SAML provider and require it; see [SSO](sso.md).
- The container runs as the unprivileged `node` user.

## Troubleshooting

| Symptom                                                                                    | Fix                                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `set POSTGRES_PASSWORD in .env`                                                            | Create `.env` (`make up` does it) or set the variable.                                                      |
| Port 3000 already in use                                                                   | Set `ORDO_PORT` in `.env`.                                                                                  |
| Sidebar says **offline**                                                                   | Your proxy isn't forwarding WebSocket upgrades on `/api/ws`.                                                |
| Invite links point at `localhost`                                                          | Set `ORDO_PUBLIC_URL`.                                                                                      |
| Logged out right after logging in over plain HTTP                                          | `ORDO_PUBLIC_URL` is `https://` but you're using `http://`; fix one of them.                                |
| App container restarts                                                                     | `make logs` — usually the database is unreachable or a migration failed.                                    |
| `The operation was aborted due to timeout` connecting an MCP client, SSO or an integration | The server can't reach the internet directly: set `HTTPS_PROXY` (and `NO_PROXY`) in `.env`, then `make up`. |
| `Encrypted with an unknown key` in the logs, or the Overview's secret key check fails      | `ORDO_SECRET_KEY` isn't the key the secrets were stored with; see below.                                    |
| `ORDO_SECRET_KEY is not set` at start, profile pictures are gone                           | No key; see below.                                                                                          |

### Missing or wrong secret key

`ORDO_SECRET_KEY` encrypts every secret Ordo stores: authenticator (TOTP) secrets for two-factor sign-in, SSO client
secrets, SMTP and AI settings saved in the admin area, workspace AI keys, integration tokens, webhook signing secrets,
import credentials, Matrix encryption state, invite links and the push notification keys. It also signs the
short-lived links to profile pictures and workspace logos. Everything else (issues, accounts, passwords, API keys,
recovery codes, passkeys, attachments) doesn't depend on it.

**Missing.** With Docker Compose the app doesn't start at all (`Run make update to add ORDO_SECRET_KEY to .env`), and
`make up` or `make update` generates a key when `.env` has none. That's right for a new install, but after a restore
it's the _wrong_ key (below): if the instance had a key before, put **that** key back. Without Docker, Ordo starts
with an empty `ORDO_SECRET_KEY` and logs `ORDO_SECRET_KEY is not set: storing secrets (SSO, integrations) is
disabled`; **Instance admin → Overview** shows the secret key check failing. Profile pictures and logos don't show,
saving any secret fails with `ORDO_SECRET_KEY is not set, so secrets cannot be stored`, push notifications fail, and
secrets stored earlier can't be read, as with a wrong key.

**Wrong** (a different key from the one the secrets were stored with: a new `.env` on a new host, a regenerated key,
a typo, or `ORDO_SECRET_KEY_PREVIOUS` removed before `rotate-key` moved everything to the new key). The Overview's
secret key check fails with the number of stored secrets that can't be decrypted. The logs show errors with
`Encrypted with an unknown key (is ORDO_SECRET_KEY_PREVIOUS set?)`, and:

- people with an authenticator app can't finish signing in with a code (recovery codes and passkeys still work);
- OpenID Connect single sign-on fails (SAML doesn't use a stored secret and keeps working);
- **Admin → Settings** marks a saved SMTP URL or AI key as unreadable, and email stops (jobs end up `dead`);
- webhook deliveries, integrations (forges, Slack, Matrix…), workspace AI and running imports fail;
- push notifications fail, and turning them on fails too;
- pending invites can't be copied (the links still open); resending one emails a new link.

After changing either variable, run `make up` with Docker (`make restart` keeps the old environment) or
`systemctl restart ordo`.

**Recover with the old key.** Find it in an older `.env`, your backups or your secret store, and choose one:

- put it back as `ORDO_SECRET_KEY`; or
- keep the new key and set the old one as `ORDO_SECRET_KEY_PREVIOUS`, which is a
  [key rotation](admin.md#rotating-the-secret-key): secrets saved under either key work again, and `rotate-key`
  moves them all to the new key.

**Recover without it.** The stored secrets are gone for good. Make sure a key is set
(`head -c 32 /dev/urandom | base64`), keep a copy with your backups, and enter the secrets again. `rotate-key` lists
the ones it can't decrypt:

| What                         | How                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-factor (authenticator)   | People sign in with a recovery code or passkey and set up the app again, or `node cli.mjs disable-2fa <email>` ([admin.md](admin.md#recovery-from-the-command-line)). |
| SMTP and the instance AI key | Enter them again in **Admin → Settings** (it marks them as unreadable), or set `ORDO_SMTP_URL`.                                                                       |
| SSO (OpenID Connect)         | Workspace admins enter the client secret again under **Settings → Authentication**.                                                                                   |
| Integrations                 | Reconnect them, or enter their tokens again, in the workspace's integration settings.                                                                                 |
| Webhooks                     | **Rotate the secret** on each webhook and give the new one to its receiver.                                                                                           |
| Workspace AI keys            | Workspace admins enter them again.                                                                                                                                    |
| Push notifications           | `delete from instance_keys where key = 'vapid';` in `make psql`; Ordo makes new keys, and people turn notifications on again on each device.                          |
| Imports                      | Start them again.                                                                                                                                                     |
| Invite links                 | Links already sent keep working. To copy one again, **Resend** the invite: it emails a new link and the old one stops working.                                        |
