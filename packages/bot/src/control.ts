// the one action layer behind mod control. chat plain-talk (control-intent.ts) and the
// control panel (panel-server.ts) both land here, so a pause from the web and a pause
// from chat are the same pause. snapshot() is the panel's read side — structured, and
// like activeRoundInfo it never carries a live trivia answer.

import { SUPPRESS_MAX_MIN, listSuppressions, type SuppressFeature } from './suppress'
import { listDirectives, removeDirectives, clearDirectives } from './directives'
import { applyEnglishOnly, applySuppress, applyResume, banTriviaTopic, unbanTriviaTopic, listTriviaTopicBans, normTopic } from './commands-mod'
import { runTrivia, listTopicQueue, clearTopicQueue, stripTopicConnector } from './commands-trivia'
import { skipTrivia, activeRoundInfo, activeGameId } from './trivia'
import { getTriviaCd, setTriviaCd, CD_CHOICES, type CdScope } from './trivia-cd'
import * as dungeon from './dungeon/loop'
import * as raid from './raid/state'
import {
  isAiChannelEnabled, enableAiForChannel, disableAiForChannel, getStreamInfo, getLiveChannels,
  getChannelGame, cbIsOpen, activeSlotCount, aiQueueDepth, AI_MAX_QUEUE, AI_DAILY_TOKEN_CAP,
  aiTriviaEnabled, setAiTriviaOverride, resetUserAiUnitsToday, dropRecentResponse, USER_DAILY_AI_CAP,
} from './ai-cache'
import { hardStopReasonPure, hardStopResumeAt } from './ai-http'
import { WEB_SEARCH_DAILY_CAP } from './ai-search-gate'
import { ignoreUser, unignoreUser, listIgnored, IGNORE_MAX_MIN, LOGIN_RE, type IgnoredRow } from './ignore'
import { isGoalsEnabled, setGoalsEnabled } from './worldcup-goals'
import { isEnglishOnly } from './english-only'
import { listTimedOut } from './moderation'
import * as db from './db'
import { log } from './log'

export const FEATURES: readonly SuppressFeature[] = ['trivia', 'depths', 'ai', 'all']
export const PACES: readonly raid.Pace[] = ['fast', 'normal', 'slow']
export const SAY_MAX = 450
const TOPIC_MAX = 60
// how many of a channel's latest rounds a mod may flag — the panel lists 3, this leaves slack
const FLAG_WINDOW = 5

export type Action =
  | { kind: 'pause'; feature: SuppressFeature; minutes?: number }
  | { kind: 'resume'; feature: SuppressFeature }
  | { kind: 'vibe-drop'; index: number }
  | { kind: 'vibe-clear' }
  | { kind: 'topic-ban'; topic: string }
  | { kind: 'topic-unban'; topic: string }
  | { kind: 'queue-clear' }
  | { kind: 'trivia-start'; topic?: string }
  | { kind: 'trivia-skip' }
  | { kind: 'trivia-flag'; gameId: number }
  | { kind: 'trivia-cd'; scope: CdScope; seconds: number }
  | { kind: 'depths-reset' }
  | { kind: 'raid'; on: boolean }
  | { kind: 'raid-pace'; pace: raid.Pace }
  | { kind: 'ai'; on: boolean }
  | { kind: 'goals'; on: boolean }
  | { kind: 'english-only'; on: boolean }
  | { kind: 'cap-reset'; user: string }
  | { kind: 'ask-purge'; id: number }
  | { kind: 'ai-trivia'; on: boolean }
  | { kind: 'say'; text: string }
  | { kind: 'ignore'; user: string; minutes?: number; forever?: true }
  | { kind: 'unignore'; user: string }
  | { kind: 'join'; target: string }
  | { kind: 'part'; target: string }

export type ActionKind = Action['kind']
// say is admin-only: any streamer can !join the bot, log in as their own channel's owner
// and make it post anything, and one ToS-breaking line risks the account in every channel.
// a mod can type in their own chat; the bot's voice is not theirs to lend.
export const ADMIN_KINDS: ReadonlySet<ActionKind> = new Set(['join', 'part', 'ai-trivia', 'say'])

export interface ActResult { ok: boolean; msg: string }

// --- wiring (index.ts) ---------------------------------------------------------------
// sending + join/part live on the twitch client / index.ts; injected, never imported,
// so this module stays a leaf the chat path can import without a cycle.

type Sender = (channel: string, text: string) => Promise<unknown> | unknown
type ChannelOp = (target: string, by: string) => Promise<string>
let send: Sender | null = null
let joinOp: ChannelOp | null = null
let partOp: ChannelOp | null = null

export function setControlSender(fn: Sender): void { send = fn }
export function setControlChannelOps(join: ChannelOp, part: ChannelOp): void { joinOp = join; partOp = part }

// health readout — transport/rate-limit state lives on the twitch client, uptime/data
// freshness on index.ts's boot clock and the store cache. injected, not imported, same
// reason as send/join above: this module stays a leaf.
export interface HealthProvider {
  irc: () => boolean
  eventsub: () => boolean
  privileged: (channel: string) => boolean
  sendBucket: (channel: string) => { used: number; limit: number }
  lastDrop: (channel: string) => { at: number; reason: string } | null
  uptimeSec: () => number
  dataAgeSec: () => number
}
let health: HealthProvider | null = null
export function setHealthProvider(p: HealthProvider): void { health = p }

const listeners = new Set<(channel: string) => void>()
/** fires after any state-changing action — the panel's live stream pushes on it. */
export function onControlChange(fn: (channel: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function changed(channel: string): void {
  for (const fn of listeners) {
    try { fn(channel) } catch {}
  }
}

// --- validation (untrusted json from the panel) ----------------------------------------

const CHANNEL_RE = /^[a-z0-9_]{2,25}$/
const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null
const feature = (v: unknown): SuppressFeature | null =>
  FEATURES.includes(v as SuppressFeature) ? v as SuppressFeature : null

/** untrusted input → a well-formed Action, or null. the only door from http into act(). */
export function parseAction(input: unknown): Action | null {
  if (!input || typeof input !== 'object') return null
  const a = input as Record<string, unknown>
  switch (a.kind) {
    case 'pause': {
      const f = feature(a.feature)
      if (!f) return null
      if (a.minutes === undefined) return { kind: 'pause', feature: f }
      const m = a.minutes
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > SUPPRESS_MAX_MIN) return null
      return { kind: 'pause', feature: f, minutes: m }
    }
    case 'resume': {
      const f = feature(a.feature)
      return f ? { kind: 'resume', feature: f } : null
    }
    case 'vibe-drop': {
      const i = a.index
      return typeof i === 'number' && Number.isInteger(i) && i >= 1 && i <= 20 ? { kind: 'vibe-drop', index: i } : null
    }
    case 'topic-ban':
    case 'topic-unban': {
      const t = str(a.topic, TOPIC_MAX)
      return t && normTopic(t) ? { kind: a.kind, topic: t } : null
    }
    case 'trivia-start': {
      if (a.topic === undefined || a.topic === '') return { kind: 'trivia-start' }
      const t = str(a.topic, TOPIC_MAX)
      return t ? { kind: 'trivia-start', topic: t } : null
    }
    case 'trivia-cd': {
      const scope = a.scope === 'round' || a.scope === 'user' ? a.scope : null
      return scope && typeof a.seconds === 'number' && CD_CHOICES[scope].includes(a.seconds)
        ? { kind: 'trivia-cd', scope, seconds: a.seconds }
        : null
    }
    case 'trivia-flag': {
      const id = a.gameId
      return typeof id === 'number' && Number.isInteger(id) && id > 0 ? { kind: 'trivia-flag', gameId: id } : null
    }
    case 'raid':
    case 'ai':
    case 'goals':
    case 'english-only':
    case 'ai-trivia':
      return typeof a.on === 'boolean' ? { kind: a.kind, on: a.on } : null
    case 'raid-pace':
      return PACES.includes(a.pace as raid.Pace) ? { kind: 'raid-pace', pace: a.pace as raid.Pace } : null
    case 'cap-reset': {
      const u = typeof a.user === 'string' ? a.user.trim().toLowerCase().replace(/^@/, '') : ''
      return LOGIN_RE.test(u) ? { kind: 'cap-reset', user: u } : null
    }
    case 'ask-purge': {
      const id = a.id
      return typeof id === 'number' && Number.isInteger(id) && id > 0 ? { kind: 'ask-purge', id } : null
    }
    case 'say': {
      const t = str(a.text, SAY_MAX)
      return t && !/[\r\n]/.test(t) ? { kind: 'say', text: t } : null
    }
    case 'ignore':
    case 'unignore': {
      const u = typeof a.user === 'string' ? a.user.trim().toLowerCase().replace(/^@/, '') : ''
      if (!LOGIN_RE.test(u)) return null
      if (a.kind === 'ignore' && a.forever === true) return { kind: 'ignore', user: u, forever: true }
      if (a.kind === 'unignore' || a.minutes === undefined) return { kind: a.kind, user: u }
      const m = a.minutes
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > IGNORE_MAX_MIN) return null
      return { kind: 'ignore', user: u, minutes: m }
    }
    case 'join':
    case 'part': {
      const t = typeof a.target === 'string' ? a.target.trim().toLowerCase().replace(/^#/, '') : ''
      return CHANNEL_RE.test(t) ? { kind: a.kind, target: t } : null
    }
    case 'vibe-clear':
    case 'queue-clear':
    case 'trivia-skip':
    case 'depths-reset':
      return { kind: a.kind }
    default:
      return null
  }
}

const ignoreLengthText = (a: { minutes?: number; forever?: true }): string =>
  a.forever ? ' until a mod lifts it' : a.minutes ? ` for ${fmtMins(a.minutes)}` : ' until stream ends'

// 90 → "90m", 1440 → "24h", 10080 → "7d" — whole units only, else minutes
export function fmtMins(m: number): string {
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440}d`
  if (m >= 60 && m % 60 === 0) return `${m / 60}h`
  return `${m}m`
}

// 30 → "30s", 120 → "2m" — whole minutes when it divides, else seconds
const fmtCd = (sec: number): string => (sec >= 60 && sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`)

// the panel's words, not the code's: a mod reads "dungeon" and "bot replies" on every
// switch, so the preview and the log must say the same thing
const FEATURE_LABEL: Record<string, string> = { ai: 'bot replies', depths: 'dungeon', trivia: 'trivia', all: 'everything' }

/** one-line human preview — the panel's "→ pause trivia 1h" confirm line + the audit row. */
export function describe(a: Action): string {
  switch (a.kind) {
    case 'pause': return `pause ${FEATURE_LABEL[a.feature] ?? a.feature}${a.minutes ? ` ${fmtMins(a.minutes)}` : ''}`
    case 'resume': return `resume ${FEATURE_LABEL[a.feature] ?? a.feature}`
    case 'vibe-drop': return `drop chat rule #${a.index}`
    case 'vibe-clear': return 'clear all chat rules'
    case 'topic-ban': return `ban trivia topic "${a.topic}"`
    case 'topic-unban': return `unban trivia topic "${a.topic}"`
    case 'queue-clear': return 'clear trivia queue'
    case 'trivia-start': return a.topic ? `start trivia about "${a.topic}"` : 'start trivia'
    case 'trivia-skip': return 'skip trivia round'
    case 'trivia-flag': return `flag trivia question #${a.gameId} as bad`
    case 'trivia-cd': return `${a.scope} cd ${a.seconds ? fmtCd(a.seconds) : 'off'}`
    case 'depths-reset': return 'reset the dungeon'
    case 'raid': return `raid game ${a.on ? 'on' : 'off'}`
    case 'raid-pace': return `raid speed ${a.pace}`
    case 'ai': return `bot replies ${a.on ? 'on' : 'off'}`
    case 'goals': return `goal alerts ${a.on ? 'on' : 'off'}`
    case 'english-only': return `english only ${a.on ? 'on' : 'off'}`
    case 'cap-reset': return `reset @${a.user}'s daily limit`
    case 'ask-purge': return `remove reply #${a.id}`
    case 'ai-trivia': return `ai trivia ${a.on ? 'on' : 'off'} (every channel)`
    case 'say': return `say "${a.text}"`
    case 'ignore': return `ignore @${a.user}${ignoreLengthText(a)}`
    case 'unignore': return `stop ignoring @${a.user}`
    case 'join': return `join #${a.target}`
    case 'part': return `leave #${a.target}`
  }
}

// --- act -----------------------------------------------------------------------------

async function post(channel: string, text: string | null | undefined): Promise<void> {
  if (text && send) await send(channel, text)
}

/**
 * run one action for `channel` as `by`. authorization is the caller's job (panel session
 * scope / chat mod badge) — this layer trusts its inputs are already allowed.
 * `announce` posts chat-visible results (a skipped round's answer, a started question).
 * the chat door passes false and replies with msg itself — either way chat sees the line,
 * never a headless round.
 * `source` ('panel' | 'chat') is the audit trail's provenance — the ONE place a state
 * change is logged, so a mod's plain-talk pause in chat shows up in the panel's log the
 * same as a button click, and neither caller can forget to log it.
 * `isAdmin` gates the handful of actions (cap-reset) whose authorization depends on more
 * than "is this a mod of the channel" — panel-server passes session.admin; the chat door
 * never issues those kinds, so it stays at the false default.
 */
export async function act(channel: string, by: string, a: Action, announce = true, source: db.PanelAuditSource = 'panel', isAdmin = false): Promise<ActResult> {
  const ch = channel.toLowerCase()
  const res = await run(ch, by, a, announce, isAdmin)
  if (res.ok) {
    changed(ch)
    try { db.logPanelAction(by, ch, a.kind, describe(a), source) } catch (e) { log(`control: audit log failed: ${e}`) }
  }
  return res
}

async function run(ch: string, by: string, a: Action, announce: boolean, isAdmin: boolean): Promise<ActResult> {
  switch (a.kind) {
    case 'pause': {
      const msg = applySuppress(ch, a.feature, by, a.minutes, '')
      if (announce) await post(ch, msg)
      return { ok: true, msg }
    }
    case 'resume': {
      const msg = applyResume(ch, a.feature, '')
      if (!msg) return { ok: false, msg: `${a.feature} wasn't paused` }
      if (announce) await post(ch, msg)
      return { ok: true, msg }
    }
    case 'vibe-drop': {
      const gone = removeDirectives(ch, [a.index])
      return gone.length ? { ok: true, msg: `dropped vibe #${a.index}` } : { ok: false, msg: `no vibe #${a.index}` }
    }
    case 'vibe-clear': {
      const n = clearDirectives(ch)
      return n ? { ok: true, msg: `cleared ${n} vibe${n === 1 ? '' : 's'}` } : { ok: false, msg: 'no active vibes' }
    }
    case 'topic-ban':
      return { ok: true, msg: `"${banTriviaTopic(ch, a.topic)}" trivia banned for 2h` }
    case 'topic-unban':
      return unbanTriviaTopic(ch, a.topic)
        ? { ok: true, msg: `"${normTopic(a.topic)}" trivia allowed again` }
        : { ok: false, msg: `"${normTopic(a.topic)}" wasn't banned` }
    case 'queue-clear': {
      const n = listTopicQueue(ch).length
      clearTopicQueue(ch)
      return n ? { ok: true, msg: `cleared ${n} queued topic${n === 1 ? '' : 's'}` } : { ok: false, msg: 'queue already empty' }
    }
    case 'trivia-start': {
      // the chat path itself — bans, pauses, queueing, ai caps all apply unchanged
      const msg = await runTrivia({ user: by, channel: ch, isMod: true, privileged: true }, stripTopicConnector(a.topic ?? ''), '')
      if (!msg) return { ok: false, msg: 'no trivia started' }
      if (announce) await post(ch, msg)
      return { ok: true, msg }
    }
    case 'trivia-skip': {
      const msg = skipTrivia(ch, by)
      if (!msg) return { ok: false, msg: 'no round running' }
      if (announce) await post(ch, msg)
      return { ok: true, msg }
    }
    case 'trivia-flag': {
      // only a round this channel actually played, and only one of the last few the panel
      // listed — a forged id can't reach another channel's rows or old history.
      if (!db.isRecentTriviaGame(ch, a.gameId, FLAG_WINDOW)) return { ok: false, msg: `round #${a.gameId} not found` }
      const live = activeGameId(ch) === a.gameId
      const purged = db.flagTriviaGame(a.gameId, by, ch)
      if (purged === null) return { ok: false, msg: `round #${a.gameId} not found` }
      // the bad question is still on the clock: end it. skipTrivia's reveal is the same line
      // chat gets from any skip — by then the question is already public, so nothing new leaks.
      if (live) {
        const msg = skipTrivia(ch, by)
        if (msg && announce) await post(ch, msg)
      }
      return { ok: true, msg: `flagged round #${a.gameId}${purged ? `, dropped ${purged} banked` : ''}${live ? ', skipped' : ''}` }
    }
    case 'trivia-cd':
      return setTriviaCd(ch, a.scope, a.seconds, by)
        ? { ok: true, msg: `trivia ${a.scope} cd ${a.seconds ? fmtCd(a.seconds) : 'off'}` }
        : { ok: false, msg: 'bad cooldown value' }
    case 'depths-reset':
      return { ok: true, msg: dungeon.resetRun(ch) }
    case 'raid':
      raid.setEnabled(ch, a.on)
      return { ok: true, msg: `raid game ${a.on ? 'enabled' : 'disabled'}` }
    case 'raid-pace':
      raid.setPace(ch, a.pace)
      return { ok: true, msg: `raid pace ${a.pace}` }
    case 'ai':
      if (a.on) enableAiForChannel(ch)
      else disableAiForChannel(ch)
      return { ok: true, msg: `ai answers ${a.on ? 'on' : 'off'}` }
    case 'goals':
      setGoalsEnabled(ch, a.on, by)
      return { ok: true, msg: `goal alerts ${a.on ? 'on' : 'off'}` }
    case 'english-only': {
      const { changed } = applyEnglishOnly(ch, a.on, by)
      return { ok: true, msg: `english only ${a.on ? 'on' : 'off'}${changed ? '' : ' (already)'}` }
    }
    case 'cap-reset': {
      // a mod resetting their OWN cap is the abuse case this action exists to prevent
      // elsewhere from — never allowed except for an actual admin. and the target must be
      // someone who's genuinely asked in this channel (the same list the panel shows a
      // reset button next to), not an arbitrary login guessed at the http layer.
      if (!isAdmin) {
        if (a.user === by.toLowerCase()) return { ok: false, msg: "can't reset your own limit" }
        const askers = new Set(db.getTopAskersToday(ch, 8).map((u) => u.user.toLowerCase()))
        if (!askers.has(a.user)) return { ok: false, msg: `@${a.user} hasn't asked anything here today` }
      }
      resetUserAiUnitsToday(a.user)
      return { ok: true, msg: `reset @${a.user}'s ai budget for today` }
    }
    case 'ask-purge': {
      const response = db.purgeAsk(a.id, ch)
      if (response === null) return { ok: false, msg: `question #${a.id} not found` }
      dropRecentResponse(ch, response)
      return { ok: true, msg: `removed question #${a.id}` }
    }
    case 'ai-trivia':
      setAiTriviaOverride(a.on)
      return { ok: true, msg: `ai trivia (all channels) ${a.on ? 'on' : 'off'}` }
    case 'say':
      if (!send) return { ok: false, msg: 'not connected' }
      await send(ch, a.text)
      return { ok: true, msg: 'sent' }
    case 'ignore': {
      const who = ignoreUser(ch, a.user, by, a.forever ? 'forever' : a.minutes ?? 'stream')
      return who
        ? { ok: true, msg: `ignoring @${who}${ignoreLengthText(a)}` }
        : { ok: false, msg: `can't ignore @${a.user}` }
    }
    case 'unignore':
      return unignoreUser(ch, a.user) ? { ok: true, msg: `@${a.user} unignored` } : { ok: false, msg: `@${a.user} wasn't ignored` }
    case 'join':
      if (!joinOp) return { ok: false, msg: 'join unavailable' }
      return { ok: true, msg: await joinOp(a.target, by) }
    case 'part':
      if (!partOp) return { ok: false, msg: 'part unavailable' }
      return { ok: true, msg: await partOp(a.target, by) }
  }
}

// --- snapshot --------------------------------------------------------------------------

export interface Health {
  irc: boolean
  eventsub: boolean
  privileged: boolean
  sends: { used: number; limit: number }
  lastDrop: { at: number; reason: string } | null
  uptimeSec: number
  dataAgeSec: number
}

export interface Snapshot {
  channel: string
  now: number
  stream: { live: boolean; game: string | null; title: string | null; viewers: number | null; startedAt: number | null }
  ai: {
    enabled: boolean; breaker: boolean; slots: number; queue: number; queueMax: number; hardStop: string; hardStopUntil: number | null
    tokensToday: number; callsToday: number; globalTokensToday: number; searchesToday: number; searchCap: number | null
    aiTrivia: boolean; tokenCap: number
  }
  pauses: { feature: SuppressFeature; by: string; minutes: number }[]
  ignored: IgnoredRow[]
  vibes: { n: number; mod: boolean; planter: string; mute: boolean; target: string | null; trigger: string[]; instruction: string; minutes: number }[]
  trivia: {
    round: { question: string; secondsLeft: number; guesses: number } | null
    queue: { topic: string; user: string }[]
    bans: { topic: string; minutes: number }[]
    cd: { round: number; user: number }
    /** last ended AI rounds, answers included — the live round is never in here. */
    recent: { id: number; question: string; answer: string; flagged: boolean }[]
  }
  depths: string
  raid: { enabled: boolean; pace: raid.Pace }
  goals: boolean
  englishOnly: boolean
  health: Health | null
  spark: number[]
  asks: db.RecentAsk[]
  misses: db.RecentMiss[]
  topUsers: (db.TopAiUser & { cap: number })[]
  timedOut: { login: string; minutesLeft: number }[]
  audit: db.PanelAuditRow[]
}

// one broken subsystem shows as its fallback, never blanks the whole panel
function safe<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (e) {
    log(`control: snapshot ${what} failed: ${e}`)
    return fallback
  }
}

// ended AI rounds only: the live round's answer is already in trivia_games, so it is
// filtered out by id — the snapshot must never carry an answer chat hasn't been shown.
function recentRounds(ch: string): Snapshot['trivia']['recent'] {
  const live = activeGameId(ch)
  return safe('recent', () => db.recentAiTriviaGames(ch, 4).filter((g) => g.id !== live).slice(0, 3), [])
}

export function snapshot(channel: string): Snapshot {
  const ch = channel.toLowerCase()
  const now = Date.now()
  const info = getStreamInfo(ch)
  const spend = db.getDailyAiSpend(ch)
  return {
    channel: ch,
    now,
    stream: {
      live: getLiveChannels().includes(ch),
      game: getChannelGame(ch) ?? null,
      title: info?.title ?? null,
      viewers: info?.viewers ?? null,
      startedAt: info?.startedAt ?? null,
    },
    ai: {
      enabled: isAiChannelEnabled(ch),
      breaker: cbIsOpen(),
      slots: activeSlotCount(),
      queue: aiQueueDepth,
      queueMax: AI_MAX_QUEUE,
      hardStop: hardStopReasonPure(),
      hardStopUntil: hardStopResumeAt() || null,
      tokensToday: spend.input_tokens + spend.output_tokens,
      callsToday: spend.calls,
      globalTokensToday: db.getGlobalDailyAiSpend().tokens,
      searchesToday: db.getWebSearchesToday(),
      searchCap: Number.isFinite(WEB_SEARCH_DAILY_CAP) ? WEB_SEARCH_DAILY_CAP : null, // null = no cap (json has no Infinity)
      aiTrivia: aiTriviaEnabled(),
      tokenCap: AI_DAILY_TOKEN_CAP,
    },
    pauses: listSuppressions(ch),
    ignored: listIgnored(ch),
    vibes: listDirectives(ch).map((d, i) => ({
      n: i + 1,
      mod: !!d.mod,
      planter: d.planter,
      mute: !!d.mute,
      target: d.targetUser ?? null,
      trigger: d.trigger,
      instruction: d.instruction,
      minutes: Math.max(1, Math.round((d.expiresAt - now) / 60_000)),
    })),
    trivia: { round: activeRoundInfo(ch), queue: listTopicQueue(ch), bans: listTriviaTopicBans(ch), cd: getTriviaCd(ch), recent: recentRounds(ch) },
    depths: safe('depths', () => dungeon.statusLine(ch), 'unavailable'),
    raid: safe('raid', () => ({ enabled: raid.isEnabled(ch), pace: raid.getPace(ch) }), { enabled: false, pace: 'normal' as raid.Pace }),
    goals: safe('goals', () => isGoalsEnabled(ch), true),
    englishOnly: safe('englishOnly', () => isEnglishOnly(ch), false),
    health: safe('health', () => health ? {
      irc: health.irc(),
      eventsub: health.eventsub(),
      privileged: health.privileged(ch),
      sends: health.sendBucket(ch),
      lastDrop: health.lastDrop(ch),
      uptimeSec: health.uptimeSec(),
      dataAgeSec: health.dataAgeSec(),
    } : null, null),
    spark: safe('spark', () => db.getAskSpark(ch), new Array(60).fill(0)),
    asks: safe('asks', () => db.recentAsks(ch, 20), []),
    misses: safe('misses', () => db.recentMisses(ch, 15), []),
    topUsers: safe('topUsers', () => db.getTopAskersToday(ch, 8).map((u) => ({ ...u, cap: USER_DAILY_AI_CAP })), []),
    timedOut: safe('timedOut', () => listTimedOut(ch), []),
    audit: safe('audit', () => db.recentPanelActions(ch, 15), []),
  }
}
