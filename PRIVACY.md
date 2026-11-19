# Privacy Policy — BazaarInfo

Last updated: 2026-11-19

BazaarInfo is a Twitch chat bot and broadcaster overlay extension for *The Bazaar*. This policy covers what data is collected, how it is used, and how to remove it.

## What we collect

### From Twitch chatters in channels that have invited the bot
- **Twitch username** and Twitch user id
- **Chat messages** sent in the channel (used for context-aware answers, trivia, mimicry)
- **Command inputs** (e.g. `!b sword`, `!b ask <question>`)
- **Trivia answers** and timing
- **Twitch account creation date** (cached up to 7 days, used for `!b account` style replies)
- **Channel followage timestamp** (cached up to 1 day)

### From broadcasters running the BazaarInfo overlay extension
- **Twitch channel id** (assigned by Twitch)
- **Card detections from the local companion app**: card name, tier, on-screen position. No screenshots, no game files, no account data.
- **Stream preview thumbnail** (the public one Twitch already serves) while live: sent to Anthropic to read what's on screen (e.g. shirt colour). Only the description is stored, never the image.

### From the AI fallback (when enabled)
- The text of your `!b ask <...>` query and the bot's response are stored to keep replies coherent across follow-up messages and to detect repeat abuse.

## What we do *not* collect

- IP addresses (Twitch IRC delivers chat without revealing them; the EBS rate-limits by Cloudflare-connecting-IP and discards the value after 60s)
- Email addresses, real names, payment info
- Game saves, runs, deck contents, MMR, or any player progression data
- Video, audio, or anything from a viewer's screen

## How we use it

- Answer card lookups, trivia, and `!b ask` queries
- Build per-channel response variety (so the bot doesn't repeat itself)
- Build per-user memos so the bot can recognize regulars
- Broadcast card detections to extension viewers via Twitch PubSub

## Where it is stored

- A single SQLite database at `~/.bazaarinfo.db` on the operator's host (currently a self-hosted Linux server)
- Chat history older than 30 days lives in [heatsync.org](https://heatsync.org)'s chat logs (same operator), which the bot reads for context
- Rolling caches in `cache/` (card data from bazaardb.gg, 7TV emote descriptions)

What leaves the host:
- **Anthropic**: the text of AI asks plus the chat context needed to answer them; stream thumbnails (above). Anthropic may run a web search for a question.
- **Twitch**: chat and extension PubSub
- **heatsync.org**: chat history lookups (same operator)
- **Open-Meteo**: the place name in a weather or time ask, nothing about who asked

Read-only public data fetches send nothing about chatters: bazaardb.gg, 7TV, Steam news, ESPN, Blizzard's leaderboard, HearthstoneJSON.

## Retention

| Data | Retention |
|---|---|
| Chat messages | 30 days |
| AI ask queries | 90 days |
| Trivia games + answers | 180 days |
| Chat summaries | 365 days |
| Stream events (subs, gifts, raids, cheers) | 90 days |
| User facts | 180 days after you stop asking the bot things |
| User memos | 365 days after you were last seen |
| Card detections (PubSub) | not stored — relayed and dropped |

Everything with a number is auto-pruned daily.

## Your rights

- **Removal**: request it at [heatsync.org/erase](https://heatsync.org/erase), or email [mellen@heatsync.org](mailto:mellen@heatsync.org) with the Twitch username you want erased. Your stored chat (here and on heatsync.org), command history, ask queries, memos, and facts will be deleted within 7 days.
- **Channel opt-out**: a broadcaster can disable the bot in their channel at any time by removing it.
- **Extension opt-out**: a viewer can disable the extension overlay from Twitch's per-channel extension settings.

## Changes

If this policy changes, the new version is committed to the repository. The "last updated" date above reflects the most recent change.

## Contact

Operator: mellen
Email: [mellen@heatsync.org](mailto:mellen@heatsync.org)
Source: <https://github.com/mellen9999/bazaarinfo>
