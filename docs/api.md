# REST API

Everything the web app does goes through this API, so anything you can click you can script. AI agents can use the
[MCP server](mcp.md) instead, which wraps the issue endpoints in tools. For scripts there's the `ordo` command
line and a TypeScript client ([cli.md](cli.md)).

- Base URL: `https://ordo.example.com/api`
- Bodies are JSON (`Content-Type: application/json`). Responses are JSON.
- Timestamps are ISO-8601 (`2026-01-31T09:00:00.000Z`); calendar dates are `YYYY-MM-DD`.
- IDs are UUIDs. Wherever an issue id is expected you can also pass its identifier (`ENG-42`).
- Request payloads are validated with the Zod schemas in
  [`packages/shared/src/schemas.ts`](../packages/shared/src/schemas.ts); response types are in
  [`packages/shared/src/types.ts`](../packages/shared/src/types.ts).

## Authentication

Create a personal key in **Settings → API keys** and send it as a bearer token. A key acts as you, with your
workspace roles.

```bash
export ORDO=https://ordo.example.com/api
export KEY=ordo_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

curl -H "Authorization: Bearer $KEY" $ORDO/auth/me
```

The browser uses an `ordo_session` cookie instead (`POST /auth/login`, or single sign-on). Workspaces that require
SSO refuse API keys unless their admins allow them.

Single sign-on is a browser flow: `GET /auth/discover?email=` and `GET /auth/providers?workspace=<slug>` return
`{ options: [{ providerId, name, workspace }], ssoRequired }`; `GET /auth/sso/:providerId/start?redirect=` sends the
browser to the provider, which returns to `GET /auth/oidc/callback` (the older `/auth/oidc/:providerId/start` still
works). SAML providers return to `POST /auth/saml/:providerId/acs`, which hands over to `GET /auth/saml/complete`;
`GET /auth/saml/:providerId/metadata` is the service provider metadata. Signed in, `GET /me/identities` lists linked identities and
`DELETE /me/identities/:id` unlinks one.

## Access

Every workspace request is answered from the caller's point of view. Issues, comments, history, projects, cycles,
labels, search results, notifications, progress counts and realtime events only cover teams the caller can see
(see roles in the [user guide](user-guide.md#workspaces-members-and-roles)). Anything outside them returns **404**,
the same as something that doesn't exist; actions the caller can see but isn't allowed to take return **403**.

## Errors

```json
{ "error": "bad_request", "message": "title: Too small: expected string to have >=1 characters", "details": [ … ] }
```

| Status | `error`        | When                                                                  |
| ------ | -------------- | --------------------------------------------------------------------- |
| 400    | `bad_request`  | Validation failed or the change isn't allowed (e.g. a sub-issue loop) |
| 401    | `unauthorized` | Missing or invalid credentials                                        |
| 403    | `forbidden`    | Authenticated, but your role doesn't allow it                         |
| 403    | `sso_required` | The workspace requires SSO; `details.options` lists its providers     |
| 404    | `not_found`    | Doesn't exist, or you're not a member of the workspace                |
| 409    | `conflict`     | Unique constraint (email, workspace URL, team key, username)          |
| 429    |                | Rate limited (auth endpoints)                                         |

`message` is always English. Common errors also carry a `messageKey` (one of `API_MESSAGE_KEYS` in
`@ordo/shared`, e.g. `wrong_credentials`, `not_found`, `admins_only`) and, when the sentence has values in it,
`params`; the web app uses them to show the error in the reader's language. Match on `error` in your code, not on
`message`.

## Instance & account

| Method     | Path                     |                                                                                                                                 |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| GET        | `/health`                | No auth. `{ ok, version, realtimeConnections, jobs }`; 500 when the database is down ([monitoring](self-hosting.md#monitoring)) |
| GET        | `/config`                | Sign-up mode, whether any users exist                                                                                           |
| POST       | `/auth/signup`           | `{ name, email, password, inviteToken? }`                                                                                       |
| POST       | `/auth/login`            | `{ email, password }` → sets cookie                                                                                             |
| POST       | `/auth/logout`           |                                                                                                                                 |
| GET        | `/auth/me`               | You, plus your workspaces and roles                                                                                             |
| PATCH      | `/me`                    | `{ name?, username?, avatarColor? }`                                                                                            |
| POST       | `/me/password`           | `{ currentPassword, newPassword }`                                                                                              |
| GET / POST | `/me/api-keys`           | List / create `{ name }` (the token is returned once)                                                                           |
| DELETE     | `/me/api-keys/:id`       | Revoke                                                                                                                          |
| POST       | `/workspaces`            | `{ name, slug, teamName?, teamKey? }` — you become admin                                                                        |
| GET        | `/invites/:token`        | Public invite info                                                                                                              |
| POST       | `/invites/:token/accept` | Join with the signed-in account                                                                                                 |

Joining by domain (no workspace prefix):

| Method | Path                   |                                                            |
| ------ | ---------------------- | ---------------------------------------------------------- |
| GET    | `/workspaces/joinable` | Workspaces you may join through your verified email domain |
| POST   | `/workspaces/:id/join` | Join one of them                                           |

Directory sync lives at `/api/scim/v2` (SCIM 2.0, authenticated with a workspace's SCIM token rather than a user):
see [scim.md](scim.md#endpoints). Workspace admins manage tokens with `GET|POST /scim/tokens` (`{ name }` → the token,
shown once) and `DELETE /scim/tokens/:id` under the workspace prefix; `GET /scim/groups` lists directory groups,
`POST /scim/groups/:id/preview` (`{ teamId }` → `{ add, remove }`) shows what linking one to a team would change, and
`PUT /scim/groups/:id/team` (`{ teamId | null }`) links or unlinks it. Teams list the groups that manage them in
`managedBy`; on those, adding or removing members by hand returns `409 team_managed`.

Account endpoints (no workspace prefix): `GET /me/account`, `PATCH /me/preferences`, `PUT|DELETE /me/status` (`{ kind,
emoji?, text?, until, pause? }` — `kind` one of `away`, `meeting`, `focus`, `dnd`, `sick`, `vacation`, or null for a
custom status; `pause` is `mentions`, `all` or null and ends with the status), `PUT /me/notify-pause` (`{ mode, until
}`; `mode: null` resumes), `POST|DELETE /me/avatar`, `POST /me/email` (sends a confirmation link to the new
address, finished with `POST /auth/confirm-email-change` `{ token }`), `POST /me/email/verify` (send the
verification email again), `GET /me/sessions`, `DELETE /me/sessions/:id`, `POST /me/sessions/revoke-others`
(sign out everywhere but this browser; sessions only), `GET /me/oauth-grants` and `DELETE /me/oauth-grants/:id`
(apps you've connected through [OAuth](mcp.md), and disconnecting one), `POST /auth/sso/:providerId/link`
(`{ redirect? }` → `{ url }`: link a sign-in method of one of your workspaces to your account),
`POST /me/2fa/setup|enable|disable|recovery-codes`, `GET /me/passkeys`, `POST /me/passkeys/options`
(`{ password? }` → `{ challengeId, options }`), `POST /me/passkeys` (`{ challengeId, response, name? }`),
`PATCH|DELETE /me/passkeys/:id`, `POST /auth/passkey/options` and `POST /auth/passkey` (`{ challengeId, response }`:
sign in without a password), `POST /auth/forgot`, `POST /auth/reset`, `POST /auth/mfa`, `POST /auth/verify-email`.
When an account has a second factor, `POST /auth/login` answers `{ ok: false, mfaRequired: true, mfaToken, factors }`,
where `factors` lists what the account can finish with (`totp`, `passkey`, `recovery`). Finish with `POST /auth/mfa`,
either `{ mfaToken, code }` (an authenticator code or a recovery code) or
`{ mfaToken, passkey: { challengeId, response } }` after `POST /auth/mfa/passkey/options` (`{ mfaToken }` →
`{ challengeId, options }`). A wrong answer keeps the `mfaToken` usable for another try.

**Push notifications** (no workspace prefix). The browser subscribes with the instance's VAPID key, and Ordo posts
notifications to the push service it names:

| Method | Path                     |                                                                                                      |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| GET    | `/push/key`              | `{ publicKey }`, the `applicationServerKey` for `PushManager.subscribe`                              |
| POST   | `/me/push-subscriptions` | `{ endpoint, keys: { p256dh, auth } }` (what `PushSubscription.toJSON()` gives); `endpoint` is https |
| DELETE | `/me/push-subscriptions` | `{ endpoint }`: stop pushing to that device                                                          |

**Instance administration** lives under `/api/admin` (instance admins only; see [admin.md](admin.md)). The pages of the
admin area use:

| Method      | Path                          |                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET         | `/admin/overview`             | `{ version, users, workspaces, issues, databaseSize, jobs, leases, realtimeConnections, storage, emailEnabled, secretKey }`                                                                                                                                                                                                                                                                |
| GET         | `/admin/users?q=&offset=`     | Accounts, newest first, 50 at a time, matching `q` in name, email or username                                                                                                                                                                                                                                                                                                              |
| POST        | `/admin/users/:id/reset-link` | `{ url, emailed }`: a password reset link valid for a day, also emailed when email works                                                                                                                                                                                                                                                                                                   |
| DELETE      | `/admin/users/:id`            | Delete an account; `409` while it's the only owner of a workspace                                                                                                                                                                                                                                                                                                                          |
| GET         | `/admin/workspaces`           | Every workspace with `members`, `issues` and `owners` (emails)                                                                                                                                                                                                                                                                                                                             |
| DELETE      | `/admin/workspaces/:id`       | `{ confirmSlug }`: delete a workspace                                                                                                                                                                                                                                                                                                                                                      |
| GET         | `/admin/domains`              | Claimed email domains and whether they're verified                                                                                                                                                                                                                                                                                                                                         |
| POST        | `/admin/domains/:id/approve`  | Verify a domain without DNS; `409` when another workspace verified it                                                                                                                                                                                                                                                                                                                      |
| GET / PATCH | `/admin/settings`             | Each [instance setting](configuration.md#instance-settings) with its `value` and `source` (`env`, `db`, `default`) / change `{ signupMode?, allowWorkspaceCreation?, allowPrivateNetworkTargets?, maxAttachmentMb?, workspaceAi?, offlineSync?, smtp?, ai? }`; `null` turns SMTP or AI off, an empty `url` or `apiKey` keeps the stored one. Settings pinned by the environment answer 400 |
| POST        | `/admin/settings/test-email`  | `{ to }`: send a test email                                                                                                                                                                                                                                                                                                                                                                |
| POST        | `/admin/settings/test-ai`     | `{ reply, ms }`: one short request to the configured model                                                                                                                                                                                                                                                                                                                                 |
| GET         | `/admin/jobs`                 | The latest 200 `pending` and `dead` jobs, with `lastError`                                                                                                                                                                                                                                                                                                                                 |
| POST        | `/admin/jobs/:id/retry`       | Run a job again from its first attempt                                                                                                                                                                                                                                                                                                                                                     |
| DELETE      | `/admin/jobs/:id`             | Discard a `dead` job                                                                                                                                                                                                                                                                                                                                                                       |
| GET         | `/admin/audit-log`            | Same filters as the workspace audit log, plus `scope` (`instance`, the default, or `all`) or `workspaceId`                                                                                                                                                                                                                                                                                 |

**Site invites** bring someone onto the instance without adding them to a workspace (instance admins only):

| Method     | Path                        |                                                                                                         |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET / POST | `/admin/invites`            | List open ones / create `{ emails?, canCreateWorkspaces?, expiresInDays? }`: one per address, or a link |
| POST       | `/admin/invites/:id/resend` | Email it again (and extend it)                                                                          |
| DELETE     | `/admin/invites/:id`        | Revoke                                                                                                  |
| PATCH      | `/admin/users/:id`          | `{ disabled?, isInstanceAdmin?, canCreateWorkspaces? }`                                                 |

Sign up with the token as `inviteToken`; the answer's `workspaceSlug` is `null`. `GET /invites/:token` answers
`kind: "site"` and `workspace: null` for them. Site invites are for new accounts only: an address that already has
one gets `409` (`invite_already_signed_up`), and so does `POST /invites/:token/accept`. Email-bound invites work
once, for that address; links work until they expire or are revoked. With workspace creation off, people who came
in through a site invite can create workspaces only if the invite (or later an admin) granted it;
`GET /auth/me` says whether you can now (`canCreateWorkspace`).

Invites (site and workspace) store only a hash of the token, plus the token encrypted with `ORDO_SECRET_KEY` so
the lists can show the link again. Without a key, an invite's `token` and `url` are returned only when it's
created and are `null` in lists; resending such an invite mails a new link and the old one stops working.

## Workspace-scoped endpoints

Everything below is prefixed with `/w/:workspace` (the workspace URL slug), e.g. `/api/w/acme/issues`.

### Workspace

| Method         | Path                            |                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET            | `/bootstrap`                    | Workspace, your role, members, teams (with statuses), labels, projects, cycles, views, favorites, unread count                                                                                                                                                                                                                                                                                           |
| PATCH          | `/`                             | _Admin._ `{ name?, slug?, defaultTeamId?, settings?: { invitePolicy?, domainAutoJoin?, autoJoinRole?, requireSso?, ssoSessionMaxAgeHours?, allowApiKeysUnderSso? } }`                                                                                                                                                                                                                                    |
| DELETE         | `/`                             | _Owner._ `{ confirmSlug }` — deletes the workspace                                                                                                                                                                                                                                                                                                                                                       |
| POST / DELETE  | `/logo`                         | _Admin._ Upload (multipart `file`) / remove the logo                                                                                                                                                                                                                                                                                                                                                     |
| POST           | `/transfer-ownership`           | _Owner._ `{ userId, stepDown? }`                                                                                                                                                                                                                                                                                                                                                                         |
| PATCH          | `/members/:userId`              | _Admin._ `{ role: "owner" \| "admin" \| "member" \| "guest" }` — only owners grant or change ownership                                                                                                                                                                                                                                                                                                   |
| DELETE         | `/members/:userId`              | _Admin_, or yourself to leave                                                                                                                                                                                                                                                                                                                                                                            |
| GET / POST     | `/invites`                      | List / create `{ emails?, role?, teamIds?, expiresInDays? }` — one invite per address (emailed), or one open link; admins, or members when the invite policy allows                                                                                                                                                                                                                                      |
| POST           | `/invites/:id/resend`           | Email it again (and extend it)                                                                                                                                                                                                                                                                                                                                                                           |
| DELETE         | `/invites/:id`                  | _Admin._ Revoke                                                                                                                                                                                                                                                                                                                                                                                          |
| GET / POST     | `/domains`                      | _Admin._ List / add `{ domain }`                                                                                                                                                                                                                                                                                                                                                                         |
| POST           | `/domains/:id/verify`           | _Admin._ Check the `_ordo-verify.<domain>` TXT record                                                                                                                                                                                                                                                                                                                                                    |
| DELETE         | `/domains/:id`                  | _Admin._                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET / POST     | `/auth-providers`               | _Admin._ List (with the OIDC `redirectUri` and the `publicUrl` SAML addresses derive from) / add `{ protocol?: "oidc", name, issuer, clientId, clientSecret, scopes?, … }` or `{ protocol: "saml", id?, name, saml: { idpEntityId, ssoUrl, certificates, nameIdFormat?, emailAttribute?, nameAttribute?, metadataUrl? }, trustEmail?, … }`; both take `enabled?, defaultRole?, groupClaim?, groupRoles?` |
| PATCH / DELETE | `/auth-providers/:id`           | _Admin._ Update (an empty or missing `clientSecret` keeps the stored one) / delete. Secrets are never returned                                                                                                                                                                                                                                                                                           |
| POST           | `/auth-providers/saml/metadata` | _Admin._ Read SAML settings from IdP metadata, `{ xml }` or `{ url }`; saves nothing                                                                                                                                                                                                                                                                                                                     |
| GET            | `/audit-log`                    | _Admin._ Security-relevant actions in this workspace, newest first. Filters: `category` (`security`, `members`, `teams`, `workspace`, `integrations`, `imports`), `actorId`, `from` / `to` (ISO times), `q` (free text). Page with `before` + `beforeId` (the last entry's `createdAt` and `id`); `limit` ≤ 500                                                                                          |
| POST           | `/favorites`                    | `{ kind: "project" \| "view" \| "team" \| "issue" \| "cycle", targetId }`                                                                                                                                                                                                                                                                                                                                |
| DELETE         | `/favorites/:id`                |                                                                                                                                                                                                                                                                                                                                                                                                          |

### Teams & workflow

| Method         | Path                           |                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET            | `/teams`                       |                                                                                                                                                                                                                                                             |
| POST           | `/teams`                       | `{ name, key, description?, color?, private? }` — creates the default workflow; you become its team admin                                                                                                                                                   |
| PATCH          | `/teams/:id`                   | _Team admin._ `{ name?, key?, color?, private?, estimateScale?, triageEnabled?, cyclesEnabled?, defaultStateId?, autoArchiveMonths?, slaHours?, cycleAutomation? }` (partial `{ enabled, weeks, cooldownWeeks, startDay, upcoming, rollOver, addStarted }`) |
| POST           | `/teams/:id/triage-rules`      | _Team admin._ `{ name, enabled?, conditions: { sources?, text?, labelIds?, priorities? }, actions: { priority?, labelIds?, assigneeId?, rotation?, stateId? } }`                                                                                            |
| PATCH / DELETE | `/triage-rules/:id`            | _Team admin._ Same fields, plus `position`; rules come with each team as `triageRules`                                                                                                                                                                      |
| DELETE         | `/teams/:id`                   | _Admin._ Deletes the team **and its issues**                                                                                                                                                                                                                |
| POST           | `/teams/:id/members`           | `{ userId?, role? }` — join a public team yourself, or (team admin) add someone; `role` is `member` or `admin`                                                                                                                                              |
| PATCH          | `/teams/:id/members/:userId`   | _Team admin._ `{ role }`                                                                                                                                                                                                                                    |
| DELETE         | `/teams/:id/members/:userId`   | Leave, or (team admin) remove someone                                                                                                                                                                                                                       |
| POST           | `/teams/:id/states`            | `{ name, type, color, description? }`                                                                                                                                                                                                                       |
| PATCH          | `/states/:id`                  | `{ name?, color?, description?, position? }`                                                                                                                                                                                                                |
| DELETE         | `/states/:id?moveTo=<stateId>` | Issues move to `moveTo` or another status of the same type                                                                                                                                                                                                  |

### Issues

| Method | Path                                |                                                                                              |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| POST   | `/issues/query`                     | `{ filter, limit?, after? }` → `Issue[]` (see below)                                         |
| GET    | `/issues/:idOrIdentifier`           | Issue with parent, sub-issues, relations, subscribers, links, attachments                    |
| POST   | `/issues`                           | Create (see example)                                                                         |
| PATCH  | `/issues/:id`                       | Any of the create fields, plus `teamId` (move), `addLabelIds`, `removeLabelIds`, `sortOrder` |
| POST   | `/issues/batch`                     | `{ ids, patch }` — same patch on up to 250 issues                                            |
| DELETE | `/issues/:id`                       | Move to trash                                                                                |
| POST   | `/issues/batch-delete`              | `{ ids }`                                                                                    |
| POST   | `/issues/:id/restore`               | Restore from trash; returns the issue                                                        |
| POST   | `/issues/:id/archive`, `/unarchive` | Archive (out of lists, still readable) / bring back                                          |
| POST   | `/issues/:id/links`                 | Attach a link `{ url, title? }`                                                              |
| DELETE | `/issue-links/:id`                  | Remove a link (any kind)                                                                     |

Pull request links (`kind: "pull_request"`) have `pullRequest: { repo, number, branch, checks, review }`: `checks` is
`pending`, `passing`, `failing` or `null` (not reported), `review` is `approved`, `changes_requested` or `null`.
| POST | `/attachments?issueId=` | Upload one file (multipart field `file`) → `Attachment`; see below |
| DELETE | `/attachments/:id` | Remove an attachment (uploader, team admin or admin) |
| DELETE | `/issues/:id/purge` | _Admin._ Permanently delete a trashed issue |
| GET | `/issues/:id/history` | Change log |
| POST / DELETE | `/issues/:id/subscription` | Subscribe / unsubscribe yourself |
| POST | `/issues/:id/relations` | `{ type: "blocks" \| "blocked_by" \| "related" \| "duplicate_of", relatedIssueId }` |
| DELETE | `/relations/:id` | |
| GET / POST | `/issues/:id/comments` | List / create `{ body, parentId? }` (`@username` notifies) |
| PATCH / DELETE | `/comments/:id` | Edit (author) / delete (author or admin) |
| PUT / DELETE | `/comments/:id/reactions/:emoji` | Add / remove your reaction (one URL-encoded emoji); returns the comment's `reactions` |

Create an issue:

```bash
curl -X POST "$ORDO/w/acme/issues" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
        "teamId": "…",
        "title": "Login button misaligned on Safari",
        "description": "Steps:\n1. …",
        "priority": 2,
        "labelIds": ["…"],
        "dueDate": "2026-02-01"
      }'
```

Move `ENG-42` to a status and assign it to yourself:

```bash
ME=$(curl -s -H "Authorization: Bearer $KEY" $ORDO/auth/me | jq -r .id)
curl -X PATCH "$ORDO/w/acme/issues/ENG-42" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d "{\"stateId\":\"…\",\"assigneeId\":\"$ME\"}"
```

Attach a file. Without `issueId` the upload belongs to you until an issue description or comment you save
references its URL (unclaimed uploads are deleted after a day):

```bash
curl -X POST "$ORDO/w/acme/attachments?issueId=ENG-42" -H "Authorization: Bearer $KEY" \
  -F file=@screenshot.png
# → { "id": "…", "url": "/api/attachments/…", "filename": "screenshot.png", "contentType": "image/png", … }
```

`GET /api/attachments/:id` serves the file to anyone who can read the issue (session or API key). The URL has no
workspace in it, so Markdown that embeds it keeps working after a rename. Only PNG, JPEG, GIF and WebP — judged
from the bytes — are served inline; everything else downloads as `application/octet-stream`. The size limit is the
`maxAttachmentMb` instance setting (413 above it).

#### Filters

`POST /issues/query` takes an `IssueFilter`. All fields are optional and combine with AND; arrays are OR.

| Field                                    | Type                                                                     | Notes                                            |
| ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| `teamId`                                 | uuid                                                                     |                                                  |
| `stateIds`                               | uuid[]                                                                   |                                                  |
| `stateTypes`                             | (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`)[] |                                                  |
| `priorities`                             | (0–4)[]                                                                  | 0 none, 1 urgent, 2 high, 3 medium, 4 low        |
| `assigneeIds`                            | (uuid \| `"me"` \| `"none"`)[]                                           |                                                  |
| `creatorIds`                             | (uuid \| `"me"`)[]                                                       |                                                  |
| `labelIds`                               | uuid[]                                                                   | has any of                                       |
| `projectIds`, `milestoneIds`, `cycleIds` | (uuid \| `"none"`)[]                                                     |                                                  |
| `parentId`                               | uuid                                                                     | sub-issues of                                    |
| `subscribedBy`                           | `"me"`                                                                   |                                                  |
| `q`                                      | string                                                                   | words (full text, as prefixes), or an identifier |
| `trashed`                                | boolean                                                                  | only trashed issues                              |
| `archived`                               | `"include"` \| `"only"`                                                  | archived issues are left out otherwise           |

```bash
curl -X POST "$ORDO/w/acme/issues/query" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"assigneeIds":["me"],"stateTypes":["unstarted","started"]}}'
```

Without `after` you get up to `limit` issues (default 2 000, at most 5 000) in board order. To read everything, page
with `after`: send `"after": null` for the first page, then the last issue's `id`; pages come in id order and a page
shorter than `limit` is the last. The web app loads big views this way, 1 000 at a time.

### Projects, cycles, labels, views

| Method               | Path                            |                                                                                                                                       |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GET / POST           | `/projects`                     | `{ name, teamIds, description?, color?, status?, leadId?, startDate?, targetDate? }`                                                  |
| GET / PATCH / DELETE | `/projects/:id`                 | Deleting keeps the issues                                                                                                             |
| GET / POST           | `/projects/:id/updates`         | `{ body, health: "on_track" \| "at_risk" \| "off_track" }`                                                                            |
| GET / POST           | `/customers`                    | `{ name, domains?, ownerId?, notes? }` (not for guests); list includes `requestCount`, `openIssueCount`                               |
| PATCH / DELETE       | `/customers/:id`                | Same fields; deleting removes its requests                                                                                            |
| GET                  | `/customers/:id/requests`       | Requests on issues you can see, each with its `issue`                                                                                 |
| POST                 | `/issues/:id/customer-requests` | `{ customerId, body?, contact? }`; issue details list them as `customerRequests`                                                      |
| DELETE               | `/customer-requests/:id`        |                                                                                                                                       |
| GET / POST           | `/recurring`                    | Template schedules: `{ templateId, teamId, every: 1–52, unit: "day" \| "week" \| "month", nextOn }`                                   |
| PATCH / DELETE       | `/recurring/:id`                | `{ every?, unit?, nextOn?, paused? }`                                                                                                 |
| GET / POST           | `/initiatives`                  | `{ name, description?, status?: "planned" \| "active" \| "completed", ownerId?, targetDate?, color? }`                                |
| PATCH / DELETE       | `/initiatives/:id`              | Same fields, plus `sortOrder`; deleting keeps its projects. Projects join one with `initiativeId`                                     |
| POST                 | `/projects/:id/milestones`      | `{ name, description?, targetDate? }` → the project, with `milestones` (each with `progress`)                                         |
| GET / POST           | `/projects/:id/documents`       | List (without `content`) / create `{ title, content? }`                                                                               |
| GET / PATCH / DELETE | `/documents/:id`                | `PATCH { title?, content?, baseUpdatedAt? }` — with `baseUpdatedAt`, a newer saved version answers 409                                |
| PATCH / DELETE       | `/milestones/:id`               | `{ name?, description?, targetDate?, sortOrder? }` → the project; deleting keeps its issues in the project                            |
| DELETE               | `/project-updates/:id`          |                                                                                                                                       |
| GET                  | `/cycles`                       | All cycles with progress                                                                                                              |
| POST                 | `/teams/:id/cycles`             | `{ startsAt, endsAt, name?, description? }` — numbered per team                                                                       |
| PATCH / DELETE       | `/cycles/:id`                   | Deleting unassigns its issues                                                                                                         |
| POST                 | `/labels`                       | `{ name, color, teamId? }`                                                                                                            |
| PATCH / DELETE       | `/labels/:id`                   |                                                                                                                                       |
| GET / POST           | `/templates`                    | Issue templates; create `{ name, teamId?, title?, description?, stateId?, priority?, assigneeId?, projectId?, estimate?, labelIds? }` |
| PATCH / DELETE       | `/templates/:id`                | Same fields except `teamId` (`null` clears a default)                                                                                 |
| POST                 | `/views`                        | `{ name, filters, display?, shared?, teamId? }`                                                                                       |
| PATCH / DELETE       | `/views/:id`                    | Owner or admin                                                                                                                        |

### Notifications & search

| Method | Path                    |                                                                                                                                        |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/notifications`        | Latest 200 matching the filter: `types`, `teams`, `actors`, `priorities`, `reasons` (comma-separated), `from=people\|bots`, `unread=1` |
| GET    | `/notifications/counts` | Unread in the inbox per type: `{ issue_mention: 2, … }`                                                                                |
| POST   | `/notifications/read`   | `{ ids?, unread? }`, or `{ filter, snoozed? }` for everything the filter matches; neither marks every unread one                       |
| POST   | `/notifications/delete` | `{ ids }`, or `{ read: true, filter?, snoozed? }` for the read ones (that the filter matches)                                          |
| POST   | `/notifications/snooze` | `{ ids, until }` — an ISO time, or `null` to wake; `GET /notifications?snoozed=1` lists them                                           |
| GET    | `/search?q=`            | `{ issues, projects }`, best matches first                                                                                             |

## Realtime

`GET /api/ws?workspace=<slug>` upgrades to a WebSocket (cookie auth). The server sends:

```json
{ "kind": "hello", "workspaceId": "…" }
{ "kind": "issue", "action": "updated", "id": "…", "teamId": "…", "workspaceId": "…", "actorId": "…" }
```

`kind` is one of `issue`, `comment`, `project`, `projectUpdate`, `cycle`, `label`, `template`, `initiative`,
`customer`, `document`, `team`, `state`, `workspace`, `member`, `view`, `favorite`, `notification`, `import`, `export`,
`repository`, `agentRun` (`EntityKind` in `packages/shared/src/events.ts`); `action` is `created`, `updated` or `deleted`. Notification and
favorite events are delivered only to their user. Events are hints — refetch what you display.
Events also carry `seq` and `epoch`, their place in the workspace's change log (below). An issue that moves to a
team you can't read arrives as `deleted` from the team you could.

### Sync

For clients that keep their own copy of a workspace (and work offline). Load it once, then follow the change log:

| Method | Path             |                                                                                                |
| ------ | ---------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/sync/snapshot` | `{ seq, epoch, bootstrap }`: the bootstrap data as of change `seq`                             |
| POST   | `/sync/issues`   | `{ after?, limit? }` → `{ issues, next }`: issues that aren't trashed or archived, in id order |
| GET    | `/sync/changes`  | `?since=<seq>&epoch=<epoch>&limit=` → what changed after `since` (below)                       |

A changes answer has `seq` (pass it as `since` next time), `more` (ask again straight away), `issues` and `comments`
as they are now, `deletedIssueIds` and `deletedCommentIds` (deleted, trashed, archived, or moved out of your sight),
`bootstrapChanged` (teams, members, labels, projects… changed: load the snapshot again) and `kinds` (other things
that changed, such as `notification`). Only changes you're allowed to see are included, but `seq` moves past the
others too. `410 resync` means the workspace started a new epoch (an import, a deleted team) or you're further
behind than the 30 days the log keeps: start again from the snapshot.

Creating an issue, comment or relation accepts an `id` (a UUID you choose), so you can refer to it before the server
answers. Sending the same create again with the same `id` returns what the first one made, which makes replaying a
queue of offline changes safe; an `id` that already belongs to someone else's issue, comment or relation gets
`409 id_taken`. Read the snapshot before the issue pages; a
change made while you load shows up in the changes after it.

There is also a [GraphQL API](graphql.md) per workspace, for reading issues with everything around them in one request.

## Webhooks

Admins add endpoints under **Settings → Webhooks** (or the API below). Ordo POSTs one JSON event per request:

```json
{
  "id": "1042",
  "type": "issue.updated",
  "createdAt": "2026-10-26T16:20:03.862Z",
  "workspace": { "id": "…", "slug": "acme", "name": "Acme" },
  "actor": { "id": "…", "name": "Ada Lovelace", "username": "ada", "kind": "human" },
  "source": "web",
  "data": {
    "id": "…",
    "identifier": "ENG-42",
    "title": "…",
    "stateId": "…",
    "priority": 1,
    "…": "…"
  },
  "changes": [{ "field": "priority", "from": 0, "to": 1 }]
}
```

| Type                                                             | `data`                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `issue.created` `issue.updated` `issue.trashed` `issue.restored` | The issue (as `GET /issues/:id` without the detail lists); `changes` on updates |
| `issue.deleted`                                                  | `{ id }` (permanently deleted from the trash)                                   |
| `issue.archived` `issue.unarchived`                              | `{ id, identifier, archivedAt }`                                                |
| `comment.created` `comment.updated` `comment.deleted`            | `{ comment, issue? }`                                                           |
| `reaction.created` `reaction.deleted`                            | `{ reaction: { commentId, issueId, userId, emoji } }`                           |
| `relation.created` `relation.deleted`                            | `{ id, type, issueId, relatedIssueId }`                                         |
| `project.created` `project.updated` `project.deleted`            | The project (`{ id, name }` when deleted)                                       |
| `initiative.created` `initiative.updated` `initiative.deleted`   | The initiative (`{ id, name }` when deleted)                                    |
| `project_update.created`                                         | `{ update, project }`                                                           |
| `cycle.created` `cycle.updated` `cycle.deleted`                  | The cycle                                                                       |
| `agent_run.updated`                                              | The run when its status changes (statuses below), see [agents](agents.md)       |
| `ping`                                                           | Sent by the "test" button                                                       |

`source` says where a change came from: `web`, `api` (an API key), `mcp` (an agent through the [MCP server](mcp.md)),
`system`, `import`, `scim` (directory sync through [SCIM](scim.md)) or `integration:<id>`.

A run's `status` is `queued` (waiting for a runner), `claimed` (a runner took it), `running`, `waiting` (the agent
asked a question; a reply requeues it), or one of the final `succeeded`, `failed` and `cancelled`.

**Headers:** `Ordo-Event` (the type), `Ordo-Delivery` (unique per attempt series; reuse it to deduplicate), and
`Ordo-Signature: t=<unix seconds>,v1=<hex>` where `v1` is HMAC-SHA256 over `"<t>.<raw body>"` with the webhook's
secret. Check it with a constant-time comparison and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

**Delivery:** answer with any 2xx within 10 seconds. Anything else is retried with exponential backoff (10 attempts,
about an hour). Redirects aren't followed. Events of one workspace are dispatched in commit order, but retries can
reorder them — use `createdAt` or `id` (increasing). After 20 deliveries in a row fail for good, the webhook switches
itself off; turning it back on resets the count. Deliveries are kept for 30 days.

Webhooks only receive events for the teams they're limited to (all by default), so private-team issues only leave
Ordo if an admin chose to send them.

| Method         | Path                                             |                                                                                                         |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| GET / POST     | `/webhooks`                                      | _Admin._ List / create `{ url, description?, eventTypes?, teamIds?, enabled? }` → `{ webhook, secret }` |
| PATCH / DELETE | `/webhooks/:id`                                  | _Admin._ Update (same fields) / delete                                                                  |
| GET            | `/webhooks/:id/secret`                           | _Admin._ `{ secret }`                                                                                   |
| POST           | `/webhooks/:id/rotate-secret`                    | _Admin._ New secret, returned once                                                                      |
| POST           | `/webhooks/:id/ping`                             | _Admin._ Send a `ping` event                                                                            |
| GET            | `/webhooks/:id/deliveries`                       | _Admin._ Recent deliveries (status, response, attempts)                                                 |
| GET            | `/webhooks/:id/deliveries/:deliveryId`           | _Admin._ One delivery with its payload                                                                  |
| POST           | `/webhooks/:id/deliveries/:deliveryId/redeliver` | _Admin._ Send the same payload again                                                                    |

## Agents and repositories

Agents are members a runner works for; see [agents.md](agents.md) for the idea and the runner protocol.

| Method         | Path                                                             | What                                                                                                                                        |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET / POST     | `/agents`                                                        | _Admin._ List / create `{ name, teamIds, instructions?, concurrency?, followPullRequests?, waitForBlockers?, username? }`                   |
| PATCH          | `/agents/:id`                                                    | _Admin._ `{ name?, teamIds?, instructions?, concurrency?, followPullRequests?, waitForBlockers?, disabled? }`                               |
| POST           | `/agents/:id/keys`                                               | _Admin._ `{ name }` → `{ id, token }`, the token returned once                                                                              |
| DELETE         | `/agents/:id/keys/:keyId`                                        | _Admin._ Revoke a key                                                                                                                       |
| POST           | `/agents/:id/unpause`                                            | _Admin._ Lift a pause ("Resume now") and restart the runs that failed on its usage limit                                                    |
| GET            | `/agent-pauses`                                                  | Agents on hold right now: `[{ agentId, pausedUntil, reason }]`                                                                              |
| GET / POST     | `/issues/:id/agent-runs`                                         | The issue's runs / queue a new one for its agent ("Run again")                                                                              |
| GET            | `/agent-runs?status=open\|active\|finished\|all&agentId=&limit=` | Runs across the workspace on issues you can see, latest change first (≤ 500). `open`: active plus failed runs nobody restarted or dismissed |
| GET            | `/agent-runs/active-count`                                       | `{ count }` of active runs (queued, claimed, running, waiting) on issues you can see                                                        |
| POST           | `/agent-runs/:id/cancel`                                         | Cancel a run; its runner hears it on the next heartbeat                                                                                     |
| POST           | `/agent-runs/:id/restart`                                        | A failed or cancelled run again: same agent, issue and trigger, as a new run with `retryOfId` (an open one is returned)                     |
| POST           | `/agent-runs/:id/run-anyway`                                     | A queued run held back by its issue's blockers goes ahead (`ignoreBlockers`)                                                                |
| POST           | `/agent-runs/:id/dismiss`                                        | Set a finished run aside (`dismissedAt`); it leaves the `open` list                                                                         |
| GET            | `/agent/me`                                                      | _Agent key._ The agent and its teams, and `pausedUntil` / `pauseReason` while it's paused                                                   |
| POST           | `/agent/claim?wait=30&runner=…`                                  | _Agent key._ `{ instructions? }` → the next run as an `AgentRunContext`, or `204` after `wait` seconds (≤ 60)                               |
| POST           | `/agent/runs/:id/heartbeat`                                      | _Agent key._ Extend the lease → `{ cancelled, status }`                                                                                     |
| PATCH          | `/agent/runs/:id`                                                | _Agent key._ `{ status?: running \| waiting \| succeeded \| failed, question?, resume?, sessionUrl?, summary?, error?, failureReason? }`    |
| GET            | `/repositories`                                                  | The workspace's repositories (also in the bootstrap)                                                                                        |
| POST           | `/repositories`                                                  | _Admin._ `{ name, url, defaultBranch?, integrationId?, externalRepo? }`                                                                     |
| PATCH / DELETE | `/repositories/:id`                                              | _Admin._ Update / delete                                                                                                                    |

Projects take `repositoryIds` (in order) on create and update; teams take `defaultRepositoryId`. Admins can set a
project's `pullRequestAgentId` (an agent in one of its teams, or `null`) and `pullRequestScope` (`"linked"` or
`"all"`): who gets its pull requests when they're ready for review ([agents.md](agents.md#pull-requests)).

A run's `trigger` is `assigned`, `mention`, `rerun` or `pull_request`; for `pull_request`, `triggerDetail` is
`{ event: "ready_for_review" | "checks_failed" | "changes_requested", repo, number, url, branch }`.

A failed run has a `failureReason`: `usage_limit`, `timeout`, `runner_lost`, `checkout` or `error`. A runner may send
`timeout` or `checkout` with its report; otherwise Ordo reads the error. On `usage_limit` the agent is paused until
the limit resets and the run gets a `retryAt`, when it restarts by itself (not after three limits in a row). A
restart has `retryOfId`, the run it restarts; `dismissedAt` is set on dismissed runs. See
[agents.md](agents.md#when-a-run-fails).

A queued run of an agent with `waitForBlockers` isn't handed out while an open issue (not done, cancelled or trashed)
blocks its issue, unless `ignoreBlockers` is set (Run anyway). Listed runs carry `blockedBy`: the open blockers you
can see, `{ id, identifier, title }`; empty when the run doesn't wait.

`progress` is `{ step, percent, at }` (or `null`): what the agent last said it is doing, sent with the MCP tool
`report_progress`. Only the newest is kept, and a new claim clears it. It changes the run (realtime `agentRun`
events) but isn't an `agent_run.updated` webhook event.

**Default assignee.** An issue created without `assigneeId` goes to the default assignee: its project's
`defaultAssignee` (`"workspace"`, `"none"`, or a member's id) or else the workspace's `settings.defaultAssigneeId`,
as long as they can work in the issue's team. Send `"assigneeId": null` for nobody. Imports and issues created in
triage are left alone.

## Integrations

| Method     | Path                                    |                                                                                                            |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET        | `/integrations`                         | _Admin._ `{ providers, integrations }` — what can be connected and what is                                 |
| POST       | `/integrations`                         | _Admin._ Connect with a token `{ provider, name?, config, secrets }` ([setup](integrations/README.md))     |
| PATCH      | `/integrations/:id`                     | _Admin._ `{ name?, config?, secrets?, enabled? }` — secrets merge; empty values keep the stored ones       |
| DELETE     | `/integrations/:id`                     | _Admin._ Disconnect (removes the webhooks Ordo created); links on issues stay                              |
| GET        | `/integrations/:id/repositories`        | _Admin._ GitHub/Forgejo repos it can see (`?q=` filters): `[{ fullName, cloneUrl, sshUrl, … }]`            |
| GET        | `/integrations/github/app`              | _Admin._ The instance's GitHub App, if any                                                                 |
| POST       | `/integrations/github/manifest`         | _Instance admin._ `{ org? }` → `{ action, manifest }` to POST to GitHub                                    |
| POST       | `/integrations/github/install`          | _Admin._ `{ url }` to install the GitHub App for this workspace                                            |
| GET        | `/integrations/slack/app`               | _Admin._ The instance's Slack app, if any, and (for instance admins) manifest links to create it           |
| PUT        | `/integrations/slack/app`               | _Instance admin._ `{ delivery, clientId, clientSecret?, signingSecret?, appToken? }` saves its credentials |
| POST       | `/integrations/slack/install`           | _Admin._ `{ url }` to Slack's consent screen ("Add to Slack") for this workspace                           |
| GET / POST | `/me/external-accounts`                 | Your claimed forge usernames `{ provider, host, username }`                                                |
| DELETE     | `/me/external-accounts/:id`             |                                                                                                            |
| GET        | `/me/chat-accounts`                     | `{ services }` — chat integrations, how to link, and your linked accounts                                  |
| POST       | `/me/chat-accounts/:integrationId/code` | `{ code, hint, expiresInMinutes }` — a one-time code to send from your chat account                        |
| PATCH      | `/me/chat-accounts/:id`                 | `{ notify }` — direct-message notifications on or off                                                      |
| DELETE     | `/me/chat-accounts/:id`                 | Unlink                                                                                                     |

Chat integrations take `config.channels`: `[{ id, name?, teamIds, events, defaultTeamId? }]`, where `events` lists
`issue.created`, `issue.status`, `issue.completed`, `comment.created` and `project_update.created`, and empty
`teamIds` means every public team.

Inbound webhooks from forges and chat services arrive at `/api/hooks/<provider>/<key>` (outside `/w/…`) and are
verified per provider. Integrations that hold their own connection (Socket Mode, a gateway, long polling, Matrix
sync) accept no webhooks.

GitHub and Slack send the browser back to `GET /api/integrations/github/callback` (after creating the GitHub App),
`GET /api/integrations/github/setup` (after installing it) and `GET /api/integrations/slack/callback` (after "Add to
Slack"). These are steps of the setup flows above, not endpoints to call yourself.

OAuth for MCP clients uses `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource/api/w/<slug>/mcp` and `/api/oauth/register|token|revoke`; see
[mcp.md](mcp.md).

Team settings take `gitAutomation: { branch?, draft?, open?, review?, merged? }` — a status id or `"none"`; missing
events use the defaults. Workspace settings take `gitBranchFormat` (for people; agent runs use one branch per issue,
see [agents.md](agents.md#ordo-agent-run)). Admins can set `agentRunsPaused: true` to stop runners claiming new runs.

## Imports

Admins only. How imports work, and the CSV columns Ordo reads, are in [Importing data](import-export.md).

| Method | Path                   |                                                                                                 |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/imports`             | The latest 50                                                                                   |
| POST   | `/imports`             | Multipart `file` (`source: csv`), or JSON for an API source (below). Starts the analysis        |
| GET    | `/imports/:id`         | `{ status, summary, mapping, report, progress, error, … }`                                      |
| PATCH  | `/imports/:id`         | `{ mapping? }` saves the mapping; `{ config: { columns } }` changes CSV columns and re-analyzes |
| POST   | `/imports/:id/dry-run` | Reports what a run would do, in `report`                                                        |
| POST   | `/imports/:id/run`     | Imports; running again skips what's already imported                                            |
| POST   | `/imports/:id/cancel`  | Stops at the next page                                                                          |
| POST   | `/imports/:id/undo`    | Moves the issues it created to the trash; the import becomes `undone`                           |
| DELETE | `/imports/:id`         | Forgets the import and its file; imported issues stay                                           |

API sources take one of:

- `{ "source": "linear", "apiKey" }`
- `{ "source": "github", "token", "repos": ["owner/name"], "apiUrl"? }`
- `{ "source": "forgejo", "baseUrl", "token", "repos": ["owner/name"] }`
- `{ "source": "gitlab", "baseUrl"?, "token", "projects": ["group/project"] }`
- `{ "source": "jira", "siteUrl", "email"?, "token", "projects"? }`

The credentials are checked first and never returned.

`status` goes `analyzing` → `ready` → (`dry_running` → `ready`) → `running` → `completed`, or `failed` / `canceled`;
undoing goes `undoing` → `undone`.
`mapping` is `{ teams, statuses, users, labels, projects, keepNumbers }`, keyed by the source's ids from `summary`:
a team maps to `{ teamId }`, `{ create: { name, key } }` or `{ skip: true }`; a status to a status id or a status
type; a person to a member's or placeholder's id, `"placeholder"` for a new placeholder, or `null`; a label or
project to an id, `"create"` or `"skip"`.

### Placeholders

People imports brought along who aren't members ([details](import-export.md#placeholders)). Bootstrap lists them in
`placeholders` so their names can be shown; they can't be assigned or mentioned.

| Method | Path                      |                                                                                |
| ------ | ------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/placeholders`           | _Admin._ With counts of what's attributed to each, and a `suggestedUserId`     |
| POST   | `/placeholders/:id/merge` | _Admin._ `{ userId }` → `{ assigned, unassigned }`; the placeholder is deleted |

### Exports

Admins only ([what's in them](import-export.md#exporting)).

| Method | Path           |                                                                       |
| ------ | -------------- | --------------------------------------------------------------------- |
| GET    | `/exports`     | The latest 20, with a signed download `url` once `status` is `ready`  |
| POST   | `/exports`     | `{ format: "json" \| "csv" }`; 409 while another export is being made |
| DELETE | `/exports/:id` | Deletes the export and its file (they go by themselves after a week)  |
