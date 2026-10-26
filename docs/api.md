# REST API

Everything the web app does goes through this API, so anything you can click you can script.

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

The browser uses an `ordo_session` cookie instead (`POST /auth/login`).

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
| 404    | `not_found`    | Doesn't exist, or you're not a member of the workspace                |
| 409    | `conflict`     | Unique constraint (email, workspace URL, team key, username)          |
| 429    |                | Rate limited (auth endpoints)                                         |

## Instance & account

| Method     | Path                     |                                                          |
| ---------- | ------------------------ | -------------------------------------------------------- |
| GET        | `/health`                | `{ ok, version }`                                        |
| GET        | `/config`                | Sign-up mode, whether any users exist                    |
| POST       | `/auth/signup`           | `{ name, email, password, inviteToken? }`                |
| POST       | `/auth/login`            | `{ email, password }` → sets cookie                      |
| POST       | `/auth/logout`           |                                                          |
| GET        | `/auth/me`               | You, plus your workspaces and roles                      |
| PATCH      | `/me`                    | `{ name?, username?, avatarColor? }`                     |
| POST       | `/me/password`           | `{ currentPassword, newPassword }`                       |
| GET / POST | `/me/api-keys`           | List / create `{ name }` (the token is returned once)    |
| DELETE     | `/me/api-keys/:id`       | Revoke                                                   |
| POST       | `/workspaces`            | `{ name, slug, teamName?, teamKey? }` — you become admin |
| GET        | `/invites/:token`        | Public invite info                                       |
| POST       | `/invites/:token/accept` | Join with the signed-in account                          |

## Workspace-scoped endpoints

Everything below is prefixed with `/w/:workspace` (the workspace URL slug), e.g. `/api/w/acme/issues`.

### Workspace

| Method     | Path                        |                                                                                                                |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET        | `/bootstrap`                | Workspace, your role, members, teams (with statuses), labels, projects, cycles, views, favorites, unread count |
| PATCH      | `/`                         | _Admin._ `{ name?, slug? }`                                                                                    |
| PATCH      | `/members/:userId`          | _Admin._ `{ role: "owner" \| "admin" \| "member" \| "guest" }` — only owners grant or change ownership         |
| DELETE     | `/members/:userId`          | _Admin_, or yourself to leave                                                                                  |
| GET / POST | `/invites`                  | _Admin._ List / create `{ email?, role?, expiresInDays? }`                                                     |
| DELETE     | `/invites/:id`              | _Admin._ Revoke                                                                                                |
| GET        | `/audit-log?before=&limit=` | _Admin._ Recent security-relevant actions in this workspace                                                    |
| POST       | `/favorites`                | `{ kind: "project" \| "view" \| "team" \| "issue" \| "cycle", targetId }`                                      |
| DELETE     | `/favorites/:id`            |                                                                                                                |

### Teams & workflow

| Method | Path                           |                                                                                                                    |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/teams`                       |                                                                                                                    |
| POST   | `/teams`                       | `{ name, key, description?, color?, private? }` — creates the default workflow; you become its team admin          |
| PATCH  | `/teams/:id`                   | _Team admin._ `{ name?, key?, color?, private?, estimateScale?, triageEnabled?, cyclesEnabled?, defaultStateId? }` |
| DELETE | `/teams/:id`                   | _Admin._ Deletes the team **and its issues**                                                                       |
| POST   | `/teams/:id/members`           | `{ userId?, role? }` — join a public team yourself, or (team admin) add someone; `role` is `member` or `admin`     |
| PATCH  | `/teams/:id/members/:userId`   | _Team admin._ `{ role }`                                                                                           |
| DELETE | `/teams/:id/members/:userId`   | Leave, or (team admin) remove someone                                                                              |
| POST   | `/teams/:id/states`            | `{ name, type, color, description? }`                                                                              |
| PATCH  | `/states/:id`                  | `{ name?, color?, description?, position? }`                                                                       |
| DELETE | `/states/:id?moveTo=<stateId>` | Issues move to `moveTo` or another status of the same type                                                         |

### Issues

| Method         | Path                       |                                                                                              |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| POST           | `/issues/query`            | `{ filter, limit? }` → `Issue[]` (see below)                                                 |
| GET            | `/issues/:idOrIdentifier`  | Issue with parent, sub-issues, relations, subscribers                                        |
| POST           | `/issues`                  | Create (see example)                                                                         |
| PATCH          | `/issues/:id`              | Any of the create fields, plus `teamId` (move), `addLabelIds`, `removeLabelIds`, `sortOrder` |
| POST           | `/issues/batch`            | `{ ids, patch }` — same patch on up to 250 issues                                            |
| DELETE         | `/issues/:id`              | Move to trash                                                                                |
| POST           | `/issues/batch-delete`     | `{ ids }`                                                                                    |
| POST           | `/issues/:id/restore`      | Restore from trash                                                                           |
| DELETE         | `/issues/:id/purge`        | _Admin._ Permanently delete a trashed issue                                                  |
| GET            | `/issues/:id/history`      | Change log                                                                                   |
| POST / DELETE  | `/issues/:id/subscription` | Subscribe / unsubscribe yourself                                                             |
| POST           | `/issues/:id/relations`    | `{ type: "blocks" \| "blocked_by" \| "related" \| "duplicate_of", relatedIssueId }`          |
| DELETE         | `/relations/:id`           |                                                                                              |
| GET / POST     | `/issues/:id/comments`     | List / create `{ body, parentId? }` (`@username` notifies)                                   |
| PATCH / DELETE | `/comments/:id`            | Edit (author) / delete (author or admin)                                                     |

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

#### Filters

`POST /issues/query` takes an `IssueFilter`. All fields are optional and combine with AND; arrays are OR.

| Field                    | Type                                                                     | Notes                                         |
| ------------------------ | ------------------------------------------------------------------------ | --------------------------------------------- |
| `teamId`                 | uuid                                                                     |                                               |
| `stateIds`               | uuid[]                                                                   |                                               |
| `stateTypes`             | (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`)[] |                                               |
| `priorities`             | (0–4)[]                                                                  | 0 none, 1 urgent, 2 high, 3 medium, 4 low     |
| `assigneeIds`            | (uuid \| `"me"` \| `"none"`)[]                                           |                                               |
| `creatorIds`             | (uuid \| `"me"`)[]                                                       |                                               |
| `labelIds`               | uuid[]                                                                   | has any of                                    |
| `projectIds`, `cycleIds` | (uuid \| `"none"`)[]                                                     |                                               |
| `parentId`               | uuid                                                                     | sub-issues of                                 |
| `subscribedBy`           | `"me"`                                                                   |                                               |
| `q`                      | string                                                                   | title/description substring, or an identifier |
| `trashed`                | boolean                                                                  | only trashed issues                           |

```bash
curl -X POST "$ORDO/w/acme/issues/query" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"assigneeIds":["me"],"stateTypes":["unstarted","started"]}}'
```

### Projects, cycles, labels, views

| Method               | Path                    |                                                                                      |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| GET / POST           | `/projects`             | `{ name, teamIds, description?, color?, status?, leadId?, startDate?, targetDate? }` |
| GET / PATCH / DELETE | `/projects/:id`         | Deleting keeps the issues                                                            |
| GET / POST           | `/projects/:id/updates` | `{ body, health: "on_track" \| "at_risk" \| "off_track" }`                           |
| DELETE               | `/project-updates/:id`  |                                                                                      |
| GET                  | `/cycles`               | All cycles with progress                                                             |
| POST                 | `/teams/:id/cycles`     | `{ startsAt, endsAt, name?, description? }` — numbered per team                      |
| PATCH / DELETE       | `/cycles/:id`           | Deleting unassigns its issues                                                        |
| POST                 | `/labels`               | `{ name, color, teamId? }`                                                           |
| PATCH / DELETE       | `/labels/:id`           |                                                                                      |
| POST                 | `/views`                | `{ name, filters, display?, shared?, teamId? }`                                      |
| PATCH / DELETE       | `/views/:id`            | Owner or admin                                                                       |

### Notifications & search

| Method | Path                    |                                          |
| ------ | ----------------------- | ---------------------------------------- |
| GET    | `/notifications`        | Latest 200                               |
| POST   | `/notifications/read`   | `{ ids?, unread? }` — omit `ids` for all |
| POST   | `/notifications/delete` | `{ ids }` or `{ read: true }`            |
| GET    | `/search?q=`            | `{ issues, projects }`                   |

## Realtime

`GET /api/ws?workspace=<slug>` upgrades to a WebSocket (cookie auth). The server sends:

```json
{ "kind": "hello", "workspaceId": "…" }
{ "kind": "issue", "action": "updated", "id": "…", "teamId": "…", "workspaceId": "…", "actorId": "…" }
```

`kind` is one of `issue`, `comment`, `project`, `projectUpdate`, `cycle`, `label`, `team`, `state`, `workspace`,
`member`, `view`, `favorite`, `notification`; `action` is `created`, `updated` or `deleted`. Notification and
favorite events are delivered only to their user. Events are hints — refetch what you display.

Webhooks and a GraphQL API are on the [roadmap](../ROADMAP.md).
