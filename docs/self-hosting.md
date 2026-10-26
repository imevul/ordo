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

Open it and sign up — the first account is the instance's first admin and is guided through creating a
workspace and its first team. Invite others from **Settings → Members**.

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

## Backups

```bash
make backup                                   # → backups/ordo-20260131-120000.sql.gz
make restore FILE=backups/ordo-20260131-120000.sql.gz
```

Backups are plain `pg_dump` SQL files (with `DROP … IF EXISTS`), so a restore replaces the current data. Copy
the `backups/` directory off the machine. A simple cron entry:

```cron
0 3 * * * cd /opt/ordo && make backup >/dev/null && find backups -name '*.sql.gz' -mtime +14 -delete
```

## HTTPS and reverse proxies

Run Ordo behind a TLS-terminating proxy and set `ORDO_PUBLIC_URL=https://ordo.example.com` in `.env` (then
`make up` again). Bind the app to localhost with `ORDO_BIND=127.0.0.1` if the proxy runs on the same host. The
proxy must forward WebSocket upgrades for `/api/ws`.

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

    client_max_body_size 10m;

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

- Keep `ORDO_SIGNUP_MODE=invite` on public instances.
- Passwords are hashed with scrypt; session tokens and API keys are stored as SHA-256 hashes.
- Login and sign-up are rate-limited per IP (20/min).
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `ORDO_PUBLIC_URL` is HTTPS.
- The container runs as the unprivileged `node` user.

## Troubleshooting

| Symptom                                           | Fix                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `set POSTGRES_PASSWORD in .env`                   | Create `.env` (`make up` does it) or set the variable.                       |
| Port 3000 already in use                          | Set `ORDO_PORT` in `.env`.                                                   |
| Sidebar says **offline**                          | Your proxy isn't forwarding WebSocket upgrades on `/api/ws`.                 |
| Invite links point at `localhost`                 | Set `ORDO_PUBLIC_URL`.                                                       |
| Logged out right after logging in over plain HTTP | `ORDO_PUBLIC_URL` is `https://` but you're using `http://`; fix one of them. |
| App container restarts                            | `make logs` — usually the database is unreachable or a migration failed.     |
