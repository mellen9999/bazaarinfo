# Privacy Policy — BazaarInfo

Last updated: 2026-05-08

BazaarInfo is a Twitch chat bot and broadcaster overlay extension for *The Bazaar*. This policy covers what data is collected, how it is used, and how to remove it.

## What we collect

### From Twitch chatters in channels that have invited the bot
- **Twitch username** (lowercase, hashed against an internal id)
- **Chat messages** sent in the channel (used for context-aware answers, trivia, mimicry)
- **Command inputs** (e.g. `!b sword`, `!b ask <question>`)
- **Trivia answers** and timing
- **Twitch account creation date** (cached up to 7 days, used for `!b account` style replies)
- **Channel followage timestamp** (cached up to 1 day)

### From broadcasters running the BazaarInfo overlay extension
- **Twitch channel id** (assigned by Twitch)
- **Card detections from the local companion app**: card name, tier, on-screen position. No screenshots, no game files, no account data.

### From the AI fallback (when enabled)
- The text of your `!b ask <...>` query and the bot's response are stored to keep replies coherent across follow-up messages and to detect repeat abuse.

## What we do *not* collect

- IP addresses (Twitch IRC delivers chat without revealing them; the EBS rate-limits by Cloudflare-connecting-IP and discards the value after 60s)
- Email addresses, real names, payment info
- Game saves, runs, deck contents, MMR, or any player progression data
- Screenshots, video, audio, or screen contents

## How we use it

- Answer card lookups, trivia, and `!b ask` queries
- Build per-channel response variety (so the bot doesn't repeat itself)
- Build per-user memos so the bot can recognize regulars
- Broadcast card detections to extension viewers via Twitch PubSub

## Where it is stored

- A single SQLite database at `~/.bazaarinfo.db` on the operator's host (currently a self-hosted Linux server)
- Rolling caches in `cache/` (card data from bazaardb.gg, 7TV emote descriptions)

Nothing is sent to third parties except: Anthropic (for AI replies if enabled), Twitch (chat + extension PubSub), and bazaardb.gg (read-only card data fetch).

## Retention

| Data | Retention |
|---|---|
| Chat messages | 30 days, then auto-pruned |
| AI ask queries | 90 days, then auto-pruned |
| Trivia games + answers | 180 days |
| Card detections (PubSub) | not stored — relayed and dropped |
| User memos / facts | until you ask us to delete |

## Your rights

- **Removal**: email [mellen@heatsync.org](mailto:mellen@heatsync.org) with the Twitch username you want erased. Your stored chat, command history, ask queries, memos, and facts will be deleted within 7 days.
- **Channel opt-out**: a broadcaster can disable the bot in their channel at any time by removing it.
- **Extension opt-out**: a viewer can disable the extension overlay from Twitch's per-channel extension settings.

## Changes

If this policy changes, the new version is committed to the repository. The "last updated" date above reflects the most recent change.

## Contact

Operator: mellen
Email: [mellen@heatsync.org](mailto:mellen@heatsync.org)
Source: <https://github.com/mellen9999/bazaarinfo>
