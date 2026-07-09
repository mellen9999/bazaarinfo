# bazaarinfo

Twitch bot + overlay for [The Bazaar](https://www.playthebazaar.com/). Card lookups, trivia, AI chat, and a real-time card overlay for streams.

---

## for streamers

Add the overlay + bot to your channel in a few minutes — full walkthrough in **[docs/streamers.md](docs/streamers.md)**.

- **overlay** — install the *BazaarInfo* extension from your [Twitch Extensions dashboard](https://dashboard.twitch.tv/extensions), grab your Channel ID + Secret from its config page, then run the companion ([latest release](https://github.com/mellen9999/bazaarinfo/releases/latest)) to stream card tooltips to your viewers.
- **chat bot** — type `!join` in [twitch.tv/bazaarinfo](https://twitch.tv/bazaarinfo) and it joins your channel instantly. `!b help` for commands.

TOS-safe (reads the game log, no memory hooks), and only card name, tier, and on-screen position ever leaves your machine. Full steps, command list, and troubleshooting live in the [streamer guide](docs/streamers.md).

---

## self-hosting the bot

### quick start (your own bot account)

1. create a twitch app at [dev.twitch.tv/console](https://dev.twitch.tv/console)
   - OAuth redirect URL: `http://localhost:3000`
   - category: Chat Bot
2. generate an OAuth token for your bot account with scopes: `chat:read chat:edit user:bot user:read:chat user:write:chat channel:bot`
3. clone, install, configure:

```sh
git clone https://github.com/mellen9999/bazaarinfo.git
cd bazaarinfo
bun install
cp .env.example .env   # fill in your creds
bun run packages/bot/src/index.ts
```

first run scrapes [bazaardb.gg](https://bazaardb.gg) and caches locally (~30s). auto-checks for updates every 15 minutes.

### hosting with a shared bot account

if someone else owns the bot account and you want to run an instance using it:

1. create your own twitch app at [dev.twitch.tv/console](https://dev.twitch.tv/console)
   - OAuth redirect URL: `http://localhost:3000`
   - category: Chat Bot
   - copy your **Client ID** and generate a **Client Secret**
2. send your **Client ID** to the bot account owner (the Client ID is not secret)
3. the owner authorizes the bot account through your app and sends you the **token** and **refresh token**
4. fill in your `.env` with your Client ID/Secret and the tokens they gave you

> **important:** two instances can't share the same channels — you'll get double responses. coordinate who runs which channels via `TWITCH_CHANNELS`.

### admin commands

bot admins (`BOT_ADMINS` env var) have full control from any channel:

```
!b update                    re-scrape game data (after a patch)
!b status                    uptime, data age, item counts, memory
!b join <channel>            add bot to a channel
!b part <channel>            remove bot from a channel
!b emote refresh             reload all 7TV emotes
!b alias <slang> = <item>    add shortcut name for an item
!b alias del <slang>         remove a shortcut
!b alias list                show all shortcuts
```

admins also bypass the AI cooldown.

### env

see [`.env.example`](.env.example) for all options. minimum needed:

| var | what |
|-----|------|
| `TWITCH_CHANNELS` | comma-separated channels to join |
| `TWITCH_USERNAME` | bot's twitch username |
| `TWITCH_TOKEN` | OAuth token |
| `TWITCH_REFRESH_TOKEN` | refresh token for auto-renewal |
| `TWITCH_CLIENT_ID` | from [dev.twitch.tv/console](https://dev.twitch.tv/console) |
| `TWITCH_CLIENT_SECRET` | from same app |
| `BOT_OWNER` | your username (unlocks `!b refresh`, etc) |
| `BOT_ADMINS` | comma-separated admin usernames (full chat control) |
| `ANTHROPIC_API_KEY` | for AI features (optional) |

### structure

```
packages/
  shared/      types, search, formatting
  data/        bazaardb.gg scraper
  bot/         IRC + EventSub bot
  ebs/         extension backend (Bun HTTP, port 3100)
  extension/   Twitch overlay (Preact)
  companion/   game log watcher (Python)
```

### tests

```sh
bun test
```

---

data from [bazaardb.gg](https://bazaardb.gg)
