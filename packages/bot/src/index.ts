import { TwitchClient, getUserId } from './twitch'
import type { ChannelInfo } from './twitch'
import { loadStore, reloadStore, CACHE_PATH } from './store'
import { handleCommand } from './commands'
import { checkCooldown } from './cooldown'
import { ensureValidToken, refreshToken } from './auth'
import { scheduleDaily } from './scheduler'
import { scrapeItems } from '@bazaarinfo/data'
import type { CardCache } from '@bazaarinfo/shared'
import { log } from './log'

const CHANNELS_RAW = process.env.TWITCH_CHANNELS ?? process.env.TWITCH_CHANNEL
const CLIENT_ID = process.env.TWITCH_CLIENT_ID
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET
const BOT_USERNAME = process.env.TWITCH_USERNAME

if (!CHANNELS_RAW || !CLIENT_ID || !CLIENT_SECRET || !BOT_USERNAME) {
  log('missing env: TWITCH_CHANNELS, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_USERNAME')
  process.exit(1)
}

const channelNames = CHANNELS_RAW.split(',').map((s) => s.trim()).filter(Boolean)

// validate + refresh token
const token = await ensureValidToken(CLIENT_ID, CLIENT_SECRET)

// check cache freshness, refresh if stale or missing
const STALE_HOURS = 24

const SCRAPE_TIMEOUT = 5 * 60_000 // 5min

async function refreshData() {
  log('starting data refresh...')
  const scrape = scrapeItems((done, pages) => {
    if (done % 10 === 0) log(`scrape progress: ${done}/${pages}`)
  })
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('scrape timed out after 5min')), SCRAPE_TIMEOUT),
  )
  const { cards, total } = await Promise.race([scrape, timeout])
  log(`scraped ${cards.length} items (expected ~${total})`)
  const cache: CardCache = {
    items: cards,
    skills: [],
    monsters: [],
    fetchedAt: new Date().toISOString(),
  }
  await Bun.write(CACHE_PATH, JSON.stringify(cache, null, 2))
}

try {
  const cacheFile = Bun.file(CACHE_PATH)
  if (await cacheFile.exists()) {
    const cache = (await cacheFile.json()) as CardCache
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

// resolve user IDs
log('resolving user IDs...')
const botUserId = await getUserId(token, CLIENT_ID, BOT_USERNAME)
const channels: ChannelInfo[] = await Promise.all(
  channelNames.map(async (name) => ({
    name,
    userId: await getUserId(token, CLIENT_ID, name),
  })),
)
log(`bot: ${BOT_USERNAME} (${botUserId}), channels: ${channels.map((c) => `${c.name}(${c.userId})`).join(', ')}`)

const doRefresh = () => refreshToken(CLIENT_ID, CLIENT_SECRET)

const client = new TwitchClient(
  { token, clientId: CLIENT_ID, botUserId, botUsername: BOT_USERNAME, channels },
  (channel, userId, username, text) => {
    try {
      if (userId === botUserId) return
      if (!checkCooldown(userId)) return

      const response = handleCommand(text)
      if (response) {
        log(`[#${channel}] [${username}] ${text} -> ${response.slice(0, 80)}...`)
        client.say(channel, response)
      }
    } catch (e) {
      log(`handler error: ${e}`)
    }
  },
)

client.setAuthRefresh(doRefresh)

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
  await refreshData()
  await reloadStore()
  log('daily refresh complete')
})

// graceful shutdown
function shutdown() {
  log('shutting down...')
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
    client.close()
    process.exit(1)
  }
}, 30_000)

client.connect()
log(`bazaarinfo starting — ${channels.length} channel(s)`)
