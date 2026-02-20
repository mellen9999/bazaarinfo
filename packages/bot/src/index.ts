import type { CardCache } from '@bazaarinfo/shared'
import { TwitchClient, getUserId } from './twitch'
import type { ChannelInfo } from './twitch'
import { loadStore, reloadStore, CACHE_PATH } from './store'
import { handleCommand, setLobbyChannel, setRefreshHandler } from './commands'
import { ensureValidToken, refreshToken, getAccessToken } from './auth'
import { scheduleDaily } from './scheduler'
import { scrapeDump } from '@bazaarinfo/data'
import * as channelStore from './channels'
import * as db from './db'
import { checkAnswer, isGameActive, setSay, rebuildTriviaMaps } from './trivia'
import { invalidatePromptCache, initSummarizer } from './ai'
import { refreshRedditDigest } from './reddit'
import * as chatbuf from './chatbuf'
import { refreshGlobalEmotes, refreshChannelEmotes } from './emotes'
import { loadDescriptionCache } from './emote-describe'
import { preloadStyles } from './style'
import { rename } from 'node:fs/promises'
import { log } from './log'

const CHANNELS_RAW = process.env.TWITCH_CHANNELS ?? process.env.TWITCH_CHANNEL
const CLIENT_ID = process.env.TWITCH_CLIENT_ID
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET
const BOT_USERNAME = process.env.TWITCH_USERNAME

if (!CHANNELS_RAW || !CLIENT_ID || !CLIENT_SECRET || !BOT_USERNAME) {
  log('missing env: TWITCH_CHANNELS, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_USERNAME')
  process.exit(1)
}

const envChannels = CHANNELS_RAW.split(',').map((s) => s.trim()).filter(Boolean)

// ensure bot's own channel is always joined (lobby for !join)
if (!envChannels.includes(BOT_USERNAME.toLowerCase())) {
  envChannels.push(BOT_USERNAME.toLowerCase())
}

// merge env channels + stored dynamic channels
const storedChannels = await channelStore.load()
const channelNames = [...new Set([...envChannels, ...storedChannels])]

// validate + refresh token
const token = await ensureValidToken(CLIENT_ID, CLIENT_SECRET)

// check cache freshness, refresh if stale or missing
const STALE_HOURS = 24

const SCRAPE_TIMEOUT = 5 * 60_000 // 5min

async function refreshData() {
  log('starting data refresh...')
  let timer: Timer
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('scrape timed out after 5min')), SCRAPE_TIMEOUT)
  })

  const cache = await Promise.race([
    scrapeDump((msg) => log(`dump: ${msg}`)),
    timeout,
  ]).finally(() => clearTimeout(timer))

  log(`scraped ${cache.items.length} items, ${cache.skills.length} skills, ${cache.monsters.length} monsters`)
  const tmpPath = CACHE_PATH + '.tmp'
  await Bun.write(tmpPath, JSON.stringify(cache, null, 2))
  await rename(tmpPath, CACHE_PATH)
}

try {
  const cacheFile = Bun.file(CACHE_PATH)
  if (await cacheFile.exists()) {
    const cache = (await cacheFile.json()) as { fetchedAt: string }
    const age = Date.now() - new Date(cache.fetchedAt).getTime()
    if (age > STALE_HOURS * 3600_000) {
      log(`cache is ${Math.round(age / 3600_000)}h old, refreshing...`)
      await refreshData()
    }
  } else {
    log('no cache file, scraping...')
    await refreshData()
  }
} catch (e) {
  log(`startup cache check failed: ${e}`)
}

await loadStore()
rebuildTriviaMaps()

// init db
db.initDb()

const doRefresh = () => refreshToken(CLIENT_ID, CLIENT_SECRET)

// resolve user IDs
log('resolving user IDs...')
const botUserId = await getUserId(token, CLIENT_ID, BOT_USERNAME, doRefresh)
const channels: ChannelInfo[] = await Promise.all(
  channelNames.map(async (name) => ({
    name,
    userId: await getUserId(token, CLIENT_ID, name, doRefresh),
  })),
)
log(`bot: ${BOT_USERNAME} (${botUserId}), channels: ${channels.map((c) => `${c.name}(${c.userId})`).join(', ')}`)

setLobbyChannel(BOT_USERNAME.toLowerCase())

// owner-only !b refresh — re-scrapes data + reddit digest
setRefreshHandler(async () => {
  try {
    const before = { items: 0, skills: 0, monsters: 0 }
    try {
      const old = await Bun.file(CACHE_PATH).json() as CardCache
      before.items = old.items?.length ?? 0
      before.skills = old.skills?.length ?? 0
      before.monsters = old.monsters?.length ?? 0
    } catch {}

    await refreshData()
    await reloadStore()
    rebuildTriviaMaps()
    invalidatePromptCache()
    await refreshRedditDigest()

    const fresh = await Bun.file(CACHE_PATH).json() as CardCache
    const di = (fresh.items?.length ?? 0) - before.items
    const ds = (fresh.skills?.length ?? 0) - before.skills
    const dm = (fresh.monsters?.length ?? 0) - before.monsters
    const changes = [
      di ? `${di > 0 ? '+' : ''}${di} items` : null,
      ds ? `${ds > 0 ? '+' : ''}${ds} skills` : null,
      dm ? `${dm > 0 ? '+' : ''}${dm} monsters` : null,
    ].filter(Boolean)
    return changes.length > 0
      ? `refreshed! ${changes.join(', ')}`
      : `refreshed, no new data (${fresh.items.length} items)`
  } catch (e) {
    log(`manual refresh failed: ${e}`)
    return `refresh failed: ${e instanceof Error ? e.message : e}`
  }
})

// load emote descriptions cache, then refresh emotes + describe new ones
loadDescriptionCache().then(async () => {
  const emoteData = []
  try {
    const globals = await refreshGlobalEmotes()
    emoteData.push(...globals)
  } catch (e) { log(`global emote load failed: ${e}`) }
  for (const ch of channels) {
    try {
      const data = await refreshChannelEmotes(ch.name, ch.userId)
      emoteData.push(...data)
    } catch (e) { log(`emote load failed for #${ch.name}: ${e}`) }
  }
  preloadStyles(channels.map((c) => c.name))
}).catch((e) => log(`emote startup failed: ${e}`))

// load reddit digest (non-blocking)
refreshRedditDigest().catch((e) => log(`reddit digest load failed: ${e}`))

// init rolling chat summarizer
initSummarizer()

const client = new TwitchClient(
  { token, clientId: CLIENT_ID, botUserId, botUsername: BOT_USERNAME, channels },
  async (channel, userId, username, text, badges) => {
    try {
      if (userId === botUserId) return

      try { db.logChat(channel, username, text) } catch {}
      chatbuf.record(channel, username, text)

      // check trivia answers before command routing
      if (isGameActive(channel)) {
        checkAnswer(channel, username, text, (ch, msg) => client.say(ch, msg))
      }

      // handle !join / !part only in bot's own channel to avoid collisions with other bots
      if (channel === BOT_USERNAME.toLowerCase()) {
        const trimmed = text.trim().toLowerCase()
        if (trimmed === '!join') {
          const target = username.toLowerCase()
          if (client.hasChannel(target)) {
            client.say(channel, `@${username} i'm already in your channel`)
            return
          }
          try {
            const targetId = await getUserId(getAccessToken(), CLIENT_ID, target, doRefresh)
            const info: ChannelInfo = { name: target, userId: targetId }
            await client.joinChannel(info)
            await channelStore.add(target)
            refreshChannelEmotes(target, targetId).catch(() => {})
            client.say(channel, `@${username} joined #${target}! type !b help in your chat`)
          } catch (e) {
            log(`join error for ${target}: ${e}`)
            client.say(channel, `@${username} couldn't join your channel, try again later`)
          }
          return
        }
        if (trimmed === '!part') {
          const target = username.toLowerCase()
          if (envChannels.includes(target)) {
            client.say(channel, `@${username} can't leave a hardcoded channel`)
            return
          }
          if (!client.hasChannel(target)) {
            client.say(channel, `@${username} i'm not in your channel`)
            return
          }
          client.leaveChannel(target)
          await channelStore.remove(target)
          client.say(channel, `@${username} left #${target}`)
          return
        }
      }

      const privileged = badges.some((b) => b === 'subscriber' || b === 'moderator' || b === 'broadcaster' || b === 'vip')
      const response = await handleCommand(text, { user: username, channel, privileged })
      if (response) {
        log(`[#${channel}] [${username}] ${text} -> ${response.slice(0, 80)}...`)
        client.say(channel, response)
        chatbuf.record(channel, BOT_USERNAME, response)
      }
    } catch (e) {
      log(`handler error: ${e}`)
    }
  },
)

client.setAuthRefresh(doRefresh)
setSay((ch, msg) => client.say(ch, msg))

// proactive token refresh every 30min
setInterval(async () => {
  try {
    const newToken = await ensureValidToken(CLIENT_ID, CLIENT_SECRET)
    client.updateToken(newToken)
  } catch (e) {
    log(`periodic token refresh error: ${e}`)
  }
}, 30 * 60 * 1000)

// daily data refresh at 4am PT
scheduleDaily(4, async () => {
  try {
    await refreshData()
    await reloadStore()
    rebuildTriviaMaps()
    invalidatePromptCache()
    await refreshRedditDigest()
  } catch (e) {
    log(`daily data refresh failed: ${e}`)
  }
  try {
    const dailyEmoteData = []
    const globals = await refreshGlobalEmotes()
    dailyEmoteData.push(...globals)
    const currentChannels = client.getChannels()
    for (const ch of currentChannels) {
      const data = await refreshChannelEmotes(ch.name, ch.userId)
      dailyEmoteData.push(...data)
    }
  } catch (e) { log(`daily emote refresh failed: ${e}`) }
  log('daily refresh complete')
})

// graceful shutdown
function shutdown() {
  log('shutting down...')
  db.closeDb()
  client.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (e) => log('unhandled rejection:', e))

// self-health: if eventsub hasn't sent a keepalive in 2min, exit and let systemd restart
setInterval(() => {
  if (Date.now() - client.lastActivity > 120_000) {
    log('health check failed — no eventsub activity for 2min, exiting')
    db.closeDb()
    client.close()
    process.exit(1)
  }
}, 30_000)

client.connect()
log(`bazaarinfo starting — ${channels.length} channel(s) (${envChannels.length} env, ${storedChannels.length} dynamic)`)
