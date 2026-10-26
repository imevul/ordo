# GitLab

Works with GitLab.com and self-managed GitLab.

1. Create an access token with the **api** scope: a personal token, or a group or project access token with the
   Maintainer role (needed to add webhooks).
2. **Settings → Integrations → GitLab → Connect**: the GitLab URL (`https://gitlab.com` or yours), the token, and
   the projects as `group/project` paths, one per line.
3. Pick **Webhooks** (Ordo adds a project webhook for merge request and push events, authenticated with a secret
   token) or **Polling** when GitLab can't reach Ordo.

Merge requests map to pull requests: drafts are drafts, MRs with reviewers are "in review", merged is merged.

GitLab's merge request webhooks only name the author when the MR is opened; Ordo keeps that author afterwards.

Self-managed GitLab blocks webhooks to private addresses by default; if Ordo is on your LAN, allow it under
**Admin → Settings → Network → Outbound requests**, or use polling.
