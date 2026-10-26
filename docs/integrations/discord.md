# Discord

1. Create an application at [discord.com/developers](https://discord.com/developers/applications). Copy the
   **Application ID** and the **Public Key** (General Information).
2. **Bot**: reset and copy the token. For the gateway, turn on the **Message Content** intent.
3. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`; permissions View Channels, Send Messages,
   Embed Links, Read Message History. Open the URL to add the bot to your server.
4. **Settings → Integrations → Discord → Connect** in Ordo, and pick how Discord reaches Ordo:
   - **Interactions endpoint**: paste the webhook URL Ordo shows in the integration's settings into **Interactions
     Endpoint URL** (General Information). Discord verifies it with a signed ping.
   - **Gateway**: Ordo connects to Discord, so nothing has to reach Ordo. Leave the interactions endpoint empty. The
     gateway also answers `!ordo …` messages and replies, and previews issue links.
5. Add channels by id (developer mode → right-click → **Copy Channel ID**).

Ordo registers `/ordo` and the **Create Ordo issue** message command when it connects. Global commands can take a
few minutes to appear. Answers to commands are visible only to you.
