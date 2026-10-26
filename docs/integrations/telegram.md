# Telegram

1. Talk to [@BotFather](https://t.me/BotFather): `/newbot`, then copy the token (`123456:ABC…`).
2. Optional: `/setcommands` with `new - Create an issue`, `link - Link your Ordo account`, `help - Commands`.
3. To preview issue links in groups, `/setprivacy` → Disable (otherwise the bot only sees commands).
4. **Settings → Integrations → Telegram → Connect** in Ordo, and pick:
   - **Webhook**: Ordo registers its URL with Telegram, with a secret Telegram sends back on every update. Telegram
     needs to reach Ordo over HTTPS on port 443, 80, 88 or 8443.
   - **Long polling**: Ordo asks Telegram for updates, so nothing has to reach Ordo.
5. Add the bot to your groups and add them as channels by chat id (a negative number; forward a group message to
   [@userinfobot](https://t.me/userinfobot) to see it).

Link your account in a **private chat** with the bot (`/link CODE`): Telegram bots can only message people who've
talked to them first.
