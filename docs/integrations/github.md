# GitHub

Two ways to connect: the **GitHub App** (recommended when GitHub can reach your Ordo) or a **personal access
token** (works anywhere, including behind NAT with polling).

## GitHub App

An instance admin creates the app once; afterwards workspace admins install it.

1. **Settings → Integrations → GitHub → Connect → GitHub App → Create the GitHub App.** Optionally name the
   GitHub organisation that should own it. GitHub shows the app it's about to create (from Ordo's manifest:
   read access to code, metadata, checks and commit statuses, read & write to pull requests, events for pull
   requests, reviews, pushes, check suites and statuses); confirm it.
2. GitHub sends you straight on to install it: choose the account and repositories.
3. GitHub asks you to authorise the app once. That's how Ordo checks your GitHub account can access the
   installation you just made, so nobody can connect someone else's.
4. You land back in Ordo with GitHub connected.

Other workspaces on the same instance use **Install … on GitHub** to add their own installation. An installation
belongs to one workspace. The app is private, so it can only be installed on the account that owns it; create it
under the organisation your teams use, or make it public (GitHub → the app → Advanced) to install it on several
accounts. Installing it doesn't connect anything by itself: only a workspace admin who can access the installation
can.

**Apps created before 30 October 2026** don't have the authorisation callback yet. Add
`https://<ordo>/api/integrations/github/authorized` under the app's **Callback URL** on GitHub (Settings → Developer
settings → GitHub Apps → the app), or installing fails with GitHub's "redirect_uri is not associated" page.

**Apps created before checks were shown on issues** don't send them. On GitHub, open the app's settings → **Permissions
& events**, give it **Checks: read** and **Commit statuses: read**, and subscribe to **Check suite** and **Status**.
GitHub then asks each installation's owner to accept the new permissions (an email and a banner on the installation
page); until they do, issues show pull requests without checks.

The app receives events at `https://<ordo>/api/hooks/github/app-<id>`, signed with its webhook secret. Uninstalling
or suspending it on GitHub switches the integration off in Ordo.

**GitHub Enterprise Server:** set `ORDO_GITHUB_URL=https://github.example.com` and
`ORDO_GITHUB_API_URL=https://github.example.com/api/v3` before creating the app.

## Personal access token

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for the repositories, with
   **Pull requests: read**, **Contents: read**, **Checks: read**, **Commit statuses: read**, and **Webhooks: read
   and write** (only for webhook delivery). Add **Pull requests: write** if you want Ordo to comment on PRs.
2. **Settings → Integrations → GitHub → Connect → Access token**: paste the token and list repositories
   (`owner/name`, one per line).
3. Pick **Webhooks** if GitHub can reach Ordo — Ordo adds a webhook to each repository and removes it when you
   disconnect — or **Polling** if it can't.

Saving the settings again updates existing repository webhooks to the events Ordo listens for now. With polling,
Ordo follows pull request states but not checks or reviews.

For GitHub Enterprise Server, set the API URL (`https://host/api/v3`) and web URL in the form.

## Troubleshooting

- The integration shows **error** with the message GitHub returned — often a token without access to a repository,
  or missing webhook permission. Fix it and save the settings again; Ordo retries the setup.
- Webhook deliveries are visible on GitHub under the repository's (or app's) **Webhooks → Recent deliveries**. A
  `401` means the signature didn't match (the webhook secret changed); a `404` means the integration was removed
  or switched off.
