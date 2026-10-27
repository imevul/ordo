# Matrix

1. Register an account for the bot on your homeserver (e.g. `@ordo:example.org`).
2. Get an access token from a fresh login, just for Ordo:

   ```bash
   curl -s https://matrix.example.org/_matrix/client/v3/login -H 'content-type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"ordo"},"password":"…","initial_device_display_name":"Ordo"}'
   ```

   Copy `access_token` from the answer. A token from Element works too without encryption, but not with it (see
   below). Don't log that session out: it would revoke the token.
3. **Settings → Integrations → Matrix → Connect** in Ordo: the homeserver URL, the token, and whether to use
   **end-to-end encryption**.
4. Add rooms by id (`!abc123:example.org`, room settings → Advanced). Ordo joins them, and joins any room the bot is
   invited to.

Ordo long-polls the homeserver (`/sync`), so nothing has to reach Ordo. Messages starting with `!ordo` (or mentioning
the bot) are commands; in a direct chat with the bot, any message is. For a homeserver on your LAN, turn on **Allow
private network targets** in the admin area.

## End-to-end encryption

With **End-to-end encryption** on, the bot reads and writes in encrypted rooms like any Matrix client: commands,
feed posts, thread replies and notifications in encrypted direct chats all work. Ordo uses matrix.org's Rust crypto
(the library Element uses), and creates the direct chats it starts encrypted.

- **The token needs its own device.** Encryption keys belong to the token's device, and a device can only have one
  set. A token copied from Element belongs to a device Element already set up, so connecting fails with a message
  saying so. Use a fresh login (step 2).
- **The keys are kept in Ordo's database**, encrypted with the instance key (`ORDO_SECRET_KEY`), so the bot stays
  the same device across restarts and upgrades. Changing the token starts a new device.
- **The bot's device is unverified.** Element marks its messages with a grey shield. Rooms set to send only to
  verified devices won't share keys with it.
- Messages the bot can't decrypt yet (their key hasn't arrived) are tried again on the next few syncs, then skipped.
- Unencrypted rooms keep working as before.
