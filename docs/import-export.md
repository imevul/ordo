# Importing data

Workspace admins can bring issues in from other tools. Imports so far read **CSV files**; importers for Linear,
GitHub Issues and Jira, workspace export, and a settings page for all of it are on the
[roadmap](../ROADMAP.md#phase-9--importers-and-export). Until the page lands, imports run through the
[API](api.md#imports).

## How an import runs

1. **Upload.** Ordo stores the file and analyzes it: which teams, statuses, people, labels and projects it
   mentions, and how many issues there are.
2. **Map.** Ordo suggests where everything goes, and you can change any of it:
   - **Teams** go to an existing team (matched by key, then name), a new team, or nowhere.
   - **Statuses** go to a status of the target team (matched by name, then by kind: "In Review" is a started
     status, "Won't fix" a cancelled one), or to a kind of status for new teams.
   - **People** are matched to members by email, then by name or username. Unmatched people leave their issues
     unassigned.
   - **Labels** and **projects** are matched by name; the rest are created.
   - **Keep numbers**: issues keep their source numbers (`ENG-42` stays `ENG-42`) in teams that are new or have no
     issues yet. Elsewhere they're numbered from the team's counter.
3. **Dry run** (optional, repeatable). Reports what the import would create, what it would skip and why, and any
   warnings, without changing the workspace.
4. **Run.** Issues are created in pages by background jobs. You can cancel; what's imported so far stays.

What an import keeps: titles, descriptions, statuses, priorities, assignees, creators, labels, projects,
estimates, due dates, sub-issues, and when issues were created, updated and completed. Each issue links back to
its source URL when the file has one. Imports are silent: nobody is notified and no webhooks fire.

Running an import again (after a failure, a cancel, or to be sure) skips everything it already imported. Deleting
an import only forgets it and its file; the imported issues stay.

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
