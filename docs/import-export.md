# Importing data

Workspace admins can bring issues in from other tools: **CSV files**, **Linear**, **GitHub Issues**,
**Forgejo/Gitea**, **GitLab** and **Jira**, and [export](#exporting) a workspace as JSON or CSV. It all happens under
**Settings → Import & export**, or through the [API](api.md#imports).

## How an import runs

1. **Upload.** Ordo stores the file and analyzes it: which teams, statuses, people, labels and projects it
   mentions, and how many issues there are.
2. **Map.** Ordo suggests where everything goes, and you can change any of it:
   - **Teams** go to an existing team (matched by key, then name), a new team, or nowhere.
   - **Statuses** go to a status of the target team (matched by name, then by kind: "In Review" is a started
     status, "Won't fix" a cancelled one), or to a kind of status for new teams.
   - **People** are matched to members by email, then by name or username. Anyone else gets a
     [placeholder](#placeholders), or you can leave their issues unassigned.
   - **Labels** and **projects** are matched by name; the rest are created.
   - **Keep numbers**: issues keep their source numbers (`ENG-42` stays `ENG-42`) in teams that are new or have no
     issues yet. Elsewhere they're numbered from the team's counter.
3. **Dry run** (optional, repeatable). Reports what the import would create, what it would skip and why, and any
   warnings, without changing the workspace.
4. **Run.** Issues are created in pages by background jobs. You can cancel; what's imported so far stays.

What an import keeps: titles, descriptions, statuses, priorities, assignees, creators, labels, projects,
estimates, due dates, sub-issues, and when issues were created, updated and completed. From sources that have them
it also keeps comments (with their authors, dates and threads), relations (blocks, related, duplicate — a
duplicate keeps the status it had), cycles and links. Each issue links back to where it came from. Imports are
silent: nobody is notified and no webhooks fire.

Running an import again (after a failure, a cancel, or to be sure) skips everything it already imported.
**Forgetting** an import only deletes it and its file; the imported issues stay.

**Undo** moves every issue an import created to the trash, where each can still be restored. Teams, labels,
projects and placeholders it made stay (removing them would take them off the trashed issues too); delete them by
hand if you don't need them. An undone import can't be run again: start a new one.

## Linear

Create a personal API key in Linear (in your account's settings, next to its security settings) and start an
import with it (`POST /imports` with `{ "source": "linear", "apiKey": "lin_api_…" }`). Ordo checks the key, keeps
it encrypted until you delete the import, and reads the whole workspace the key can see:

- Teams keep their keys, statuses map by name, and issue numbers stay the same in new teams.
- Labels with the same name in several Linear teams become one label; label groups aren't imported.
- Projects keep their status, dates, lead (if a member) and teams.
- Cycles are imported into teams the import creates. Existing teams have cycles of their own, so their Linear
  cycles are left out (the report says so).
- Pull requests and other attachments become links on their issues.
- Archived issues aren't imported, nor are Linear's "similar issue" suggestions.

Linear limits how fast an API key can read. A large workspace may hit that limit; the import then waits and carries
on by itself, and says so while it waits.

## GitHub Issues

Start an import with a token that can read the repositories' issues (a fine-grained token with read access to
Issues and Metadata, or a classic token with `repo` for private repositories):

```json
{ "source": "github", "token": "github_pat_…", "repos": ["acme/app", "acme/site"] }
```

For GitHub Enterprise Server, add `"apiUrl": "https://github.example.com/api/v3"`. Ordo checks it can see every
repository, keeps the token encrypted until you delete the import, and then:

- Makes each repository a source team (named after the repository), with the statuses **Open**, **Closed**, and
  **Closed as not planned** or **as duplicate** (cancelled).
- Keeps issue numbers in new teams; numbers that belonged to pull requests are simply missing.
- Merges labels with the same name across repositories, and turns milestones into projects (open ones planned,
  closed ones completed, with their due dates).
- Matches people by the GitHub usernames members claimed under **Account → Connected accounts**, then by name;
  everyone else, including people who only commented, gets a placeholder.
- Imports comments. Pull requests and their comments are left out, as are GitHub's sub-issues for now.

Analysis reads every issue and comment once, to count them and to find everyone involved. GitHub's rate limits
apply; a large import may pause and carry on by itself.

## Forgejo and Gitea

Works like GitHub (Codeberg included), with the server's address and an access token that can read issues:

```json
{ "source": "forgejo", "baseUrl": "https://codeberg.org", "token": "…", "repos": ["acme/tools"] }
```

Issues are **Open** or **Closed**. People match by the usernames members claimed for that server, then by email
(when the server shares a real one) or name.

## GitLab

For gitlab.com or a self-managed GitLab, with an access token with the `read_api` scope and the projects' full
paths:

```json
{
  "source": "gitlab",
  "baseUrl": "https://gitlab.com",
  "token": "glpat-…",
  "projects": ["acme/backend/api"]
}
```

- Each project becomes a source team named after it; issues keep their numbers (`#12` becomes `API-12`) and are
  **Open** or **Closed**.
- Milestones become projects, group milestones included; weights become estimates; due dates stay.
- Comments are the issues' notes, without GitLab's own system notes ("added ~bug label").
- People match by the usernames members claimed, then by name.
- Related issues, child tasks and epics aren't imported.

## Jira

Jira Cloud and Jira Data Center both work. For Cloud, use your account's email and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens); for Data Center, a personal access token
(leave out the email):

```json
{
  "source": "jira",
  "siteUrl": "https://acme.atlassian.net",
  "email": "you@acme.com",
  "token": "…",
  "projects": ["ENG"]
}
```

Leave out `projects` to import every project the credentials can see. Ordo checks the credentials and projects,
keeps the token encrypted until you delete the import, and then:

- Makes each project a source team with its key; statuses map by name, or by their category (to do, in progress,
  done) when the name says nothing.
- Turns epics into projects (their assignee leads, if a member), and puts the epic's issues in them — through the
  issue's parent on Cloud, or the "Epic Link" field on Data Center.
- Makes sub-tasks sub-issues, and issue types (Bug, Story, Task…) and components labels.
- Keeps story points as estimates, and blocks, duplicates and other issue links as relations.
- Converts descriptions and comments from Jira's wiki markup to Markdown: headings, emphasis, links, lists,
  quotes, code and tables. Mentions become `@name`, or `@someone` where Jira only gives an account id.
- Doesn't import sprints, attachments or worklogs; each issue links back to Jira.

Analysis reads every issue and its comments once, to count them and find everyone involved.

## Placeholders

A placeholder stands in for someone the source mentions who isn't a member. Their name appears on the issues they
created and were assigned, with an **imported** tag, but a placeholder can't sign in, isn't notified, can't be
mentioned and can't be picked as an assignee. Later imports that mention the same person reuse their placeholder.

When the person joins, an admin merges the placeholder into their account under **People from imports** (the
list suggests the member with the same email or name). Everything moves over: issues they created or were assigned,
comments, history, subscriptions. Issues in teams the member can't see lose their assignee instead. The placeholder
is then gone.

## CSV files

The first row holds the column names. Commas, semicolons and tabs all work, as do quoted values with line breaks.
Ordo recognises the columns Linear, Jira, GitHub and most spreadsheets use, and you can change which column feeds
which field:

| Field       | Recognised column names                | Notes                                          |
| ----------- | -------------------------------------- | ---------------------------------------------- |
| ID          | ID, Identifier, Key, Issue key, Number | `ENG-42` or `42`; used for parents and numbers |
| Title       | Title, Summary, Name, Subject          | Rows without one are skipped                   |
| Description | Description, Body, Details             | Markdown                                       |
| Team        | Team                                   | Without it, the whole file is one source team  |
| Status      | Status, State                          |                                                |
| Priority    | Priority                               | 0–4, or Urgent / High / Medium / Low and kin   |
| Assignee    | Assignee, Assigned to, Owner           | Email or name; the first of several            |
| Creator     | Creator, Reporter, Created by, Author  | Unknown creators become you                    |
| Labels      | Labels, Tags                           | Separated by commas, semicolons or `\|`        |
| Project     | Project, Epic, Milestone               |                                                |
| Parent      | Parent, Parent issue                   | The parent's ID                                |
| Estimate    | Estimate, Story points, Points         | Rounded; 0–100                                 |
| Due date    | Due date, Due                          |                                                |
| Dates       | Created, Updated, Completed, Resolved  | Any format JavaScript's `Date` reads           |
| URL         | URL, Link                              | Becomes a link on the issue                    |

Files can be up to 25 MB and 50 000 rows.

## Exporting

Admins export a workspace under **Settings → Import & export**, as JSON or as CSV. A background job writes the
file, and a download link appears when it's ready. Exports are kept for a week, one runs at a time, and
each is recorded in the audit log.

- **JSON** holds everything that belongs to the workspace as a whole: members (with emails), placeholders, teams
  with their statuses and members, labels, projects and their updates, cycles, shared views, and every issue
  (private teams' and trashed ones too) with comments, history, relations and links.
- **CSV** holds the issues that aren't in the trash, in the columns the CSV import reads: an export imports into
  another workspace or instance as it is, sub-issues and labels included.

Personal things (private views, favourites, notifications) aren't exported, nor is anything secret (integrations,
webhooks, SSO settings, passwords).
