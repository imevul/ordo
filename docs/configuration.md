# Configuration

Ordo reads its configuration from environment variables. With Docker Compose they come from `.env` in the
repository root (created from `.env.example` by `make up`).

## Compose variables (`.env`)

| Variable                     | Default                 | Description                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ORDO_PORT`                  | `3000`                  | Host port Ordo is published on.                                                                                                                                                                                                                                                                        |
| `ORDO_BIND`                  | `0.0.0.0`               | Host interface to bind. Use `127.0.0.1` when a reverse proxy runs on the same host.                                                                                                                                                                                                                    |
| `ORDO_PUBLIC_URL`            | `http://localhost:3000` | The URL people use to reach Ordo. Used for invite links. An `https://` URL turns on `Secure` cookies. Passkeys belong to its hostname: they work only at this address (https, or localhost), and changing the hostname later leaves existing passkeys behind.                                          |
| `ORDO_SECRET_KEY`            | generated               | Encrypts secrets Ordo stores (SSO client secrets, integration tokens). `make up` / `make update` generate it. **Back it up with your database**: without it, stored secrets can't be decrypted.                                                                                                        |
| `ORDO_SECRET_KEY_PREVIOUS`   | empty                   | During a [key rotation](admin.md#rotating-the-secret-key), the old key; values encrypted with it still decrypt.                                                                                                                                                                                        |
| `POSTGRES_USER`              | `ordo`                  | Database user for the bundled Postgres.                                                                                                                                                                                                                                                                |
| `POSTGRES_PASSWORD`          | random                  | Database password. `make up` generates one if `.env` doesn't exist. **Required.**                                                                                                                                                                                                                      |
| `POSTGRES_DB`                | `ordo`                  | Database name.                                                                                                                                                                                                                                                                                         |
| `DATABASE_POOL_SIZE`         | `10`                    | Max connections per API instance (one more is used for `LISTEN`).                                                                                                                                                                                                                                      |
| `ORDO_TRUST_PROXY`           | `true`                  | How many reverse proxies to believe about the client IP (rate limits, audit log): `true` is one, a number is that many, or a comma-separated list of proxy addresses/CIDRs. Hops are only believed when the connecting peer is on a private network. Set `false` when Ordo is exposed without a proxy. |
| `LOG_LEVEL`                  | `info`                  | `fatal`, `error`, `warn`, `info`, `debug` or `trace`.                                                                                                                                                                                                                                                  |
| `ORDO_VERSION`               | `latest`                | Tag used for the locally built image.                                                                                                                                                                                                                                                                  |
| `HTTPS_PROXY` / `HTTP_PROXY` | empty                   | Outgoing proxy, for the image build and everything Ordo fetches (OAuth app metadata for MCP clients, SSO, webhooks, integrations, AI, push). Credentials go in the URL. Lowercase names and `ALL_PROXY` work too.                                                                                      |
| `NO_PROXY`                   | empty                   | Hosts that skip the proxy: comma-separated hosts or domains (`example.com` covers subdomains), `host:port`, or `*`. Loopback always goes direct.                                                                                                                                                       |

Behind a proxy, Ordo still refuses private addresses (unless `ORDO_ALLOW_PRIVATE_NETWORK_TARGETS` is on): it resolves
the host itself before handing the request to the proxy, and refuses hosts it can't resolve.

## Instance settings

These can be changed by an instance admin in the app. Leave the variable empty to manage a setting there;
setting it pins the value and shows it as locked in the UI. Precedence: environment → stored value → default.

| Variable                             | Default  | Description                                                                                                                                                                                                                                                                 |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDO_SIGNUP_MODE`                   | `invite` | `invite`: only people with an invite link can create accounts (the very first user always can, and becomes the instance admin). `open`: anyone who can reach the instance can sign up.                                                                                      |
| `ORDO_ALLOW_WORKSPACE_CREATION`      | `true`   | Whether signed-in users who already belong to a workspace may create more. Users without a workspace can always create their first one.                                                                                                                                     |
| `ORDO_ALLOW_PRIVATE_NETWORK_TARGETS` | `false`  | Let outbound requests Ordo makes on an admin's behalf (SSO discovery, webhooks, forge and chat integrations) reach loopback, private and link-local addresses. Turn on when your IdP or Forgejo lives on your LAN.                                                          |
| `ORDO_MAX_ATTACHMENT_MB`             | `25`     | Largest file people can attach to issues and comments, in megabytes (1–1024). Keep your reverse proxy's request body limit above it.                                                                                                                                        |
| `ORDO_OFFLINE_SYNC`                  | `on`     | Whether browsers keep a copy of each workspace, so it opens at once and works offline: `on` (every device, unless someone turns it off on theirs), `optin` (only where someone turns it on), `off`. The copy is IndexedDB, unencrypted on disk, and is deleted at sign-out. |

## Email

Ordo sends password resets, email verification, invites, security notices and notification digests by email.
Without SMTP everything else works; those features are simply unavailable (the UI says so).

| Variable         | Default                 | Description                                                                                                                                                                                        |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDO_SMTP_URL`  | empty                   | `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465`. URL-encode special characters in the password. Leave empty to configure SMTP in the admin area instead (stored encrypted). |
| `ORDO_SMTP_FROM` | `Ordo <ordo@localhost>` | Sender, e.g. `Ordo <ordo@example.com>`.                                                                                                                                                            |

## AI assistance

Off unless set here or in _Admin → Settings_. See [AI assistance](ai.md) for what is sent to the model and when.

| Variable            | Default | Description                                                                                                                                                           |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDO_AI_PROVIDER`  | empty   | `anthropic` (the Claude API), `openai` (any OpenAI-compatible endpoint: Ollama, vLLM, LM Studio…) or `off`. Empty leaves it to the admin area.                        |
| `ORDO_AI_MODEL`     | empty   | Model name, e.g. `claude-opus-5-5` or `llama3.3`. Required with a provider.                                                                                           |
| `ORDO_AI_BASE_URL`  | empty   | For `openai`, the URL ending in `/v1` (required). For `anthropic`, only to go through a gateway.                                                                      |
| `ORDO_AI_API_KEY`   | empty   | Required for `anthropic`; optional for `openai`.                                                                                                                      |
| `ORDO_WORKSPACE_AI` | `own`   | What workspace admins may change: `own` (use their own model, or turn AI off), `instance` (only turn it off) or `locked` (every workspace uses the instance's model). |

## Uploads

Profile pictures (and, later, attachments) are stored on local disk by default — the `ordo-data` Docker volume
mounted at `/data`. Any S3-compatible object store works instead. Storage is configured by environment only:
switching backends means moving the files yourself.

| Variable                                              | Default                               | Description                                                                                                      |
| ----------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ORDO_STORAGE`                                        | `local`                               | `local` or `s3`.                                                                                                 |
| `ORDO_DATA_DIR`                                       | `/data` in the image, `./data` in dev | Root for local uploads (`<dir>/uploads`).                                                                        |
| `ORDO_S3_ENDPOINT`                                    | `https://s3.amazonaws.com`            | e.g. `http://minio:9000`, `https://<account>.r2.cloudflarestorage.com`.                                          |
| `ORDO_S3_REGION`                                      | `us-east-1`                           | Region used for signing (`auto` for R2).                                                                         |
| `ORDO_S3_BUCKET`                                      | `ordo`                                | Bucket name; it must exist.                                                                                      |
| `ORDO_S3_ACCESS_KEY_ID` / `ORDO_S3_SECRET_ACCESS_KEY` | —                                     | Credentials with get/put/delete on the bucket.                                                                   |
| `ORDO_S3_FORCE_PATH_STYLE`                            | `true`                                | Path-style URLs (`endpoint/bucket/key`); needed by MinIO and Garage. Set `false` for virtual-hosted AWS buckets. |

Files are served through Ordo with short-lived signed URLs; the bucket never needs to be public.

## Key rotation

To replace `ORDO_SECRET_KEY`, follow [Rotating the secret key](admin.md#rotating-the-secret-key) in the
administration guide.

Lost the old key, or started with the wrong one? See
[Missing or wrong secret key](self-hosting.md#missing-or-wrong-secret-key).

## Application variables

These are set by `docker-compose.yml` or the Dockerfile; you only need them when running the API yourself.

| Variable              | Default                                    | Description                                                                      |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `DATABASE_URL`        | `postgres://ordo:ordo@localhost:5433/ordo` | Postgres connection string.                                                      |
| `HOST` / `PORT`       | `0.0.0.0` / `3001` (dev), `3000` (image)   | Where the API listens.                                                           |
| `ORDO_STATIC_DIR`     | unset (dev), `/app/public` (image)         | Directory with the built web app. When set, the API serves it with SPA fallback. |
| `ORDO_MIGRATIONS_DIR` | auto-detected                              | Location of the SQL migrations.                                                  |
| `ORDO_SECURE_COOKIES` | from `ORDO_PUBLIC_URL`                     | Force `Secure` cookies on or off (`true`/`false`).                               |
| `NODE_ENV`            | `production` in the image                  | Enables JSON logs instead of pretty logs.                                        |
| `SEED_PASSWORD`       | `ordo-demo-password`                       | Password for the users created by the demo seed.                                 |

## GitHub Enterprise Server

| Variable              | Default                  | Description                                           |
| --------------------- | ------------------------ | ----------------------------------------------------- |
| `ORDO_GITHUB_URL`     | `https://github.com`     | Where the GitHub App is created and installed         |
| `ORDO_GITHUB_API_URL` | `https://api.github.com` | Its API (`https://host/api/v3` for Enterprise Server) |

Token-based GitHub integrations take these per integration instead.

## Using an external Postgres

Remove the `db` service from `docker-compose.yml` (or use an override file) and set `DATABASE_URL` for the
`app` service. Ordo needs Postgres 13 or newer (it uses `gen_random_uuid()`); 18 is what we test against. The
database user must be able to create tables — migrations run on every start.
