import * as db from './db'
import type { ChannelInfo } from './twitch'
import { recentEmotesByChannel } from './ai-sanitize'
import { log } from './log'

// --- cooldowns ---

const lastAiByChannel = new Map<string, number>()
export const AI_GLOBAL_CD = 30_000 // 30s per-channel (non-game only)
const USER_AI_CD = 30_000
const lastAiByUser = new Map<string, number>()
const USER_CD_MAX = 500

// --- hot exchange cache (in-memory, instant access for follow-ups) ---

interface HotExchange { query: string; response: string; ts: number }
const hotExchanges = new Map<string, HotExchange[]>()
const HOT_EXCHANGE_MAX = 8
const USER_HISTORY_MAX = 5_000
const HOT_EXCHANGE_TTL = 3_600_000 // 1h

// --- channel-wide recent response buffer (anti-repetition) ---
const channelRecentResponses = new Map<string, string[]>()
const CHANNEL_RESPONSE_MAX = 12

export function cacheExchange(user: string, query: string, response: string, channel?: string) {
  const list = hotExchanges.get(user) ?? []
  list.push({ query, response, ts: Date.now() })
  if (list.length > HOT_EXCHANGE_MAX) list.shift()
  hotExchanges.set(user, list)
  if (hotExchanges.size > USER_HISTORY_MAX) {
    const first = hotExchanges.keys().next().value!
    hotExchanges.delete(first)
  }
  // channel-wide recent responses — lets model avoid repeating itself across users
  if (channel) {
    const ch = channelRecentResponses.get(channel) ?? []
    ch.push(response)
    if (ch.length > CHANNEL_RESPONSE_MAX) ch.shift()
    channelRecentResponses.set(channel, ch)
    // persist to SQLite for cross-restart variety memory
    try { db.logRecentResponse(channel, response) } catch {}
  }
}

export function getChannelRecentResponses(channel: string): string[] {
  // hydrate from SQLite on first access (cross-restart variety memory)
  if (!channelRecentResponses.has(channel)) {
    try {
      const persisted = db.loadRecentResponses(channel, CHANNEL_RESPONSE_MAX)
      if (persisted.length > 0) channelRecentResponses.set(channel, persisted)
    } catch {}
  }
  return channelRecentResponses.get(channel) ?? []
}

export function getHotExchanges(user: string): HotExchange[] {
  const list = hotExchanges.get(user)
  if (!list) return []
  const now = Date.now()
  return list.filter((e) => now - e.ts < HOT_EXCHANGE_TTL)
}

export function formatAge(createdAt: string, now: number): string {
  const mins = Math.round((now - new Date(createdAt + 'Z').getTime()) / 60_000)
  return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`
}

// --- VIP / channel sets ---

export const AI_VIP = new Set(
  (process.env.AI_VIP ?? '').split(',').concat(process.env.BOT_OWNER ?? '').map((s) => s.trim().toLowerCase()).filter(Boolean),
)

export const AI_CHANNELS = new Set(
  (process.env.AI_CHANNELS ?? process.env.TWITCH_CHANNELS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
)

// --- live channels + current game ---

const liveChannels = new Set<string>()
const channelGames = new Map<string, string>()

export function setChannelLive(channel: string, game?: string) {
  const ch = channel.toLowerCase()
  liveChannels.add(ch)
  if (game) channelGames.set(ch, game)
}

export function setChannelOffline(channel: string) {
  const ch = channel.toLowerCase()
  liveChannels.delete(ch)
  channelGames.delete(ch)
  // cleanup per-channel state to prevent unbounded growth
  lastAiByChannel.delete(ch)
  recentEmotesByChannel.delete(ch)
}

export function isChannelLive(channel: string): boolean { return liveChannels.has(channel.toLowerCase()) }
export function getLiveChannels(): string[] { return [...liveChannels] }
export function getChannelGame(channel: string): string | undefined { return channelGames.get(channel.toLowerCase()) }
export function setChannelGame(channel: string, game: string) { channelGames.set(channel.toLowerCase(), game) }

// --- channel info for Twitch API lookups ---

let channelInfos: ChannelInfo[] = []
export function setChannelInfos(channels: ChannelInfo[]) { channelInfos = channels }
export function getChannelId(channel: string): string | undefined {
  return channelInfos.find((c) => c.name === channel.toLowerCase())?.userId
}

// --- emote cooldowns ---

export const EMOTE_COOLDOWN_MS = 7 * 60_000

export function getRecentEmotes(channel: string): Set<string> {
  const map = recentEmotesByChannel.get(channel)
  if (!map) return new Set()
  const now = Date.now()
  const result = new Set<string>()
  for (const [emote, ts] of map) {
    if (now - ts < EMOTE_COOLDOWN_MS) result.add(emote)
    else map.delete(emote)
  }
  return result
}

// --- cooldown functions ---

export function getAiCooldown(user?: string, channel?: string): number {
  if (channel && !liveChannels.has(channel.toLowerCase())) return 0
  if (user && AI_VIP.has(user.toLowerCase())) return 0
  if (user) {
    const last = lastAiByUser.get(user.toLowerCase())
    if (last) {
      const elapsed = Date.now() - last
      if (elapsed < USER_AI_CD) return Math.ceil((USER_AI_CD - elapsed) / 1000)
    }
  }
  return 0
}

export function getGlobalAiCooldown(channel?: string): number {
  if (!channel) return 0
  if (!liveChannels.has(channel.toLowerCase())) return 0
  const last = lastAiByChannel.get(channel.toLowerCase())
  if (!last) return 0
  const elapsed = Date.now() - last
  return elapsed >= AI_GLOBAL_CD ? 0 : Math.ceil((AI_GLOBAL_CD - elapsed) / 1000)
}

export function recordUsage(user?: string, isGame = false, channel?: string) {
  if (!isGame && channel) {
    lastAiByChannel.set(channel.toLowerCase(), Date.now())
  }
  if (user) {
    lastAiByUser.set(user.toLowerCase(), Date.now())
    if (lastAiByUser.size > USER_CD_MAX) {
      const now = Date.now()
      for (const [k, t] of lastAiByUser) {
        if (now - t > USER_AI_CD) lastAiByUser.delete(k)
      }
    }
  }
}

// --- circuit breaker ---

const CB_THRESHOLD = 5
const CB_COOLDOWN = 300_000
let cbFailures = 0
let cbOpenUntil = 0

export function cbRecordSuccess() { cbFailures = 0 }
export function cbRecordFailure() {
  cbFailures++
  if (cbFailures >= CB_THRESHOLD) {
    cbOpenUntil = Date.now() + CB_COOLDOWN
    log(`ai: circuit breaker OPEN — ${CB_THRESHOLD} consecutive failures, cooling down ${CB_COOLDOWN / 1000}s`)
  }
}
export function cbIsOpen(): boolean {
  if (cbOpenUntil === 0) return false
  if (Date.now() >= cbOpenUntil) {
    cbOpenUntil = 0
    cbFailures = 0
    log('ai: circuit breaker CLOSED — retrying')
    return false
  }
  return true
}

// --- AI queue serialization ---

export let aiLock: Promise<void> = Promise.resolve()
export let aiQueueDepth = 0
export const AI_MAX_QUEUE = 5

export function setAiLock(p: Promise<void>) { aiLock = p }
export function incrementQueue() { aiQueueDepth++ }
export function decrementQueue() { aiQueueDepth-- }
