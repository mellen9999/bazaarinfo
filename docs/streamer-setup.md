# bazaarinfo for streamers

A Twitch overlay + chat bot for [The Bazaar](https://www.playthebazaar.com/). Your viewers hover any card on your board to see its stats, tier, and abilities — and your chat gets instant card lookups, trivia, and AI answers.

Free, open source, and self-hostable.

---

## is this safe?

- **TOS-safe.** The overlay reads your game's log file (`Player.log`) that The Bazaar writes on its own. No memory reading, no code injection, no game modification. Nothing touches the game process.
- **You run the reader locally.** A small companion app on your machine watches the log and sends only what's needed.
- **Minimal data leaves your machine.** Only the card's name, tier, and on-screen position — never account info, never your inputs, never anything else. It goes to the overlay backend and straight to your viewers.
- **Opt-in and reversible.** You install it, you configure it, you can remove it any time. Nothing runs unless you start it.

### verify your download

Every release ships checksums and GitHub build provenance:

- **checksum** — the release includes a `SHA256SUMS` file. Hash your download (`certutil -hashfile bazaarinfo-companion-windows.exe SHA256` on Windows, `sha256sum` on Linux) and compare.
- **provenance** — `gh attestation verify bazaarinfo-companion-windows.exe --repo mellen9999/bazaarinfo` cryptographically proves the exe was built by this repo's public CI from the tagged source. The build logs themselves are public.
- **run from source** — the companion is a single readable Python file. If you'd rather not run any binary: `python packages/companion/logwatch.py`.

Windows SmartScreen may warn on first run — the exe is unsigned (signing certs are a paid identity service). The provenance check above is the stronger, free equivalent.

---

## the overlay

Real-time card tooltips on your stream. Viewers in fullscreen hover a card to see it.

### 1. install the extension

1. open your [Twitch Dashboard → Extensions](https://dashboard.twitch.tv/extensions)
2. search **BazaarInfo** in the extension manager
3. **Install**, then **Activate** it as an Overlay
4. it now shows on your video for every viewer

### 2. get your credentials

1. in the extension manager, find BazaarInfo → **Configure**
2. you'll see your **Channel ID** and **Companion Secret**
3. keep this page open — you need both in the next step

Your secret is unique to your channel. Don't share it; it's the only thing that lets the overlay accept card data as yours.

**shown it on stream by accident?** Open the extension's Configure view and press **rotate** — it issues a new secret and the old one stops working immediately. Copy the new one into `config.ini` (or your `EBS_SECRET` env var) and restart the companion.

### 3. run the companion

**Windows**

1. download **`bazaarinfo-companion-windows.exe`** from [GitHub Releases](https://github.com/mellen9999/bazaarinfo/releases/latest)
2. double-click to run
3. paste in your **Channel ID** and **Companion Secret** when asked
4. settings save to `config.ini` next to the exe — you only do this once (if that folder is read-only, it saves to `%APPDATA%\bazaarinfo` instead and tells you)

> **SmartScreen warning?** The exe isn't code-signed, so Windows may warn. Click **More info → Run anyway** — or run from source instead (below).

**Linux**

```sh
chmod +x bazaarinfo-companion-linux
./bazaarinfo-companion-linux
```

Works with native and Proton/Steam. First run asks for your Channel ID and Secret.

**From source (any OS)**

```sh
git clone https://github.com/mellen9999/bazaarinfo.git
cd bazaarinfo/packages/companion
pip install -r requirements.txt
python logwatch.py          # first run prompts for Channel ID + Secret
```

### 4. play

1. launch The Bazaar on Steam and go live
2. the companion detects your cards automatically and sends them to the overlay
3. viewers in fullscreen hover a card to see its tooltip

Leave the companion open — it waits patiently if the game isn't running yet.

> **capture the game 16:9, filling the frame** for the best out-of-the-box fit. Card positions are mapped to a standard 16:9 layout, so this lines up perfectly with no extra setup. If you play ultrawide/4:3, or box the game inside borders or a webcam-heavy scene, use the alignment tool in the extension's Configure view to calibrate your layout once — it corrects the overlay to match. This scales to any viewer resolution (720p → 4K, desktop or mobile).

### 5. battlegrounds (optional, automatic)

If Hearthstone is installed on the same machine, the companion also follows your
Battlegrounds games — so the chat bot can answer "what's on his board", "what tier is
he", "who's he fighting" and "what place is he in" with what's actually happening.

Nothing to set up. The companion finds Hearthstone on its own and, if Power logging
isn't on yet, switches it on (it appends a `[Power]` section to Hearthstone's
`log.config` and leaves any other tracker's settings alone). Restart Hearthstone once
after first run and it starts working.

Already running Hearthstone Deck Tracker? Then logging is on already and there is
nothing to do at all. The two don't conflict — HDT keeps drawing the board for your
viewers, and this only feeds the chat bot.

What the bot can see: your minions and their stats, your hero, tavern tier, health and
placement, the lobby's standings, and your opponent during a fight — all of it already
on screen. What it can't see, and never claims to: your shop and your hand.

Don't want it? It only runs while the companion does. There is no separate switch
because there is nothing separate running.

### companion flags

```
--setup       re-run first-time setup (overwrites config.ini)
--config PATH use this config file instead of the default location
--debug       verbose logging
--log PATH    override the Player.log location
--version     show version
```

`--config` matters when the exe's own folder is read-only — settings fall back to `%APPDATA%\bazaarinfo` in that case (see step 3), and `--config` points the companion at that file directly instead of relying on the fallback search.

### keeping your secret off disk

Set the `EBS_SECRET` environment variable instead of putting it in `config.ini` — the companion uses it automatically and never writes it to a file. Leave `secret` out of `config.ini` entirely when doing this.

---

## the chat bot

Card info straight from your chat. Works in any channel it has joined.

### add it to your channel

1. go to [twitch.tv/bazaarinfo](https://twitch.tv/bazaarinfo)
2. type `!join` in that chat
3. the bot joins yours instantly — type `!b help` in your channel to confirm

To remove it later, type `!part` back in the bazaarinfo channel.

### commands

```
!b <item> [tier] [enchant]   card lookup (fuzzy matched)
!b hero <name>               list a hero's items
!b mob <name>                monster stats + skills
!b skill <name>              skill details
!b tag <tag>                 items by tag
!b day <n>                   monsters by encounter day
!b enchants                  list all enchantments
!b trivia [category]         start a trivia round
!b score                     trivia leaderboard
!b stats [@user]             player trivia stats
!b top                       most active chatters
!b <question>                ask anything (AI)
!b overlay                   this setup guide (share it with other streamers)
!b help                      show usage
```

Only the `!b` prefix — nothing else is hijacked from your chat.

---

## troubleshooting

| problem | fix |
|---------|-----|
| companion says "waiting for Player.log" | launch The Bazaar once — the log is created on first game start |
| companion says "cards.json not found" | launch The Bazaar into a run once — cards.json is written on first play |
| overlay not visible | confirm the extension is **activated**, not just installed. viewers must click the overlay icon on the video player, in fullscreen |
| hover-zones don't line up with the cards | run the alignment tool in the extension's Configure view to calibrate for your capture (ultrawide, 4:3, borders, webcam boxing — all fixable) |
| opponent cards or skills have no tooltip | expected — the game doesn't expose opponent/skill names to your client, so those aren't shown (only your named items are) |
| cards linger after they leave your board | the overlay self-clears if the companion goes quiet; if it persists, the companion likely crashed — restart it |
| "the server rejected your Channel ID or Secret" | re-run with `--setup` and re-paste both from the extension's Configure page — the companion checks them at startup, so this never surprises you mid-stream |
| SmartScreen blocks the exe | **More info → Run anyway** |
| companion crashes on startup | delete `config.ini` next to the exe and re-run to reconfigure |
| it asks for your Channel ID every launch | you're on v1.0.5 or older — grab the latest release; older builds saved settings to a temp folder Windows wipes |

---

## how it works

```
The Bazaar (game)
    ↓ writes Player.log
Companion (runs on your machine)
    ↓ parses card events, sends card name + position
Overlay backend (ebs.bazaarinfo.com)
    ↓ broadcasts to your viewers via Twitch PubSub
Extension overlay (viewer's browser)
    ↓ renders card tooltips on hover

Hearthstone (game)
    ↓ writes Power.log
Companion (same program, same machine)
    ↓ parses the battlegrounds board, sends card ids + stats
Overlay backend
    ↓ stored for your channel only — never broadcast to viewers
Chat bot
    ↓ answers questions about your live board
```

Each streamer is fully isolated: your companion secret only unlocks your channel, and your card data only ever reaches your own viewers.

---

## privacy

- what leaves your machine: **card name, tier, and on-screen position — nothing else**
- from Hearthstone: **your board, hero, tier, health, placement and current opponent — all of it already visible on your own stream.** Not your shop, not your hand, not your battletag (the companion never reads the log lines that carry it)
- what never leaves: account details, inputs, chat, screenshots, game files
- the companion is local and opt-in; stop it any time
- full [privacy policy](../PRIVACY.md) and [terms](../TERMS.md)

data from [bazaardb.gg](https://bazaardb.gg). questions or issues → [open one on GitHub](https://github.com/mellen9999/bazaarinfo/issues).
