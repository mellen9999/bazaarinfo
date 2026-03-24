# bazaarinfo

Twitch bot + overlay for [The Bazaar](https://www.playthebazaar.com/). Card lookups, trivia, AI chat, and a real-time card overlay for streams.

---

## stream overlay

Shows real-time card tooltips on your stream. Viewers can hover over any card on your board to see its stats, tier, and abilities.

The overlay reads your game's log file — no memory hooks, no game modification, fully TOS-safe.

### setup (windows)

**step 1: install the extension**

1. go to your [Twitch Dashboard](https://dashboard.twitch.tv/extensions)
2. search **BazaarInfo** in the extension manager
3. click **Install**, then **Activate** as an Overlay
4. the overlay appears on the video for all viewers

**step 2: get your credentials**

1. in the Twitch extension manager, find BazaarInfo and click **Configure**
2. you'll see your **Channel ID** and **Companion Secret**
3. keep this page open — you'll need both values in the next step

**step 3: download and run the companion**

1. go to [GitHub Releases](https://github.com/mellen9999/bazaarinfo/releases/latest)
2. download **`bazaarinfo-companion-windows.exe`**
3. double-click the exe to run it
4. it will ask for your **Channel ID** and **Companion Secret** — paste them in
5. settings are saved to `config.ini` next to the exe (you only do this once)

> **Windows Defender:** you may see a SmartScreen warning since the exe isn't code-signed. Click **More info** → **Run anyway**. The source code is fully open.

**step 4: play**

1. launch The Bazaar on Steam
2. go live on Twitch
3. the companion detects your cards automatically and sends them to the overlay
4. viewers in fullscreen can hover over cards to see tooltips

the companion waits if the game isn't running yet — just leave it open.

### setup (linux)

same as above, but download **`bazaarinfo-companion-linux`** from releases instead:

```sh
chmod +x bazaarinfo-companion-linux
./bazaarinfo-companion-linux
```

works with both native and Proton/Steam.

### setup (python — manual)

if you'd rather run from source:

```sh
git clone https://github.com/mellen9999/bazaarinfo.git
cd bazaarinfo/packages/companion
pip install -r requirements.txt
python logwatch.py
```

first run will prompt for your Channel ID and Secret. to reconfigure later:

```sh
python logwatch.py --setup
```

### companion flags

```
--setup      re-run first-time setup (overwrites config.ini)
--debug      verbose logging
--log PATH   override Player.log location
--version    show version
```

### troubleshooting

| problem | fix |
|---------|-----|
| companion says "waiting for Player.log" | launch The Bazaar — the log is created on first game start |
| companion says "cards.json not found" | The Bazaar isn't installed via Steam, or hasn't been run once |
| overlay not visible | check the extension is activated (not just installed). viewer must click the overlay icon on the video player |
| "unauthorized" from EBS | re-run with `--setup` and re-enter your secret from the config page |
| SmartScreen blocks the exe | click **More info** → **Run anyway** |
| companion crashes on startup | delete `config.ini` next to the exe and re-run to reconfigure |

### how it works

```
The Bazaar (game)
    ↓ writes Player.log
Companion (logwatch.py)
    ↓ parses card events, POSTs to EBS
EBS (ebs.bazaarinfo.com)
    ↓ broadcasts via Twitch PubSub
Extension overlay (viewer's browser)
    ↓ renders card tooltips on hover
```

---

## chat bot

Card info straight from Twitch chat. Works in any channel the bot has joined.

### add to your channel

1. go to [twitch.tv/bazaarinfo](https://twitch.tv/bazaarinfo)
2. type `!join` in chat
3. the bot joins your channel instantly — type `!b help` to confirm

to remove: type `!part` in the bazaarinfo channel.

### commands

```
!b <item> [tier] [enchant]   card lookup (fuzzy matched)
!b hero <name>               list hero's items
!b mob <name>                monster stats + skills
!b skill <name>              skill details
!b tag <tag>                 items by tag
!b day <n>                   monsters by encounter day
!b enchants                  list all enchantments
!b trivia [category]         start a trivia round
!b score                     trivia leaderboard
!b stats [@user]             player trivia stats
!b top                       channel trivia leaders
!b <question>                ask anything (AI)
!b help                      show usage
```

---

## self-hosting the bot

if you want to run your own instance:

```sh
bun install
cp .env.example .env   # fill in your creds
bun run packages/bot/src/index.ts
```

first run scrapes [bazaardb.gg](https://bazaardb.gg) and caches locally (~1-2 min). auto-refreshes daily.

### env

see [`.env.example`](.env.example) for all options. minimum needed:

| var | what |
|-----|------|
| `TWITCH_CHANNELS` | comma-separated channels to join |
| `TWITCH_USERNAME` | bot's twitch username |
| `TWITCH_TOKEN` | OAuth token (`chat:read chat:edit` scopes) |
| `TWITCH_REFRESH_TOKEN` | refresh token for auto-renewal |
| `TWITCH_CLIENT_ID` | from [dev.twitch.tv/console](https://dev.twitch.tv/console) |
| `TWITCH_CLIENT_SECRET` | from same app |
| `BOT_OWNER` | your username (unlocks `!b refresh`, etc) |
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
