# bazaarinfo

Twitch bot for [The Bazaar](https://www.playthebazaar.com/). Card lookups, trivia, AI chat — all from `!b`.

## quickstart

```sh
bun install
cp .env.example .env   # fill in your creds
bun run packages/bot/src/index.ts
```

First run scrapes [bazaardb.gg](https://bazaardb.gg) and caches locally (~1-2 min). Auto-refreshes daily.

## env

See [`.env.example`](.env.example) for all options. Minimum needed:

| var | what |
|-----|------|
| `TWITCH_CHANNELS` | comma-separated channels to join |
| `TWITCH_USERNAME` | bot's twitch username |
| `TWITCH_TOKEN` | OAuth token (`chat:read chat:edit` scopes) |
| `TWITCH_REFRESH_TOKEN` | refresh token for auto-renewal |
| `TWITCH_CLIENT_ID` | from [dev.twitch.tv/console](https://dev.twitch.tv/console) |
| `TWITCH_CLIENT_SECRET` | from same app |
| `BOT_OWNER` | your username (unlocks `!b refresh`, etc) |
| `ANTHROPIC_API_KEY` | for AI features — bot works without it, just no `!b <question>` |

## commands

```
!b <item> [tier] [enchant]   card lookup (fuzzy matched)
!b hero <name>               list hero's items
!b mob <name>                monster stats + skills
!b skill <name>              skill details
!b tag <tag>                 items by tag
!b day <n>                   monsters by encounter day
!b enchants                  list all enchantments
!b trivia [category]         start a trivia round (items/heroes/monsters)
!b score                     trivia leaderboard
!b stats [@user]             player trivia stats
!b top                       channel trivia leaders
!b <question>                ask anything (AI, needs Anthropic key)
!b help                      show usage
```

Users can `!join` / `!part` in the bot's own channel to add/remove it from theirs.

## structure

```
packages/
  shared/      types, search, formatting
  data/        bazaardb.gg scraper
  bot/         IRC + EventSub bot
  ebs/         extension backend (Bun HTTP, port 3100)
  extension/   twitch overlay (Preact)
  companion/   game log watcher (Python)
```

## tests

```sh
bun test
```
