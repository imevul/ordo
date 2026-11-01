# GitHub

Two ways to connect: the **GitHub App** (recommended when GitHub can reach your Ordo) or a **personal access
token** (works anywhere, including behind NAT with polling).

## GitHub App

An instance admin creates the app once; afterwards workspace admins connect it. The app is public, so it can be
installed on any GitHub account or organisation, and several Ordo workspaces can share one installation.

1. **Settings → Integrations → GitHub → Connect → GitHub App → Create the GitHub App.** Optionally name the
   GitHub organisation that should own it. GitHub shows the app it's about to create (from Ordo's manifest:
   read access to code, metadata, checks and commit statuses, read & write to pull requests, events for pull
   requests, reviews, pushes, check suites and statuses); confirm it.
2. GitHub sends you straight on to install it: choose the account and repositories.
3. GitHub asks you to authorise the app once. That's how Ordo checks your GitHub account can access the
   installation you just made, so nobody can connect someone else's.
4. You land back in Ordo with GitHub connected.

After that, **Connect GitHub** signs you in to GitHub and looks at the installations of the app your account can
see. If there's one, it's connected straight away; if there are several, you pick one; if there are none, GitHub
asks you to install the app. **Install … on another GitHub account** goes straight to installing it somewhere new.
Installing the app doesn't connect anything by itself. Only a workspace admin whose GitHub account can access the
installation can connect it.

**Sharing an installation.** Two workspaces can connect the same installation: each gets its own integration, and
events from GitHub go to both. By default a workspace uses every repository the installation can see. Under the
integration's settings, **Repositories** narrows that to some of them (`owner/name`, one per line). The workspace
then ignores events from the other repositories, and its access token only reaches the ones listed. Narrow the
repositories when the workspaces share team keys: otherwise a pull request that mentions `ENG-12` links to `ENG-12`
in both. Disconnecting GitHub in one workspace leaves the installation and the other workspaces alone.

**Apps created before 1 November 2026** are private, so they can only be installed on the account that owns them.
To install one elsewhere, its owner makes it public on GitHub: Settings → Developer settings → GitHub Apps → the
app → **Advanced → Make public**. In the same settings, also turn on **Redirect on update** under **Post
installation**, so changing an installation on GitHub brings you back to Ordo.

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
