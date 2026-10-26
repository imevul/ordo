# Configuration

Ordo reads its configuration from environment variables. With Docker Compose they come from `.env` in the
repository root (created from `.env.example` by `make up`).

## Compose variables (`.env`)

| Variable                        | Default                 | Description                                                                                                                                                       |
| ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDO_PORT`                     | `3000`                  | Host port Ordo is published on.                                                                                                                                   |
| `ORDO_BIND`                     | `0.0.0.0`               | Host interface to bind. Use `127.0.0.1` when a reverse proxy runs on the same host.                                                                               |
| `ORDO_PUBLIC_URL`               | `http://localhost:3000` | The URL people use to reach Ordo. Used for invite links. An `https://` URL turns on `Secure` cookies.                                                             |
| `ORDO_SIGNUP_MODE`              | `invite`                | `invite`: only people with an invite link can create accounts (the very first user always can). `open`: anyone who can reach the instance can sign up.            |
| `ORDO_ALLOW_WORKSPACE_CREATION` | `true`                  | Whether signed-in users who already belong to a workspace may create more. Users without a workspace can always create their first one.                           |
| `POSTGRES_USER`                 | `ordo`                  | Database user for the bundled Postgres.                                                                                                                           |
| `POSTGRES_PASSWORD`             | random                  | Database password. `make up` generates one if `.env` doesn't exist. **Required.**                                                                                 |
| `POSTGRES_DB`                   | `ordo`                  | Database name.                                                                                                                                                    |
| `ORDO_TRUST_PROXY`              | `true`                  | Trust `X-Forwarded-*` headers for the client IP (used by rate limits). Set `false` when Ordo is exposed without a reverse proxy, so clients can't spoof their IP. |
| `LOG_LEVEL`                     | `info`                  | `fatal`, `error`, `warn`, `info`, `debug` or `trace`.                                                                                                             |
| `ORDO_VERSION`                  | `latest`                | Tag used for the locally built image.                                                                                                                             |

## Application variables

These are set by `docker-compose.yml` or the Dockerfile; you only need them when running the API yourself.

| Variable              | Default                                    | Description                                                                      |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `DATABASE_URL`        | `postgres://ordo:ordo@localhost:5433/ordo` | Postgres connection string.                                                      |
| `DATABASE_POOL_SIZE`  | `10`                                       | Max connections per API instance (one more is used for `LISTEN`).                |
| `HOST` / `PORT`       | `0.0.0.0` / `3001` (dev), `3000` (image)   | Where the API listens.                                                           |
| `ORDO_STATIC_DIR`     | unset (dev), `/app/public` (image)         | Directory with the built web app. When set, the API serves it with SPA fallback. |
| `ORDO_MIGRATIONS_DIR` | auto-detected                              | Location of the SQL migrations.                                                  |
| `ORDO_SECURE_COOKIES` | from `ORDO_PUBLIC_URL`                     | Force `Secure` cookies on or off (`true`/`false`).                               |
| `NODE_ENV`            | `production` in the image                  | Enables JSON logs instead of pretty logs.                                        |
| `SEED_PASSWORD`       | `ordo-demo-password`                       | Password for the users created by the demo seed.                                 |

## Using an external Postgres

Remove the `db` service from `docker-compose.yml` (or use an override file) and set `DATABASE_URL` for the
`app` service. Ordo needs Postgres 13 or newer (it uses `gen_random_uuid()`); 18 is what we test against. The
database user must be able to create tables — migrations run on every start.
