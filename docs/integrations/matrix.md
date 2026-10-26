# Matrix

1. Register an account for the bot on your homeserver (e.g. `@ordo:example.org`).
2. Get its access token: sign in with Element and copy it from **Settings → Help & About → Access token**, or call
   `POST /_matrix/client/v3/login`. Don't log that session out, it would revoke the token.
3. **Settings → Integrations → Matrix → Connect** in Ordo: the homeserver URL and the token.
4. Add rooms by id (`!abc123:example.org`, room settings → Advanced). Ordo joins them, and joins any room the bot is
   invited to.

Ordo long-polls the homeserver (`/sync`), so nothing has to reach Ordo. Messages starting with `!ordo` (or mentioning
the bot) are commands; in a direct chat with the bot, any message is. End-to-end encrypted rooms aren't supported:
use unencrypted rooms for the bot. For a homeserver on your LAN, turn on **Allow private network targets** in the
admin area.
