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
and integration secrets — a database restored without its key loses those secrets, everything else still works).
`make backup` covers the first two: it writes `backups/ordo-<timestamp>.sql.gz` and, for local storage,
`backups/ordo-<timestamp>.uploads.tar.gz`. With S3 storage, back up the bucket with your provider's tools.

```bash
make backup                                   # → backups/ordo-20260131-120000.sql.gz
make restore FILE=backups/ordo-20260131-120000.sql.gz
```

Backups are plain `pg_dump` SQL files (with `DROP … IF EXISTS`), so a restore replaces the current data; the
matching uploads archive is restored too when it sits next to the SQL file. Copy
the `backups/` directory off the machine. A simple cron entry:

```cron
0 3 * * * cd /opt/ordo && make backup >/dev/null && find backups -name '*.sql.gz' -mtime +14 -delete
```

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
