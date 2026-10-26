# Slack

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
    bot: [app_mentions:read, chat:write, commands, im:history, links:read, links:write, users:read]
settings:
  event_subscriptions:
    request_url: https://ordo.example.com/api/hooks/slack/KEY
    bot_events: [app_mention, message.im, link_shared]
  interactivity:
    is_enabled: true
    request_url: https://ordo.example.com/api/hooks/slack/KEY
  socket_mode_enabled: false
```

Requests are checked against the signing secret and rejected when older than five minutes.
