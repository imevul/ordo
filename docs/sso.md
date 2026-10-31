# Single sign-on (OpenID Connect and SAML)

Each workspace can bring its own identity provider. Anything that speaks OpenID Connect works: Keycloak, Authentik,
Authelia, Zitadel, Microsoft Entra ID, Google Workspace, Okta, Dex, GitLab, Forgejo/Gitea… Providers that only speak
SAML 2.0 (ADFS, older Okta and Entra apps, Shibboleth) work too: see [SAML 2.0](#saml-20). Prefer OpenID Connect
when your provider offers both; it's simpler to set up.

## Before you start

1. **Verify your email domain** under **Settings → Access → Domains** (a DNS TXT record, or ask an instance admin to
   approve it). SSO only creates accounts, or matches existing ones by email, for _verified_ addresses at _verified_
   domains. This stops a misconfigured provider from signing in as someone else.
2. Make sure `ORDO_PUBLIC_URL` is the address people use, and `ORDO_SECRET_KEY` is set (`make up` does this).
3. If your provider lives on your LAN (e.g. `http://keycloak.lan`), an instance admin has to turn on **Allow private
   network targets** (Admin → Settings), or set `ORDO_ALLOW_PRIVATE_NETWORK_TARGETS=true`. Plain-`http` issuers only
   work with that setting on.
4. **Check that existing accounts have verified their address.** SSO matches only accounts that have. If one that
   hasn't has been used (it belongs to a workspace or team, or has issues, comments or uploads), SSO sign-in at that
   address is refused until the address is verified, and the refusal shows in the audit log. Without mail, sign-up
   never verifies anyone, so on such an instance this hits every existing password user. Admin → Users marks
   unverified addresses: send each of those people a **password reset link** first. Setting a password from the
   link verifies the address.

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

## SAML 2.0

1. **Settings → Authentication → Add provider → SAML 2.0.** The dialog shows three addresses for your identity
   provider (they're fixed for this provider):
   - **Entity ID** (also called audience or SP identifier): `https://<your Ordo>/api/auth/saml/<id>/metadata`
   - **ACS URL** (reply URL, single sign-on URL): `https://<your Ordo>/api/auth/saml/<id>/acs`
   - **Metadata URL**, the same as the entity ID, for providers that import service provider metadata.
2. In your provider, create a SAML application with those, **signed assertions**, and a **persistent** NameID (or
   the email address, if addresses never change in your directory). Send an `email` attribute, a display name, and
   your groups if you map them to roles.
3. Back in Ordo, paste the provider's **metadata URL or XML** and press **Read metadata**: it fills in the IdP entity
   ID, the sign-in URL and the signing certificate. You can also type them in.
4. Turn on **Trust this IdP's email addresses** if your provider controls the addresses at your verified domains.
   SAML has no `email_verified`, so without this nobody is matched or created by email: everyone links their identity
   once from **Settings → Connected accounts** instead.
5. **Test** shows the attributes Ordo received, as with OpenID Connect.

| Provider  | Where                                                                                           | NameID / attributes                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Entra ID  | Enterprise applications → New → Create your own → SAML; metadata: _App Federation Metadata Url_ | Defaults work (email claim, display name). Add a group claim if you map groups; Ordo reads its full URI as written.      |
| Okta      | Applications → Create App Integration → SAML 2.0; metadata: _Sign On → Metadata URL_            | Name ID format _Persistent_ or _EmailAddress_; attribute statements `email`, `displayName`; a group statement `groups`.  |
| Authentik | Providers → SAML Provider (ACS URL, audience = entity ID), then an application                  | NameID property mapping: _Authentik default SAML Mapping: UPN_ or _Email_; the default mappings send `email` and groups. |
| Keycloak  | Clients → Create → SAML, client ID = entity ID; metadata: `<realm>/protocol/saml/descriptor`    | Name ID format _persistent_; turn on _Sign assertions_; add mappers for `email`, `displayName` and a group list.         |

Group mappings work as below: name the **group attribute** (`groups`, or the full claim URI Entra ID uses).

What Ordo checks, so you know what your provider must get right: the assertion is signed by one of the configured
certificates; it answers the sign-in Ordo started (IdP-initiated sign-ins from an app tile are refused); its issuer,
audience, destination and recipient match; and it is current, within two minutes of clock skew. While your provider
rolls over its signing key, add the new certificate next to the old one (both are accepted), then remove the old one.
Settings → Authentication warns a month before a certificate expires.

Not supported yet: single logout, encrypted assertions, and signed AuthnRequests (Ordo's requests are unsigned, which
providers accept by default).

## How people sign in

- **Email first.** People enter their email and press **Continue**. If its domain is verified by a workspace with a
  provider, they get **Continue with <provider>** next to the password field. When that workspace requires SSO,
  the password is tucked behind "use a password instead" (owners still need it as their fallback).
- **Sign in with SSO.** For addresses outside your verified domains (or anyone who prefers it), this asks for the
  workspace URL and shows its providers. Share `/login?workspace=<slug>` to skip that step.
- After someone signs in with SSO, their browser remembers the provider (a cookie on that device only) and the
  sign-in page offers it first as "last used on this device", with a link to forget it. This is how people whose
  address isn't on a verified domain — and who linked their identity themselves — get a one-click sign-in.
- Neither lookup reveals whether someone has an account: answers depend only on the domain or the workspace.
- **First sign-in:** if the address is verified and its domain is verified for your workspace, Ordo creates the
  account (or matches the existing one with that address, if that account has verified it) and adds it to the
  workspace with the provider's default role (member or guest). An existing account that never verified the address
  isn't matched. If it's empty (not an instance admin, no memberships, issues, comments or uploads), it moves to a placeholder address and
  the person gets a fresh account, so nobody can claim an address ahead of its owner and wait for them to sign in.
  If it has been used, sign-in is refused with "verify the address first" until its owner does (a password reset
  link verifies it); then SSO links that account.
- **Anyone else** (other domains, unverified addresses, existing accounts with a different address) links the identity
  themselves: sign in as usual, then **Settings → Connected accounts → Connect**.
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
- **Allow API keys** — when SSO is required, personal API keys are refused unless this is on. That includes AI
  agents connected through the [MCP server](mcp.md).

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
- **SAML: "audience mismatch", "Wrong Destination" or "Wrong or missing Recipient"** — the entity ID or ACS URL in your
  provider doesn't match the ones Ordo shows; copy them again. Behind a proxy, check `ORDO_PUBLIC_URL`.
- **SAML: "Invalid signature"** — the certificate in Ordo isn't the one your provider signs with (read the metadata
  again), or your provider signs only the response and not the assertion; turn on assertion signing.
- **SAML: "InResponseTo is missing"** — the sign-in started at the provider (an app tile or dashboard) instead of at
  Ordo. Point the tile at `https://<your Ordo>/api/auth/sso/<id>/start` instead.
- **SAML: "transient NameID"** — the provider sends a NameID that changes every time; switch it to persistent.
