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

// Channels where the AI paths are allowed to spend. Seeded from env, then kept in step
// with the channels the bot is actually IN (see enableAiForChannel, called on startup and
// on !join).
//
// Why they must track each other: this was env-only, so a streamer who ran !join got a bot
// that had joined their chat but answered nothing. The join reply even says "type !b help
// in your chat" — and !b help routes through AI, so it returned silence. 6 of 8 joined
// channels were in that state. If the bot is in your channel, it works in your channel.
//
// Spend stays bounded by the per-user and global AI cooldowns, the queue cap, the circuit
// breaker, and the Anthropic console's monthly wall — not by keeping this list short.
export const AI_CHANNELS = new Set(
  (process.env.AI_CHANNELS ?? process.env.TWITCH_CHANNELS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
)

// AI_CHANNELS entries are bare names ("nl_kripp"); callers pass either form.
function bareChannel(name: string): string {
  return name.trim().toLowerCase().replace(/^#/, '')
}

export function enableAiForChannel(name: string): void {
  const ch = bareChannel(name)
  if (ch) AI_CHANNELS.add(ch)
}

export function disableAiForChannel(name: string): void {
  AI_CHANNELS.delete(bareChannel(name))
}

/**
 * Why the AI path is unavailable here, so a caller can tell a PERMANENT state apart from a
 * transient miss. Reporting "servers are lagging" for a missing key invites a retry that
 * can never succeed.
 */
export function aiUnavailableReason(channel?: string): 'ok' | 'no-key' | 'not-enabled' {
  if (!process.env.ANTHROPIC_API_KEY) return 'no-key'
  if (!channel || !AI_CHANNELS.has(bareChannel(channel))) return 'not-enabled'
  return 'ok'
}

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

// the Helix poll seeds this on its first pass. until then an empty liveChannels set is
// "not asked yet", not "everyone is offline" — telling chat a live streamer is offline
// during the boot window would be a confident lie, so the caller stays quiet instead.
let liveStateKnown = false
export function markLiveStateKnown(): void { liveStateKnown = true }
export function isLiveStateKnown(): boolean { return liveStateKnown }

// the rest of what /helix/streams returns on every poll. title and viewer_count were being
// parsed away and thrown out, so the bot answered "what's the title?" with "i see chat not
// the stream" while the title sat in the same response it used for the game name. no extra
// API call buys any of this.
export interface StreamInfo { title?: string; viewers?: number; startedAt?: number }
const streamInfo = new Map<string, StreamInfo>()
export function setStreamInfo(channel: string, info: StreamInfo): void {
  streamInfo.set(channel.toLowerCase(), info)
}
export function getStreamInfo(channel: string): StreamInfo | undefined {
  return streamInfo.get(channel.toLowerCase())
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

// FIFO slot semaphore. the old impl raced every waiter on Promise.race(inFlight) each time a
// slot freed — a thundering herd where the winner was whoever the event loop happened to
// schedule first, NOT the longest waiter. under sustained contention (an upstream stall filling
// the queue) that gave unbounded tail-latency variance and could starve an unlucky request.
// this hands a freed slot to the HEAD of the wait queue, so wait time is bounded by queue
// position. concurrency ceiling unchanged (AI_MAX_CONCURRENT). the slot count is only ever
// decremented when there is no waiter to inherit it, so a barger can never push active past the
// ceiling in the async handoff gap.
let activeSlots = 0
const slotWaiters: Array<() => void> = []
export let aiQueueDepth = 0

// exposed for tests — the live count of occupied slots.
export function activeSlotCount(): number { return activeSlots }

export async function acquireAiSlot(): Promise<() => void> {
  if (activeSlots >= AI_MAX_CONCURRENT) {
    // park in FIFO order; a releaser wakes exactly the head waiter, handing over its slot
    // (activeSlots is NOT decremented on handoff), so we inherit an already-counted slot.
    await new Promise<void>((resolve) => slotWaiters.push(resolve))
  } else {
    activeSlots++
  }
  let released = false
  return () => {
    if (released) return // idempotent — a double release can't over-free the pool
    released = true
    const next = slotWaiters.shift()
    if (next) next() // hand our slot to the head waiter — count stays constant
    else activeSlots-- // no waiter — the slot is genuinely freed
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

// --- per-user daily AI budget ---

// every other brake is deliberately 0 (busy-chat asks must flow), which left a single
// chatter free to fan out four unattended days of trivia generation before the console
// wall caught it. this is the per-person ceiling: N AI-costing requests per PT day —
// generous enough that a real chatter never meets it, fatal to a spam loop. heavy
// surfaces (a custom trivia round fans out to ~a dozen calls) bill more than 1 unit.
// VIP-exempt at the call sites. 0 disables.
export const USER_DAILY_AI_CAP = Math.max(0, parseInt(process.env.USER_DAILY_AI_CAP ?? '40') || 0)
// the counter is write-through to sqlite (user_ai_budget). In memory alone, every restart
// refilled everybody — and with Restart=always a deploy or a crash is routine, so the cap
// was only ever as long as the current uptime. Memory stays the hot path: sqlite is read
// once per user per day, written on each bump, and fail-soft on both sides.
const userAiDay = new Map<string, { day: string; n: number }>()

function userEntry(u: string, day: string): { day: string; n: number } {
  const e = userAiDay.get(u)
  if (e && e.day === day) return e
  const fresh = { day, n: db.getUserAiUnits(u, day) }
  userAiDay.set(u, fresh)
  if (userAiDay.size > 5_000) {
    for (const [k, v] of userAiDay) if (v.day !== day) userAiDay.delete(k)
  }
  return fresh
}

export function noteUserAiRequest(user: string, weight = 1): void {
  if (USER_DAILY_AI_CAP === 0) return
  const u = user.toLowerCase()
  userEntry(u, db.ptDay()).n += weight
  db.bumpUserAiUnits(u, weight)
}

export function isUserOverDailyAiCap(user: string): boolean {
  if (USER_DAILY_AI_CAP === 0) return false
  return userEntry(user.toLowerCase(), db.ptDay()).n >= USER_DAILY_AI_CAP
}

// exported for tests — the counter is process-global by design.
export function resetUserAiBudgetForTests(): void {
  userAiDay.clear()
  db.clearUserAiBudget()
}

// --- AI trivia kill switch ---

// AI-generated trivia (custom topics, chat/person rounds, game-dossier rounds) is OFF
// unless AI_TRIVIA=1. It was the single biggest token line-item in the bot — a round can
// fan out to a dozen generate+verify calls, and none of it is core: lookups, answers and
// grounding are. The deterministic generators (bazaar cards, HS cards, the curated quiz
// and kripp packs) are untouched and cost nothing, so trivia still works, just without a
// model behind it. Read lazily so the flag can be flipped without a rebuild.
export const aiTriviaEnabled = () => process.env.AI_TRIVIA === '1'
