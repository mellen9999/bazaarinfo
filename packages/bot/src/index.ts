import { TwitchClient, getUserId } from './twitch'
import type { ChannelInfo } from './twitch'
import { loadStore, reloadStore, CACHE_PATH } from './store'
import { handleCommand, setLobbyChannel } from './commands'
import { checkCooldown } from './cooldown'
import { ensureValidToken, refreshToken, getAccessToken } from './auth'
import { scheduleDaily } from './scheduler'
import { scrapeItems, scrapeSkills, scrapeMonsters } from '@bazaarinfo/data'
import type { CardCache } from '@bazaarinfo/shared'
import * as channelStore from './channels'
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

  const itemsScrape = scrapeItems((done, pages) => {
    if (done % 10 === 0) log(`items scrape: ${done}/${pages}`)
  })
  const skillsScrape = scrapeSkills((done, pages) => {
    if (done % 5 === 0) log(`skills scrape: ${done}/${pages}`)
  })
  const monstersScrape = scrapeMonsters()

  const [items, skills, monstersResult] = await Promise.race([
    Promise.all([itemsScrape, skillsScrape, monstersScrape]),
    timeout,
  ]).finally(() => clearTimeout(timer))

  log(`scraped ${items.cards.length} items, ${skills.cards.length} skills, ${monstersResult.monsters.length} monsters`)
  const cache: CardCache = {
    items: items.cards,
    skills: skills.cards,
    monsters: monstersResult.monsters,
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

const client = new TwitchClient(
  { token, clientId: CLIENT_ID, botUserId, botUsername: BOT_USERNAME, channels },
  async (channel, userId, username, text) => {
    try {
      if (userId === botUserId) return
      if (!checkCooldown(userId)) return

      // handle !join / !part in bot's own channel
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
          client.leaveChannel(target)
          await channelStore.remove(target)
          client.say(channel, `@${username} left #${target}`)
          return
        }
      }

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
log(`bazaarinfo starting — ${channels.length} channel(s) (${envChannels.length} env, ${storedChannels.length} dynamic)`)
