# Slack

There are two ways to connect Slack: **Add to Slack** (one click per workspace, once an instance admin has set up
the instance's Slack app) and **Manual** (a Slack app per Ordo workspace, tokens pasted by hand).

## Add to Slack

Needs Ordo on an **https** address (`ORDO_PUBLIC_URL`): Slack only sends people back to https.

**Once per instance (an instance admin):** Settings → Integrations → Slack → Connect → **Add to Slack**.

1. Choose how Slack reaches Ordo: **Events API** (Slack posts to `/api/hooks/slack/app`; Ordo must be reachable
   from the internet) or **Socket Mode** (Ordo keeps a connection open to Slack; works behind NAT).
2. **Create the Slack app**: opens Slack with Ordo's manifest filled in. Pick the Slack workspace that owns the app.
   To let other Slack workspaces install it, turn on **Manage Distribution** in the app's settings.
3. Paste the **Client ID**, **Client Secret** and **Signing Secret** (Basic Information → App Credentials). For
   Socket Mode also an **app-level token** (App-Level Tokens → Generate, scope `connections:write`).

**Then, in any Ordo workspace (a workspace admin):** Settings → Integrations → Slack → Connect → **Add to Slack**,
approve in Slack, done. Add channels in the integration's settings and invite the app to each (`/invite @Ordo`).

One Slack workspace connects to one Ordo workspace. Removing the integration revokes its token. Changing the app's
delivery (Events API ↔ Socket Mode) switches every connected workspace.

## Manual

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From an app manifest**, pick your
   workspace and paste the manifest below (replace `ordo.example.com` with your Ordo host). For **Socket Mode**, set
   `socket_mode_enabled: true` and remove the `request_url`s.
2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
3. Events API: copy the **Signing Secret** (Basic Information). Socket Mode: create an **App-Level Token** with the
   `connections:write` scope (`xapp-…`).
4. **Settings → Integrations → Slack → Connect** in Ordo. The URL to use in the manifest is shown in the
   integration's settings once connected (`/api/hooks/slack/<key>`); update the app's request URLs with it.
5. Add channels (ids look like `C0123ABCD`) and invite the app to each: `/invite @Ordo`.

```yaml
display_information:
  name: Ordo
features:
  bot_user:
    display_name: Ordo
    always_online: true
  slash_commands:
    - command: /ordo
      url: https://ordo.example.com/api/hooks/slack/KEY
      description: Link your account, create issues
      usage_hint: link CODE · new [TEAM] title · help
  shortcuts:
    - name: Create Ordo issue
      type: message
      callback_id: create_issue
      description: File this message as an issue
  unfurl_domains:
    - ordo.example.com
oauth_config:
  scopes:
    bot:
      [
        app_mentions:read,
        channels:history,
        chat:write,
        commands,
        groups:history,
        im:history,
        links:read,
        links:write,
        users:read,
      ]
settings:
  event_subscriptions:
    request_url: https://ordo.example.com/api/hooks/slack/KEY
    bot_events: [app_mention, link_shared, message.channels, message.groups, message.im]
  interactivity:
    is_enabled: true
    request_url: https://ordo.example.com/api/hooks/slack/KEY
  socket_mode_enabled: false
```

Requests are checked against the signing secret and rejected when older than five minutes.

Apps made before thread sync lack `channels:history`, `groups:history` and the `message.channels` /
`message.groups` events: add them under **OAuth & Permissions** and **Event Subscriptions**, then reinstall the app,
or replies in threads won't reach Ordo.
