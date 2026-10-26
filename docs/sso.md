# Single sign-on (OpenID Connect)

Each workspace can bring its own identity provider. Anything that speaks OpenID Connect works: Keycloak, Authentik,
Authelia, Zitadel, Microsoft Entra ID, Google Workspace, Okta, Dex, GitLab, Forgejo/Gitea…

## Before you start

1. **Verify your email domain** under **Settings → Security → Domains** (a DNS TXT record, or ask an instance admin to
   approve it). SSO only creates accounts, or matches existing ones by email, for _verified_ addresses at _verified_
   domains. This stops a misconfigured provider from signing in as someone else.
2. Make sure `ORDO_PUBLIC_URL` is the address people use, and `ORDO_SECRET_KEY` is set (`make up` does this).
3. If your provider lives on your LAN (e.g. `http://keycloak.lan`), an instance admin has to turn on **Allow private
   network targets** (Admin → Settings), or set `ORDO_ALLOW_PRIVATE_NETWORK_TARGETS=true`. Plain-`http` issuers only
   work with that setting on.

## Add the provider

1. Open **Settings → Authentication** and copy the **redirect URI**: `https://<your Ordo>/api/auth/oidc/callback`.
2. In your provider, create a **confidential** web client ("OIDC client", "web application") with that redirect URI.
   It needs the `openid email profile` scopes and must put `email` and `email_verified` in the ID token or the
   userinfo response.
3. Back in Ordo, **Add provider**: a display name ("Continue with …"), the **issuer URL** (Ordo reads
   `<issuer>/.well-known/openid-configuration`), client ID and client secret. The secret is encrypted at rest and never
   shown again.
4. Press **Test**. You go through your provider and land on a page showing the claims Ordo received, without signing
   anyone in. Check for `sub`, `email`, `email_verified: true`, and your group claim if you use one.

| Provider  | Issuer URL                                           |
| --------- | ---------------------------------------------------- |
| Keycloak  | `https://id.example.com/realms/<realm>`              |
| Authentik | `https://auth.example.com/application/o/<app-slug>/` |
| Entra ID  | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Google    | `https://accounts.google.com`                        |
| Okta      | `https://<org>.okta.com`                             |
| GitLab    | `https://gitlab.example.com`                         |
| Forgejo   | `https://code.example.com`                           |

Entra ID doesn't send `email_verified`; people there link their identity once from their account settings instead
of being matched automatically.

## How people sign in

- On the sign-in page, typing an address at a verified domain shows **Continue with <provider>**. Links like
  `/login?workspace=<slug>` show the workspace's providers straight away.
- **First sign-in:** if the address is verified and its domain is verified for your workspace, Ordo creates the
  account (or matches the existing one with that address) and adds it to the workspace with the provider's default
  role (member or guest).
- **Anyone else** (other domains, unverified addresses, existing accounts with a different address) links the identity
  themselves: sign in as usual, then **Settings → Security → Connected accounts → Connect**.
- People can unlink identities, except their only way to sign in.

## Groups → roles

Set a **group claim** (often `groups`) and map groups to roles, one per line:

```text
ordo-admins = admin
contractors = guest
```

The highest matching role is applied at **every** sign-in, so changes in your directory reach Ordo the next time
someone signs in. Owners are never changed, and people with no matching group keep their role.

## Require SSO

Under **Enforcement**:

- **Require SSO** — sessions that didn't come from one of this workspace's providers can't open it (web and realtime).
  People with a password session see a "Continue with …" screen. **Owners** can still use their password as a
  break-glass, so a broken provider can't lock you out; every such sign-in is written to the audit log
  (`auth.sso_bypass`).
- **SSO session length** — how long an SSO session lasts before people go back through the provider (8 hours to 30
  days). Unset, SSO sessions behave like any other (30 days, sliding).
- **Allow API keys** — when SSO is required, personal API keys are refused unless this is on.

Removing someone in your provider doesn't remove them from Ordo; they can't sign in again once their SSO session ends.
Suspend or remove them under **Settings → Members** to cut access straight away.

## Troubleshooting

- **"This sign-in isn't linked to an Ordo account"** — the domain isn't verified for this workspace, or the provider
  sent `email_verified: false` (or nothing). Verify the domain, or have the person connect the identity from their
  settings.
- **"Couldn't reach …"** — Ordo couldn't load the discovery document. Check the issuer URL from the Ordo host
  (`curl <issuer>/.well-known/openid-configuration`), and the private-network setting for LAN providers.
- **`unexpected JWT claim value encountered`** — usually an issuer mismatch: the issuer URL in Ordo must match the
  `iss` your provider puts in tokens exactly (watch trailing slashes and `http` vs `https` behind proxies).
- **"expired or came from another browser"** — the sign-in took longer than 10 minutes, or started on another
  address than `ORDO_PUBLIC_URL`.
