import * as db from './db'
import type { ChannelInfo } from './twitch'
import { recentEmotesByChannel } from './ai-sanitize'
import { log } from './log'

// --- cooldowns ---

const lastAiByChannel = new Map<string, number>()
export const AI_GLOBAL_CD = 0 // disabled — busy chats (kripp) need firehose, irc 90/30s + ai concurrency are the real ceiling
const USER_AI_CD = 0
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
  (process.env.AI_VIP ?? '').split(',')
    .concat(process.env.BOT_OWNER ?? '')
    .concat((process.env.BOT_ADMINS ?? '').split(','))
    .map((s) => s.trim().toLowerCase()).filter(Boolean),
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
// trips on a high failure RATE within a recent window, not on N *consecutive* failures.
// a partial upstream slowdown (say half the calls time out at the 12s deadline) never
// chains 5 failures in a row — every success reset the old consecutive counter — so the
// breaker never opened, and every other user ate a full deadline wait then a transient-miss
// fallback. that's the "backed up 45s then dumped a wall of glitch lines" failure mode.
// windowed-rate tripping catches it: once open we shed load instantly with one honest line
// instead of holding the queue, and a short cooldown lets a brief blip recover fast.
const CB_WINDOW = 20_000      // outcomes older than this are forgotten
const CB_MIN_SAMPLES = 5      // need a few recent calls before judging
const CB_FAIL_RATIO = 0.5     // trip when at least half the window failed
const CB_COOLDOWN = 30_000    // open duration — short so "rebooting" matches reality
let cbOutcomes: { t: number; ok: boolean }[] = []
let cbOpenUntil = 0

function cbPrune(now: number) {
  const cutoff = now - CB_WINDOW
  let i = 0
  while (i < cbOutcomes.length && cbOutcomes[i].t < cutoff) i++
  if (i > 0) cbOutcomes.splice(0, i)
}
export function cbRecordSuccess() {
  const now = Date.now()
  cbPrune(now)
  cbOutcomes.push({ t: now, ok: true })
}
export function cbRecordFailure() {
  const now = Date.now()
  cbPrune(now)
  cbOutcomes.push({ t: now, ok: false })
  const fails = cbOutcomes.reduce((n, o) => n + (o.ok ? 0 : 1), 0)
  if (cbOutcomes.length >= CB_MIN_SAMPLES && fails / cbOutcomes.length >= CB_FAIL_RATIO) {
    cbOpenUntil = now + CB_COOLDOWN
    cbOutcomes = []   // reset so the post-cooldown probe burst is judged fresh
    log(`ai: circuit breaker OPEN — ${fails} failures in last ${CB_WINDOW / 1000}s, cooling down ${CB_COOLDOWN / 1000}s`)
  }
}
export function cbIsOpen(): boolean {
  if (cbOpenUntil === 0) return false
  if (Date.now() >= cbOpenUntil) {
    // cooldown elapsed: close and let traffic re-probe. if upstream is still down, the
    // next CB_MIN_SAMPLES failures re-trip it — a bounded probe burst, no flapping.
    cbOpenUntil = 0
    cbOutcomes = []
    log('ai: circuit breaker CLOSED — retrying')
    return false
  }
  return true
}

// --- AI concurrency semaphore ---
// previously serial (1-at-a-time) — that meant a 6s pasta blocked the next user's
// 1s query for the full 6s. now N concurrent, queue caps total waiting depth.

// firehose mode: busy chats (kripp) need real throughput. at ~3s/response, 10 concurrent
// = ~3 responses/sec sustained — comfortably above twitch's 90/30s send ceiling so the
// irc rate-limit becomes the natural backpressure, not us.
export const AI_MAX_CONCURRENT = 10
export const AI_MAX_QUEUE = 30

let inFlight: Promise<void>[] = []
export let aiQueueDepth = 0

export async function acquireAiSlot(): Promise<() => void> {
  while (inFlight.length >= AI_MAX_CONCURRENT) {
    await Promise.race(inFlight).catch(() => {})
  }
  let release!: () => void
  const p = new Promise<void>((r) => release = r)
  inFlight.push(p)
  return () => {
    const i = inFlight.indexOf(p)
    if (i >= 0) inFlight.splice(i, 1)
    release()
  }
}

export function incrementQueue() { aiQueueDepth++ }
export function decrementQueue() { aiQueueDepth-- }

// --- per-channel daily token cap ---

// daily token cap disabled by default — uncapped per user direction. set AI_DAILY_TOKEN_CAP
// env var to re-enable if cost ever needs a hard ceiling.
export const AI_DAILY_TOKEN_CAP = Math.max(0, parseInt(process.env.AI_DAILY_TOKEN_CAP ?? '0') || 0)

export function isOverDailyCap(channel: string): boolean {
  if (AI_DAILY_TOKEN_CAP === 0) return false
  try {
    const s = db.getDailyAiSpend(channel)
    return s.input_tokens + s.output_tokens >= AI_DAILY_TOKEN_CAP
  } catch { return false }
}

// --- repeat-query abuse detection (per user, per 5min window) ---

interface RecentQuery { norm: string; ts: number; count: number }
const recentQueriesByUser = new Map<string, RecentQuery[]>()
const REPEAT_WINDOW_MS = 5 * 60_000
const REPEAT_THRESHOLD = 3
const RECENT_QUERY_KEEP = 8

function normQuery(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function isRepeatAbuse(user: string, query: string): boolean {
  const u = user.toLowerCase()
  const norm = normQuery(query)
  if (!norm) return false
  const now = Date.now()
  const list = (recentQueriesByUser.get(u) ?? []).filter((r) => now - r.ts < REPEAT_WINDOW_MS)
  let entry = list.find((r) => r.norm === norm)
  if (entry) {
    entry.count++
    entry.ts = now
  } else {
    entry = { norm, ts: now, count: 1 }
    list.push(entry)
  }
  while (list.length > RECENT_QUERY_KEEP) list.shift()
  recentQueriesByUser.set(u, list)
  if (recentQueriesByUser.size > 5_000) {
    const first = recentQueriesByUser.keys().next().value!
    recentQueriesByUser.delete(first)
  }
  return entry.count >= REPEAT_THRESHOLD
}
