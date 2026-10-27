# GraphQL API

Ordo has a GraphQL endpoint per workspace, next to the [REST API](api.md). It covers what scripts and dashboards
usually need — issues with their team, status, people, labels, project, cycle, parent, sub-issues and comments in one
round trip — and the everyday changes: creating, updating, archiving and trashing issues, and commenting.

- **URL:** `POST https://ordo.example.com/api/w/<workspace-slug>/graphql` with a JSON body
  `{ "query": "…", "variables": { … }, "operationName": "…" }`.
- **Auth:** the same as REST: a personal API key as `Authorization: Bearer ordo_…`, or the browser session.
  Workspaces that require SSO refuse API keys unless their admins allow them.
- **Access:** answered from your point of view, as everywhere in Ordo. Teams you can't see, and their issues,
  projects and cycles, don't exist here; `issue(id:)` returns `null` for them.
- **Schema:** introspection is on, so GraphiQL, Altair, Insomnia, Postman or `graphql-codegen` can read it. The
  SDL with descriptions is in [`apps/api/src/services/graphql/schema.ts`](../apps/api/src/services/graphql/schema.ts).

```bash
curl -s https://ordo.example.com/api/w/acme/graphql \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"{ viewer { name } issue(id: \"ENG-42\") { title state { name } assignee { username } } }"}'
```

## Reading

| Query                                                               | Returns                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `viewer`, `workspace`                                               | You; the workspace (with its `url`)                                  |
| `teams`, `team(key:)`                                               | Teams you can see (key or id), with `states`, `members` and `issues` |
| `members`, `labels`, `projects`, `project(id:)`, `cycles(teamKey:)` | The rest of the workspace                                            |
| `issue(id:)`                                                        | An issue by id or identifier, or `null`                              |
| `issues(filter:, first:, after:)`                                   | A page of issues (`IssueConnection`)                                 |
| `search(query:, first:)`                                            | Issues by relevance (titles, descriptions, comments)                 |

An `Issue` has its scalar fields (`identifier`, `title`, `description` in Markdown, `priority` 0–4 and
`priorityLabel`, `estimate`, `dueDate`, timestamps such as `startedAt`, `completedAt`, `archivedAt`, `trashedAt`,
`slaBreachesAt`) plus `team`, `state`, `assignee`, `creator`, `labels`, `project`, `milestone`, `cycle`, `parent`,
`children`, `comments`, `url` and `branchName` (the workspace's git branch format, for you). Timestamps are ISO-8601
strings and calendar dates `YYYY-MM-DD`.

### Pages

`issues`, and the `issues` fields of `Team` and `Project`, return up to `first` issues (default 50, at most 250) and
`pageInfo { hasNextPage endCursor }`. Pass `endCursor` as `after` for the next page. Pages come in id order, so a
cursor stays valid while issues change; sort on your side.

```graphql
query Mine($after: String) {
  issues(
    filter: { assigneeIds: ["me"], stateTypes: [unstarted, started] }
    first: 100
    after: $after
  ) {
    nodes {
      identifier
      title
      priority
      state {
        name
      }
      project {
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

### Filters

`IssueFilter` mirrors the REST filter: `teamId`, `stateIds`, `stateTypes`, `priorities`, `assigneeIds` (ids, `me`
or `none`), `creatorIds` (ids or `me`), `labelIds` (has any), `projectIds`, `milestoneIds`, `cycleIds` (ids or
`none`), `parentId`, `query` (words as prefixes, or an identifier), `subscribedByMe` and `archived` (`include` or
`only`). Fields combine with AND; lists are OR.

## Changing

| Mutation                                    |                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issueCreate(input:)`                       | `teamId` and `title`, plus the other fields; returns the `Issue`                                                                                        |
| `issueUpdate(id:, input:)`                  | Fields left out stay as they are; `null` clears. `labelIds` replaces all labels, `addLabelIds` / `removeLabelIds` change some, `teamId` moves the issue |
| `issueArchive(id:)`, `issueUnarchive(id:)`  | Out of lists, still readable                                                                                                                            |
| `issueTrash(id:)`                           | Into the trash; restore it in the app or with REST                                                                                                      |
| `commentCreate(issueId:, body:, parentId:)` | Markdown; `@username` mentions notify                                                                                                                   |

```graphql
mutation Start($id: ID!, $state: ID!, $me: ID!) {
  issueUpdate(id: $id, input: { stateId: $state, assigneeId: $me }) {
    identifier
    state {
      name
    }
    branchName
  }
  commentCreate(issueId: $id, body: "On it.") {
    id
  }
}
```

Mutations go through the same code as the app: history, subscriptions, notifications, webhooks, realtime updates and
triage rules all happen. Changes made with an API key count as `"source": "api"`. Inputs are validated with the
same rules as REST.

## Errors and limits

- Field errors come back with HTTP 200 next to whatever `data` could be resolved. Each error has
  `extensions.code`: `BAD_USER_INPUT`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `QUERY_TOO_LARGE` or
  `INTERNAL_SERVER_ERROR`.
- Requests that can't run — bad JSON, a syntax error, an unknown field, a query nested deeper than 10 levels
  (`QUERY_TOO_DEEP`, introspection doesn't count) — answer 400. Missing or wrong credentials answer 401
  (`UNAUTHENTICATED`) in the same `{ errors: […] }` shape.
- One request may load at most 5 000 issues and comments altogether (`QUERY_TOO_LARGE`); pages hold at most 250
  issues. Documents are limited to 10 000 tokens and the body to 256 KB.
- 600 requests a minute per user. Only `POST` is accepted.

## From TypeScript and the command line

The [SDK](cli.md#typescript-sdk) has `workspace.graphql(query, variables)`, which resolves to `data` and throws
`OrdoError` (with the error's `code`) on errors. The CLI can send any request:

```bash
ordo api POST /w/acme/graphql --data '{"query":"{ teams { key name } }"}'
```
