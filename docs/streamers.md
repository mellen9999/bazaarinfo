# bazaarinfo for streamers

A Twitch overlay + chat bot for [The Bazaar](https://www.playthebazaar.com/). Your viewers hover any card on your board to see its stats, tier, and abilities — and your chat gets instant card lookups, trivia, and AI answers.

Free, open source, and self-hostable. Works for any Bazaar streamer, not just the big ones.

---

## is this safe?

Yes — and here's exactly why, because you should never trust a stream tool that hand-waves this.

- **TOS-safe.** The overlay reads your game's log file (`Player.log`) that The Bazaar writes on its own. No memory reading, no code injection, no game modification. Nothing touches the game process.
- **You run the reader locally.** A small companion app on your machine watches the log and sends only what's needed.
- **Minimal data leaves your machine.** Only the card's name, tier, and on-screen position — never account info, never your inputs, never anything else. It goes to the overlay backend and straight to your viewers.
- **Opt-in and reversible.** You install it, you configure it, you can remove it any time. Nothing runs unless you start it.

The full source is public — read it, build it yourself if you want.

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

### 3. run the companion

**Windows**

1. download **`bazaarinfo-companion-windows.exe`** from [GitHub Releases](https://github.com/mellen9999/bazaarinfo/releases/latest)
2. double-click to run
3. paste in your **Channel ID** and **Companion Secret** when asked
4. settings save to `config.ini` next to the exe — you only do this once

> **SmartScreen warning?** The exe isn't code-signed, so Windows may warn. Click **More info → Run anyway**. The source is fully open if you'd rather build it yourself.

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

### companion flags

```
--setup      re-run first-time setup (overwrites config.ini)
--debug      verbose logging
--log PATH   override the Player.log location
--version    show version
```

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
!b top                       channel trivia leaders
!b <question>                ask anything (AI)
!b help                      show usage
```

Only the `!b` prefix — nothing else is hijacked from your chat.

---

## troubleshooting

| problem | fix |
|---------|-----|
| companion says "waiting for Player.log" | launch The Bazaar once — the log is created on first game start |
| companion says "cards.json not found" | The Bazaar isn't installed via Steam, or hasn't been run yet |
| overlay not visible | confirm the extension is **activated**, not just installed. viewers must click the overlay icon on the video player, in fullscreen |
| cards linger after they leave your board | the overlay self-clears if the companion goes quiet; if it persists, the companion likely crashed — restart it |
| "unauthorized" from the server | re-run the companion with `--setup` and re-paste your secret from the config page |
| SmartScreen blocks the exe | **More info → Run anyway** |
| companion crashes on startup | delete `config.ini` next to the exe and re-run to reconfigure |

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
```

Each streamer is fully isolated: your companion secret only unlocks your channel, and your card data only ever reaches your own viewers.

---

## privacy

- what leaves your machine: **card name, tier, and on-screen position — nothing else**
- what never leaves: account details, inputs, chat, screenshots, game files
- the companion is local and opt-in; stop it any time
- full [privacy policy](../PRIVACY.md) and [terms](../TERMS.md)

data from [bazaardb.gg](https://bazaardb.gg). questions or issues → [open one on GitHub](https://github.com/mellen9999/bazaarinfo/issues).
