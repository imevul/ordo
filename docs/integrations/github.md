# GitHub

Two ways to connect: the **GitHub App** (recommended when GitHub can reach your Ordo) or a **personal access
token** (works anywhere, including behind NAT with polling).

## GitHub App

An instance admin creates the app once; afterwards workspace admins install it.

1. **Settings → Integrations → GitHub → Connect → GitHub App → Create the GitHub App.** Optionally name the
   GitHub organisation that should own it. GitHub shows the app it's about to create (from Ordo's manifest:
   read access to code and metadata, read & write to pull requests, events for pull requests, reviews and pushes);
   confirm it.
2. GitHub sends you straight on to install it: choose the account and repositories.
3. You land back in Ordo with GitHub connected.

Other workspaces on the same instance use **Install … on GitHub** to add their own installation. The app is private,
so it can only be installed on the account that owns it; create it under the organisation your teams use.

The app receives events at `https://<ordo>/api/hooks/github/app-<id>`, signed with its webhook secret. Uninstalling
or suspending it on GitHub switches the integration off in Ordo.

**GitHub Enterprise Server:** set `ORDO_GITHUB_URL=https://github.example.com` and
`ORDO_GITHUB_API_URL=https://github.example.com/api/v3` before creating the app.

## Personal access token

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for the repositories, with
   **Pull requests: read**, **Contents: read**, and **Webhooks: read and write** (only for webhook delivery).
   Add **Pull requests: write** if you want Ordo to comment on PRs.
2. **Settings → Integrations → GitHub → Connect → Access token**: paste the token and list repositories
   (`owner/name`, one per line).
3. Pick **Webhooks** if GitHub can reach Ordo — Ordo adds a webhook to each repository and removes it when you
   disconnect — or **Polling** if it can't.

For GitHub Enterprise Server, set the API URL (`https://host/api/v3`) and web URL in the form.

## Troubleshooting

- The integration shows **error** with the message GitHub returned — often a token without access to a repository,
  or missing webhook permission. Fix it and save the settings again; Ordo retries the setup.
- Webhook deliveries are visible on GitHub under the repository's (or app's) **Webhooks → Recent deliveries**. A
  `401` means the signature didn't match (the webhook secret changed); a `404` means the integration was removed
  or switched off.
