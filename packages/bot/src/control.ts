// the one action layer behind mod control. chat plain-talk (control-intent.ts) and the
// control panel (panel-server.ts) both land here, so a pause from the web and a pause
// from chat are the same pause. snapshot() is the panel's read side — structured, and
// like activeRoundInfo it never carries a live trivia answer.

import { SUPPRESS_MAX_MIN, listSuppressions, type SuppressFeature } from './suppress'
import { listDirectives, removeDirectives, clearDirectives } from './directives'
import { applySuppress, applyResume, banTriviaTopic, unbanTriviaTopic, listTriviaTopicBans, normTopic } from './commands-mod'
import { runTrivia, listTopicQueue, clearTopicQueue, stripTopicConnector } from './commands-trivia'
import { skipTrivia, activeRoundInfo } from './trivia'
import * as dungeon from './dungeon/loop'
import * as raid from './raid/state'
import {
  AI_CHANNELS, enableAiForChannel, disableAiForChannel, getStreamInfo, getLiveChannels,
  getChannelGame, cbIsOpen, activeSlotCount, aiQueueDepth,
} from './ai-cache'
import { hardStopReasonText } from './ai-http'
import { ignoreUser, unignoreUser, listIgnored, IGNORE_MAX_MIN, LOGIN_RE } from './ignore'
import * as db from './db'
import { log } from './log'

export const FEATURES: readonly SuppressFeature[] = ['trivia', 'depths', 'ai', 'all']
export const PACES: readonly raid.Pace[] = ['fast', 'normal', 'slow']
export const SAY_MAX = 450
const TOPIC_MAX = 60

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
  | { kind: 'depths-reset' }
  | { kind: 'raid'; on: boolean }
  | { kind: 'raid-pace'; pace: raid.Pace }
  | { kind: 'ai'; on: boolean }
  | { kind: 'say'; text: string }
  | { kind: 'ignore'; user: string; minutes?: number }
  | { kind: 'unignore'; user: string }
  | { kind: 'join'; target: string }
  | { kind: 'part'; target: string }

export type ActionKind = Action['kind']
export const ADMIN_KINDS: ReadonlySet<ActionKind> = new Set(['join', 'part'])

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
    case 'raid':
    case 'ai':
      return typeof a.on === 'boolean' ? { kind: a.kind, on: a.on } : null
    case 'raid-pace':
      return PACES.includes(a.pace as raid.Pace) ? { kind: 'raid-pace', pace: a.pace as raid.Pace } : null
    case 'say': {
      const t = str(a.text, SAY_MAX)
      return t && !/[\r\n]/.test(t) ? { kind: 'say', text: t } : null
    }
    case 'ignore':
    case 'unignore': {
      const u = typeof a.user === 'string' ? a.user.trim().toLowerCase().replace(/^@/, '') : ''
      if (!LOGIN_RE.test(u)) return null
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

// 90 → "90m", 1440 → "24h", 10080 → "7d" — whole units only, else minutes
export function fmtMins(m: number): string {
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440}d`
  if (m >= 60 && m % 60 === 0) return `${m / 60}h`
  return `${m}m`
}

/** one-line human preview — the panel's "→ pause ai 60m" confirm line + the audit row. */
export function describe(a: Action): string {
  switch (a.kind) {
    case 'pause': return `pause ${a.feature}${a.minutes ? ` ${fmtMins(a.minutes)}` : ''}`
    case 'resume': return `resume ${a.feature}`
    case 'vibe-drop': return `drop vibe #${a.index}`
    case 'vibe-clear': return 'clear all vibes'
    case 'topic-ban': return `ban trivia topic "${a.topic}"`
    case 'topic-unban': return `unban trivia topic "${a.topic}"`
    case 'queue-clear': return 'clear trivia queue'
    case 'trivia-start': return a.topic ? `start trivia about "${a.topic}"` : 'start trivia'
    case 'trivia-skip': return 'skip trivia round'
    case 'depths-reset': return 'reset the depths'
    case 'raid': return `raid game ${a.on ? 'on' : 'off'}`
    case 'raid-pace': return `raid pace ${a.pace}`
    case 'ai': return `ai answers ${a.on ? 'on' : 'off'}`
    case 'say': return `say "${a.text}"`
    case 'ignore': return `ignore @${a.user}${a.minutes ? ` for ${fmtMins(a.minutes)}` : ' until lifted'}`
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
 */
export async function act(channel: string, by: string, a: Action, announce = true): Promise<ActResult> {
  const ch = channel.toLowerCase()
  const res = await run(ch, by, a, announce)
  if (res.ok) changed(ch)
  return res
}

async function run(ch: string, by: string, a: Action, announce: boolean): Promise<ActResult> {
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
      return { ok: true, msg: `ai answers ${a.on ? 'on' : 'off'} (until restart)` }
    case 'say':
      if (!send) return { ok: false, msg: 'not connected' }
      await send(ch, a.text)
      return { ok: true, msg: 'sent' }
    case 'ignore': {
      const who = ignoreUser(ch, a.user, by, a.minutes)
      return who
        ? { ok: true, msg: `ignoring @${who}${a.minutes ? ` for ${fmtMins(a.minutes)}` : ' until lifted'}` }
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

export interface Snapshot {
  channel: string
  now: number
  stream: { live: boolean; game: string | null; title: string | null; viewers: number | null; startedAt: number | null }
  ai: {
    enabled: boolean; breaker: boolean; slots: number; queue: number; hardStop: string
    tokensToday: number; callsToday: number; globalTokensToday: number; searchesToday: number
  }
  pauses: { feature: SuppressFeature; by: string; minutes: number }[]
  ignored: { login: string; by: string; minutes: number | null }[]
  vibes: { n: number; mod: boolean; planter: string; mute: boolean; target: string | null; trigger: string[]; instruction: string; minutes: number }[]
  trivia: {
    round: { question: string; secondsLeft: number; guesses: number } | null
    queue: { topic: string; user: string }[]
    bans: { topic: string; minutes: number }[]
  }
  depths: string
  raid: { enabled: boolean; pace: raid.Pace }
  asks: db.RecentAsk[]
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
      enabled: AI_CHANNELS.has(ch),
      breaker: cbIsOpen(),
      slots: activeSlotCount(),
      queue: aiQueueDepth,
      hardStop: hardStopReasonText(),
      tokensToday: spend.input_tokens + spend.output_tokens,
      callsToday: spend.calls,
      globalTokensToday: db.getGlobalDailyAiSpend().tokens,
      searchesToday: db.getWebSearchesToday(),
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
    trivia: { round: activeRoundInfo(ch), queue: listTopicQueue(ch), bans: listTriviaTopicBans(ch) },
    depths: safe('depths', () => dungeon.statusLine(ch), 'unavailable'),
    raid: safe('raid', () => ({ enabled: raid.isEnabled(ch), pace: raid.getPace(ch) }), { enabled: false, pace: 'normal' as raid.Pace }),
    asks: safe('asks', () => db.recentAsks(ch, 20), []),
    audit: safe('audit', () => db.recentPanelActions(ch, 15), []),
  }
}
