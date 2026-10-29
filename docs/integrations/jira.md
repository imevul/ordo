# Jira

Connect Jira Cloud or Jira Data Center under **Settings → Integrations → Jira**, and choose what it does:

| Mode             | What happens                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Links only**   | Jira keys (`PROJ-123`) and URLs in Ordo issues and comments become links showing the Jira issue's status. Jira gets a link back to the Ordo issue. Ordo issue URLs in a Jira issue link it the other way. |
| **Mirror**       | Jira is the source of truth. Issues of the mapped projects appear in their Ordo team and follow Jira: title, description, status, priority, assignee and new comments. Ordo writes nothing to Jira.       |
| **Two-way sync** | The mirror, plus Ordo changes to synced issues go to Jira: title, description, status, priority, assignee and new comments. New Ordo issues in a mapped team can be created in Jira.                      |

Links work in every mode.

## Connecting

1. Credentials:
   - **Cloud**: your Atlassian email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
   - **Data Center**: a personal access token (profile → Personal access tokens); leave the email empty.

   Ordo acts in Jira as that account, so a dedicated "Ordo" account keeps Jira's history readable.
2. The Jira URL, e.g. `https://acme.atlassian.net`.
3. For mirror and sync, map each Jira project key to an Ordo team. Per project, choose whether new Jira issues
   appear in Ordo and (sync) whether new Ordo issues are created in Jira, and with which issue type.
4. How Ordo hears about changes:
   - **Webhook**: once connected, the integration's settings show a URL. A Jira admin adds it under **System →
     WebHooks** with the events _Issue created, updated, deleted_ and _Comment created_. To have Ordo accept only
     signed deliveries, enter the same secret in both places. Jira must be able to reach Ordo.
   - **Polling**: Ordo asks Jira for changed issues every two minutes. Use this when Jira can't reach Ordo.

## How syncing behaves

- **Fields.** Title, description (Jira wiki markup ↔ Markdown), status, priority and assignee. Ordo remembers each
  issue's Jira values as of the last sync and only moves fields that actually changed, so an edit doesn't bounce back
  and forth. When both sides change the same field, the later change wins.
- **Status.** A Jira status maps to the Ordo status with the same name, else to the first of the same kind (to do, in
  progress, done). Ordo → Jira moves the issue through a transition to the status with the same name, else of the
  same kind; if there's no such transition, the status stays.
- **People.** Assignees match by email, or by a unique name when Jira hides emails (Jira Cloud usually does).
  Comments from Jira show under the matching member only on an email match; otherwise they're posted by the Jira
  bot with the author's name. Ordo comments arrive in Jira with their author's name.
- **Comments** are synced as they're written; edits and deletions aren't.
- **Existing issues.** Mirror and sync pick up issues as they change. To bring a project over in one go, run the
  [Jira importer](../user-guide.md) first, then connect: issues the importer brought in are adopted by the sync,
  not created again.
- Epics aren't mirrored as issues. Deleting an issue on either side doesn't delete it on the other; a deleted Jira
  issue shows as such on its link.

Mirror mode doesn't stop people editing mirrored issues in Ordo; such edits stay in Ordo until the same field changes
in Jira.
