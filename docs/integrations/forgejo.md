# Forgejo, Gitea and Codeberg

1. Create an access token (**Settings → Applications**) with read access to repositories and issues, and write
   access to repositories if Ordo should add webhooks or comment on pull requests.
2. **Settings → Integrations → Forgejo / Gitea → Connect**: the server URL (e.g. `https://codeberg.org`), the
   token, and repositories as `owner/name`, one per line.
3. Pick **Webhooks** (Ordo adds a repository webhook, signed with a secret) or **Polling** when the forge can't reach
   Ordo.

Forgejo and Gitea refuse to send webhooks to private addresses unless `[webhook] ALLOWED_HOST_LIST` allows them; for
an Ordo on your LAN, add its address there or use polling.

Pull requests titled `WIP: …` or `Draft: …` count as drafts on servers without native draft PRs.
