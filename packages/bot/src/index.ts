import type { CardCache } from '@bazaarinfo/shared'
import { TwitchClient, getUserId } from './twitch'
import type { ChannelInfo } from './twitch'
import { loadStore, reloadStore, CACHE_PATH } from './store'
import { handleCommand, setLobbyChannel, setRefreshHandler, setEmoteRefreshHandler } from './commands'
import { ensureValidToken, refreshToken, getAccessToken } from './auth'
import { scheduleDaily } from './scheduler'
import { scrapeDump } from '@bazaarinfo/data'
import * as channelStore from './channels'
import * as db from './db'
import { checkAnswer, isGameActive, setSay, rebuildTriviaMaps, cleanupChannel } from './trivia'
import { invalidatePromptCache, initSummarizer, setChannelLive, setChannelOffline, setChannelInfos, maybeFetchTwitchInfo } from './ai'
import { refreshRedditDigest } from './reddit'
import { refreshActivity } from './activity'
import * as chatbuf from './chatbuf'
import { refreshGlobalEmotes, refreshChannelEmotes, getEmoteSetId, getAllEmoteSetIds, removeChannelEmotes } from './emotes'
import * as emoteEvents from './emote-events'
import { loadDescriptionCache } from './emote-describe'
import { preloadStyles } from './style'
import { writeAtomic } from './fs-util'
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
const STALE_HOURS = 168 // 7 days — daily cron handles normal refresh, this is the offline fallback

const SCRAPE_TIMEOUT = 5 * 60_000 // 5min

let refreshPromise: Promise<void> | null = null

async function refreshData() {
  if (refreshPromise) { log('refresh already in progress, skipping'); return refreshPromise }
  refreshPromise = doRefreshData().finally(() => { refreshPromise = null })
  return refreshPromise
}

async function doRefreshData() {
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
  await writeAtomic(CACHE_PATH, JSON.stringify(cache, null, 2), 0o644)
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

try {
  await loadStore()
  rebuildTriviaMaps()
} catch (e) {
  log(`FATAL: no cache available — ${e}`)
  process.exit(1)
}

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

setChannelInfos(channels)
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

// owner-only !b emote refresh
setEmoteRefreshHandler(async () => {
  try {
    const globals = await refreshGlobalEmotes()
    const currentChannels = client.getChannels()
    const results = await Promise.allSettled(
      currentChannels.map((ch) => refreshChannelEmotes(ch.name, ch.userId)),
    )
    const count = globals.length + results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.length : 0), 0)
    return `refreshed ${count} emotes across ${currentChannels.length} channels`
  } catch (e) {
    return `emote refresh failed: ${e instanceof Error ? e.message : e}`
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

  // connect 7TV EventAPI for real-time emote updates
  emoteEvents.connect()
  for (const [channel, setId] of getAllEmoteSetIds()) {
    emoteEvents.subscribeChannel(channel, setId)
  }
}).catch((e) => log(`emote startup failed: ${e}`))

// load reddit digest (non-blocking)
refreshRedditDigest().catch((e) => log(`reddit digest load failed: ${e}`))

// load activity data (non-blocking) + refresh every 30 min
refreshActivity().catch((e) => log(`activity load failed: ${e}`))
setInterval(() => refreshActivity().catch((e) => log(`activity refresh failed: ${e}`)), 30 * 60_000)

// init rolling chat summarizer
initSummarizer()

// restore persisted summaries + session IDs from DB
for (const ch of channelNames) {
  const sid = db.getMaxSessionId(ch)
  if (sid > 0) chatbuf.restoreSessionId(ch, sid)
  const rows = db.getLatestSummaries(ch, 1)
  if (rows.length > 0) chatbuf.restoreSummary(ch, rows[0].summary)
}

// --- per-channel response debounce (2s) ---
const DEBOUNCE_MS = 2_000
const lastResponseTime = new Map<string, number>()

const client = new TwitchClient(
  { token, clientId: CLIENT_ID, botUserId, botUsername: BOT_USERNAME, channels },
  async (channel, userId, username, text, badges, messageId) => {
    try {
      if (userId === botUserId) return

      try { db.logChat(channel, username, text) } catch {}
      chatbuf.record(channel, username, text)

      // pre-fetch Twitch user info + followage for every chatter (fire-and-forget)
      // so data is ready BEFORE they use !a, not after
      maybeFetchTwitchInfo(username, channel)

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
            setChannelInfos(client.getChannels())
            await channelStore.add(target)
            refreshChannelEmotes(target, targetId).then(() => {
              const setId = getEmoteSetId(target)
              if (setId) emoteEvents.subscribeChannel(target, setId)
            }).catch((e) => log(`emote refresh failed for ${target}: ${e}`))
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
          cleanupChannel(target)
          emoteEvents.unsubscribeChannel(target)
          removeChannelEmotes(target)
          chatbuf.cleanupChannel(target)
          await channelStore.remove(target)
          client.say(channel, `@${username} left #${target}`)
          return
        }
      }

      const privileged = badges.some((b) => b === 'subscriber' || b === 'moderator' || b === 'broadcaster' || b === 'vip')
      const isMod = badges.some((b) => b === 'moderator' || b === 'broadcaster')
      const response = await handleCommand(text, { user: username, channel, privileged, isMod, messageId })
      if (response) {
        // debounce: delay if another response was sent to this channel recently
        const now = Date.now()
        const lastSent = lastResponseTime.get(channel) ?? 0
        const gap = now - lastSent
        if (gap < DEBOUNCE_MS) {
          const delay = DEBOUNCE_MS - gap
          log(`[#${channel}] delaying ${delay}ms: ${text.slice(0, 40)}`)
          await new Promise((r) => setTimeout(r, delay))
        }
        lastResponseTime.set(channel, Date.now())
        log(`[#${channel}] [${username}] ${text} -> ${response.slice(0, 80)}...`)
        client.say(channel, response, messageId)
        chatbuf.record(channel, BOT_USERNAME, response)
      }
    } catch (e) {
      log(`handler error: ${e}`)
    }
  },
)

client.setAuthRefresh(doRefresh)
client.setStreamStateHandler((channel, live) => {
  log(`stream ${live ? 'online' : 'offline'}: #${channel}`)
  if (live) setChannelLive(channel)
  else setChannelOffline(channel)
})
setSay((ch, msg) => client.say(ch, msg))

// check which channels are currently live (eventsub only fires on transitions)
try {
  const ids = channels.map((c) => `user_id=${c.userId}`).join('&')
  const res = await fetch(`https://api.twitch.tv/helix/streams?${ids}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}`, 'Client-Id': CLIENT_ID },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.ok) {
    const data = await res.json() as { data: { user_login: string }[] }
    for (const stream of data.data) setChannelLive(stream.user_login)
    log(`live channels: ${data.data.map((s) => s.user_login).join(', ') || 'none'}`)
  }
} catch (e) { log(`live check failed: ${e}`) }

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
  } catch (e) {
    log(`daily data refresh failed, keeping stale data: ${e}`)
  }
  try {
    await refreshRedditDigest()
  } catch (e) { log(`daily reddit refresh failed: ${e}`) }
  try {
    await refreshActivity()
  } catch (e) { log(`daily activity refresh failed: ${e}`) }
  try {
    db.pruneOldChats(180)
    db.pruneOldSummaries(365)
  } catch (e) { log(`daily prune failed: ${e}`) }
  try {
    await refreshGlobalEmotes()
    const currentChannels = client.getChannels()
    await Promise.allSettled(
      currentChannels.map((ch) => refreshChannelEmotes(ch.name, ch.userId)),
    )
  } catch (e) { log(`daily emote refresh failed: ${e}`) }
  log('daily refresh complete')
})

// periodic emote reconciliation every 2 hours (fallback for missed events)
setInterval(async () => {
  try {
    await refreshGlobalEmotes()
    const currentChannels = client.getChannels()
    await Promise.allSettled(
      currentChannels.map((ch) => refreshChannelEmotes(ch.name, ch.userId)),
    )
    log('periodic emote reconciliation complete')
  } catch (e) { log(`periodic emote reconciliation failed: ${e}`) }
}, 2 * 60 * 60_000)

// graceful shutdown
function shutdown() {
  log('shutting down...')
  emoteEvents.close()
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
