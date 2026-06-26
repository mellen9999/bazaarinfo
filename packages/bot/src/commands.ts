import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults, truncate, resolveTooltip, compressTooltip, TIER_ORDER } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail, BazaarCard } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import type { CmdType } from './db'
import { startTrivia, startCustomTrivia, getTriviaScore, formatStats, formatTop, invalidateAliasCache, isGameActive, skipTrivia, recentQuestionList, isRecentQuestion, recentAnswerList, isRecentAnswer, startKrippTrivia, startFallbackTrivia } from './trivia'
import { generateCustomTrivia, generateChatTrivia, generatePersonTrivia, type CustomTrivia } from './ai-trivia'
import { parseDirective } from './ai-directive'
import { addDirective, listDirectives, clearDirectives, isMuted } from './directives'
import { aiRespond, dedupeEmote, dedupeMention, fixEmoteCase, fixEmotePunctuation, capEmoteTotal, capRepeatedSpam } from './ai'
import { isLowValue } from './ai-query'
import { isEmote, findEmote } from './emotes'
import { glossaryAnswer, isBareKeyword } from './glossary'
import { getThread, getRecent } from './chatbuf'
import { log } from './log'
import * as raidCmds from './raid/commands'
import * as dungeon from './dungeon'

const MAX_LEN = 480

const NO_MATCH_LINES = [
  (q: string) => `"${q}" isn't a thing... yet. petition to add it tho`,
  (q: string) => `searched the entire bazaar for "${q}", found only dust`,
  (q: string) => `"${q}"? the bazaar keeper squints and shakes his head`,
  (q: string) => `legend says "${q}" was removed in the great patch of '25`,
  (q: string) => `"${q}" sounds made up but honestly so does half this game`,
  (q: string) => `i asked every merchant about "${q}". they laughed at me`,
  (q: string) => `"${q}" not found. have you tried turning the bazaar off and on`,
  (q: string) => `the ancient scrolls contain no record of "${q}"`,
]
let noMatchIdx = 0
function noMatchMsg(query: string): string {
  const q = query.slice(0, 30)
  const msg = NO_MATCH_LINES[noMatchIdx % NO_MATCH_LINES.length](q)
  noMatchIdx++
  return msg
}

// transient-AI-miss fallback for creative/conversational asks — keeps the "answer
// every !b" contract when the model times out or exhausts retries. on-vibe, retryable.
const AI_BUSY_LINES = [
  'brain glitched on that one — hit me again',
  'lost my train of thought, run it back',
  'that one broke me for a sec, try once more',
  'merchant fumbled the scroll — ask again',
]
let aiBusyIdx = 0
function aiBusyLine(): string {
  return AI_BUSY_LINES[aiBusyIdx++ % AI_BUSY_LINES.length]
}

/** shared AI call + post-processing (dedup emotes/mentions, append missing @mentions) */
async function tryAiRespond(query: string, ctx: CommandContext, mentions: string[] = []): Promise<string | null> {
  let result: Awaited<ReturnType<typeof aiRespond>> = null
  try { result = await aiRespond(query, { ...ctx, direct: true }) } catch (e) { log(`ai: call failed: ${e}`) }
  if (!result?.text) return null
  // creative writing may use an emote as a recurring character/noun — skip channel-recent
  // emote dedup there so we don't gut the prose ("Crowge watched" → "the watched"). the
  // 5-emote total cap (capEmoteTotal) still applies.
  const isCreativeQ = /\b(continue|extend|expand|write|make|create|story|pasta|copypasta|poem|rant|monologue|lore|saga|fanfic|narrative|haiku|sonnet|ballad|rap|song|roast|joke|bit|scene)\b/i.test(query)
  const deduped = isCreativeQ ? result.text : dedupeEmote(result.text, ctx.channel)
  let response = dedupeMention(capRepeatedSpam(capEmoteTotal(fixEmotePunctuation(fixEmoteCase(deduped, ctx.channel), ctx.channel), ctx.channel)), ctx.channel, ctx.user)
  if (mentions.length > 0) {
    const lower = response.toLowerCase()
    const missing = mentions.map((m) => m.toLowerCase()).filter((m) => !lower.includes(m))
    if (missing.length > 0) response = withSuffix(response, ` ${missing.join(' ')}`)
  }
  return response
}

// --- bare !b → AI contextual response ---
// Priority: (1) answer any unanswered question in recent chat; (2) varied nudge anchored on real chat.
// Hard contract: NEVER emit the legacy "!b <item> [tier] ... bazaardb.gg" usage string.

export const BARE_B_NUDGES = [
  'pick one specific chatter or moment from recent chat and react in one sentence',
  'observation about whats happening in chat right now — one concrete sentence, no meta',
  'one-liner take on the current convo — fresh angle, dont repeat yourself',
  'shout out a chatter by name with a real reason from their recent message',
  'ask chat a sharp question based on what someone just said',
  'short hot take on the topic chat is on right now',
  'pick a real line from recent chat and riff on it — quote or paraphrase briefly',
  'two-word reaction to the vibe in chat',
] as const

const BARE_B_TAIL = '. dont react to "!b" itself.'
const BARE_B_QUERY_BUDGET = 195 // AI_MAX_QUERY_LEN is 200 in ai.ts; stay under
const BARE_B_MSG_MAX = 60       // per-message cap inside the snippet/question
const QUESTION_RE = /\?\s*$|^(who|what|when|where|why|how|does|do|is|are|am|can|could|should|would|will|did|has|have)\b/i

function clip(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) }

// returns true if `user`'s recent !b asks show a pattern of asking the bot to
// spam this specific emote — e.g. two prior asks within the last hour where the
// bot's response was a >=3x repeat of `emote`. used to interpret a bare "!b <emote>"
// from a known spammer as implicit spam intent instead of routing to AI roulette.
function isEstablishedSpammer(user: string, emote: string): boolean {
  try {
    const asks = db.getRecentAsks(user, 8)
    if (asks.length < 2) return false
    const cutoff = Date.now() - 60 * 60_000  // 1 hour
    const escaped = emote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'gi')
    let hits = 0
    for (const a of asks) {
      const ts = new Date(a.created_at).getTime()
      if (Number.isFinite(ts) && ts < cutoff) continue
      const count = (a.response?.match(re) ?? []).length
      if (count >= 3) hits++
      if (hits >= 2) return true
    }
    return false
  } catch {
    return false
  }
}

function recentEligible(channel: string): { user: string; text: string }[] {
  try {
    const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
    return getRecent(channel, 15)
      .filter((m) =>
        m.user.toLowerCase() !== botName &&
        !/^!\w/.test(m.text.trim()) &&
        m.text.trim().length > 3,
      )
      .map((m) => ({ user: m.user, text: m.text.replace(/\s+/g, ' ').trim() }))
  } catch {
    return []
  }
}

export function findUnansweredQuestion(channel: string): { user: string; text: string } | null {
  const recent = recentEligible(channel)
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i]
    if (msg.text.length < 6) continue
    if (!QUESTION_RE.test(msg.text)) continue
    // unanswered = no substantive reply (>15 chars) by a different user after.
    // spoiler-deflections ("no spoilers", "im trying to guess") aren't answers — skip them.
    const replied = recent.slice(i + 1).some((later) =>
      later.user.toLowerCase() !== msg.user.toLowerCase() &&
      later.text.length > 15 &&
      !SPOILER_SENSITIVE_RE.test(later.text),
    )
    if (!replied) return msg
  }
  return null
}

// Spoiler-sensitive signals: chat is explicitly avoiding direct answers
// (trivia/guess bit active, or "no spoilers" / "dont tell" / "im trying to guess" phrases).
const SPOILER_SENSITIVE_RE = /\b(no spoiler|dont spoil|don'?t spoil|without spoil|spoiler[- ]?free|dont tell|don'?t tell|trying to (?:guess|figure|remember)|im guessing|let me guess|guess (?:what|who|the)|hint (?:only|please|pls)|riddle me)\b/i

function spoilerSensitive(channel: string): boolean {
  try {
    if (isGameActive(channel)) return true
  } catch {}
  const recent = recentEligible(channel)
  return recent.some((m) => SPOILER_SENSITIVE_RE.test(m.text))
}

export function buildBareBQuery(channel?: string): string {
  if (channel) {
    const q = findUnansweredQuestion(channel)
    if (q) {
      const text = clip(q.text, BARE_B_MSG_MAX)
      const guised = spoilerSensitive(channel)
      const style = guised
        ? 'give a guised hint that points toward the answer without spoiling it'
        : 'answer bluntly and accurately'
      const ask = `${style} — unanswered chat question from ${q.user}: "${text}". use bazaar game data if relevant. dont react to "!b" itself.`
      return clip(ask, BARE_B_QUERY_BUDGET)
    }
  }
  const nudge = BARE_B_NUDGES[Math.floor(Math.random() * BARE_B_NUDGES.length)]
  let body: string = nudge
  if (channel) {
    const recent = recentEligible(channel).slice(-3)
    if (recent.length > 0) {
      const snippet = recent.map((m) => `${m.user}: ${clip(m.text, BARE_B_MSG_MAX)}`).join(' / ')
      body = `${nudge}. anchor: ${snippet}`
    }
  }
  const headBudget = BARE_B_QUERY_BUDGET - BARE_B_TAIL.length
  return clip(body, headBudget) + BARE_B_TAIL
}

function withSuffix(text: string, suffix: string): string {
  const combined = text + suffix
  // measure by code points — fancy-font glyphs are surrogate pairs (2 utf-16 units
  // but 1 twitch char), so .length would over-count and truncate them at half length.
  if ([...combined].length <= MAX_LEN) return combined
  // trim text to make room for suffix
  const budget = MAX_LEN - [...suffix].length
  if (budget <= 0) return [...text].slice(0, MAX_LEN).join('')
  const cut = [...text].slice(0, budget).join('')
  const lastBreak = Math.max(cut.lastIndexOf(' | '), cut.lastIndexOf(' '))
  const trimmed = lastBreak > budget * 0.5 ? cut.slice(0, lastBreak) + '...' : [...cut].slice(0, budget - 3).join('') + '...'
  return trimmed + suffix
}

const ALIAS_ADMINS = new Set(
  (process.env.ALIAS_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
)

// ! commands blocked from proxy — scorched earth, block anything dangerous
const BLOCKED_BANG_CMDS = new Set([
  // stream settings
  'settitle', 'setgame', 'setcategory', 'title', 'game',
  // command management (streamelements/nightbot/streamlabs)
  'addcom', 'addcommand', 'editcom', 'editcommand',
  'delcom', 'deletecom', 'delcommand', 'deletecommand',
  'removecom', 'removecommand', 'disablecom', 'enablecom',
  'command', 'commands', 'cmd',
  // moderation
  'nuke', 'nukeusername', 'permit', 'vanish', 'votekick',
  'ban', 'unban', 'timeout', 'untimeout', 'mute', 'unmute',
  'purge', 'clear', 'warn', 'sacrifice',
  // self-harm / auto-timeout commands (other bots timeout the sender)
  'endme', 'kms', 'sudoku', 'seppuku', 'die', 'kill', 'killme', 'rip',
  // DMs/blocking/connection
  'whisper', 'w', 'block', 'unblock', 'disconnect',
  // announcements (mod-only)
  'announce',
  // chat mode control
  'caps', 'emoteonly', 'emoteonlyoff', 'slow', 'slowoff',
  'followers', 'followersoff', 'subscribers', 'subscribersoff',
  'uniquechat', 'r9kbeta', 'r9kbetaoff',
  // bot control
  'bot', 'module', 'disable', 'enable', 'emotes',
  // stream control
  'host', 'unhost', 'raid', 'marker', 'commercial',
  // points/store abuse
  'addpoints', 'setpoints', 'givepoints', 'removepoints',
  'openstore', 'closestore',
  // alerts/sfx
  'alerts', 'enablesfx', 'disablesfx', 'filesay',
  // song/media control
  'skip', 'pause', 'volume', 'removesong', 'srclear', 'play',
  // timers
  'timer',
  // counters
  'editcounter', 'resetwins', 'resetcount', 'resetkills', 'resetgulag',
  // giveaways/contests
  'cancelraffle', 'sraffle', 'giveaway', 'bet',
  // level/permissions
  'level',
  // code execution (custom bots)
  'eval', 'script', 'bash', 'sh', 'exec',
  // bot lifecycle
  'exit', 'restart', 'reload', 'shutdown',
  // info disclosure
  'logs', 'bans',
  // spam risk
  'so', 'shoutout',
  // message deletion
  'delete',
  // short aliases used by some bots for timeout/raid-on (to) and raid-off (ro)
  'to', 'ro',
])

// morphological guard: block command-name variants that enumerate around the denylist
// (e.g. !banuser, !timeoutuser, !purgeuser, !ban_victim, !kickme)
// flags: ban/timeout/purge/kick/mute/nuke/warn/vanish in any position with common suffixes
const MOD_ALIAS_RE = /(?:^|_)(ban|timeout|purge|kick|mute|nuke|warn|vanish)(?:$|user|chat|s|_|me)/i

// / commands: allowlist only — everything else blocked
const ALLOWED_SLASH_CMDS = new Set([
  'me', 'announce', 'color',
])

// --- proxy cooldown: per-channel per-command ---
const PROXY_COOLDOWN = 30_000
const PROXY_COOLDOWN_SHORT = 5_000
// harmless fun commands get shorter cooldown
const SHORT_CD_CMDS = new Set(['love', 'hate', 'hug', 'kiss', 'slap', 'highfive', 'duel', 'cookie', 'pet'])
const proxyCooldowns = new Map<string, number>()

// commands other bots use to time out the sender — bot is vip not mod, so silent block is safe but boring
// CRITICAL: dodge text must never contain a literal !cmd token (would just trigger the other bot)
const SELF_TIMEOUT_DODGES: Record<string, readonly string[]> = {
  endme: [
    'no thx, vibes immaculate',
    'counterproposal: you go first',
    'have you tried snacks instead',
    'will to live is at peak performance',
    'endmne? hardly know mne',
    'my therapist says no',
    'nice try, i\'m unkillable',
  ],
  sacrifice: [
    'altar closed for renovations',
    'pick someone with more hp',
    'vip benefits do not include sacrificial duties',
    'nice try cultist',
    '!sacarafice',
    'i\'m worth more alive, ask my agent',
  ],
  kms: ['absolutely not', 'thriving actually', '!kmd'],
  sudoku: ['the puzzle remains unsolved', 'i prefer wordle'],
  seppuku: ['honor intact, thanks', 'sword left at home'],
  die: ['hard pass', 'dye? the hair? sure'],
  kill: ['unionized, can\'t legally accept', '!kil lol'],
  killme: ['try kissing me instead', 'killmne? hardly etc'],
  rip: ['still respawning, give it a sec', '!rop'],
}

function selfTimeoutDodge(channel: string | undefined, cmd: string): string | null {
  const list = SELF_TIMEOUT_DODGES[cmd]
  if (!list) return null
  if (channel) {
    const key = `${channel}:dodge:${cmd}`
    const now = Date.now()
    const last = proxyCooldowns.get(key)
    if (last && now - last < PROXY_COOLDOWN) return null
    proxyCooldowns.set(key, now)
  }
  return list[Math.floor(Math.random() * list.length)]
}

function proxyWithCooldown(channel: string | undefined, cmdStr: string, cmd: string): string {
  if (!channel) return cmdStr
  const key = `${channel}:${cmd.toLowerCase()}`
  const cd = SHORT_CD_CMDS.has(cmd.toLowerCase()) ? PROXY_COOLDOWN_SHORT : PROXY_COOLDOWN
  const now = Date.now()
  const last = proxyCooldowns.get(key)
  if (last && now - last < cd) {
    const left = Math.ceil((cd - (now - last)) / 1000)
    return `!${cmd} is on cooldown (${left}s)`
  }
  proxyCooldowns.set(key, now)
  if (proxyCooldowns.size > 200) {
    for (const [k, t] of proxyCooldowns) {
      if (now - t > PROXY_COOLDOWN) proxyCooldowns.delete(k)
    }
  }
  return cmdStr
}

export interface CommandContext {
  user?: string
  channel?: string
  privileged?: boolean
  isMod?: boolean
  messageId?: string
  threadId?: string
}

type CommandHandler = (args: string, ctx: CommandContext) => string | null | Promise<string | null>

const TIERS = ['bronze', 'silver', 'gold', 'diamond', 'legendary']

function capitalize(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1)
}

interface ParsedArgs {
  item: string
  tier?: TierName
  enchant?: string
}

export function parseArgs(words: string[]): ParsedArgs {
  const enchList = store.getEnchantments()
  const remaining = [...words]
  let tier: TierName | undefined
  let enchant: string | undefined

  // whole-phrase guard: if the ENTIRE phrase is a literal card title, never splice a
  // tier/enchant token out of it. "diamond heart" is the skill Diamond Heart — not a
  // Diamond-tier "heart" (which fuzzy-resolves to Dragon Heart: a silent wrong answer).
  // singular-tolerant so "diamond hearts" resolves too. genuine tier queries
  // ("diamond subscraper") aren't exact card titles, so they still strip normally.
  const phrase = remaining.join(' ')
  if (store.exact(phrase) || store.exact(phrase.replace(/s$/, ''))) return { item: phrase }

  // extract tier from any position (exact match wins over enchant prefix)
  const tierIdx = remaining.findIndex((w) => TIERS.includes(w.toLowerCase()))
  if (tierIdx !== -1) {
    tier = capitalize(remaining[tierIdx].toLowerCase()) as TierName
    remaining.splice(tierIdx, 1)
  }

  // extract enchantment from any position if other words remain for item
  // require exact match or prefix within 2 chars of full name to avoid "shield"→"shielded".
  // but NOT if the whole phrase is itself a real item ("heavy crossbow" = the item Heavy
  // Crossbow, not Heavy-enchanted crossbow) — ~12 items start with an enchant word.
  if (remaining.length > 1 && remaining.length <= 8 && !store.exact(remaining.join(' ')) && !store.exact(remaining.join(' ').replace(/s$/, ''))) {
    for (let i = 0; i < remaining.length; i++) {
      const lower = remaining[i].toLowerCase()
      const matches = enchList.filter((e) => e.startsWith(lower))
      if (matches.length === 1 && (lower === matches[0] || (lower.length >= 3 && lower.length >= matches[0].length * 0.8))) {
        enchant = capitalize(matches[0])
        remaining.splice(i, 1)
        break
      }
    }
  }

  return { item: remaining.join(' '), tier, enchant }
}

const OWNER = (process.env.BOT_OWNER ?? '').toLowerCase()
const BOT_ADMINS = new Set(
  (process.env.BOT_ADMINS ?? '').split(',').concat(OWNER).map((s) => s.trim().toLowerCase()).filter(Boolean),
)
function isAdmin(user?: string): boolean {
  return !!user && BOT_ADMINS.has(user.toLowerCase())
}

let onRefresh: (() => Promise<string>) | null = null
export function setRefreshHandler(handler: () => Promise<string>) { onRefresh = handler }

let onEmoteRefresh: (() => Promise<string>) | null = null
export function setEmoteRefreshHandler(handler: () => Promise<string>) { onEmoteRefresh = handler }

let onJoinChannel: ((target: string, requester: string) => Promise<string>) | null = null
export function setJoinHandler(handler: (target: string, requester: string) => Promise<string>) { onJoinChannel = handler }

let onPartChannel: ((target: string, requester: string) => Promise<string>) | null = null
export function setPartHandler(handler: (target: string, requester: string) => Promise<string>) { onPartChannel = handler }

let onStatus: (() => string) | null = null
export function setStatusHandler(handler: () => string) { onStatus = handler }

export { BOT_ADMINS }

// --- query dedup: suppress identical lookups within 30s per channel ---
const DEDUP_WINDOW = 30_000
const recentQueries = new Map<string, number>()

function isDuplicate(channel: string, query: string): boolean {
  const key = `${channel}:${query.toLowerCase()}`
  const now = Date.now()
  const last = recentQueries.get(key)
  if (last && now - last < DEDUP_WINDOW) return true
  recentQueries.set(key, now)
  // prune old entries periodically (aggressive threshold to prevent unbounded growth)
  if (recentQueries.size > 200) {
    for (const [k, t] of recentQueries) {
      if (now - t > DEDUP_WINDOW) recentQueries.delete(k)
    }
  }
  return false
}

function logMiss(query: string, ctx: CommandContext) {
  try { db.logCommand(ctx, 'miss', query) } catch {}
}

function logHit(type: CmdType, query: string, match: string, ctx: CommandContext, tier?: string) {
  try { db.logCommand(ctx, type, query, match, tier) } catch {}
}

function resolveSkills(monster: Monster): Map<string, SkillDetail> {
  const details = new Map<string, SkillDetail>()
  if (!monster.MonsterMetadata?.skills) return details
  for (const s of monster.MonsterMetadata.skills) {
    if (details.has(s.title)) continue
    const card = store.findCard(s.title)
    if (!card || !card.Tooltips.length) continue
    const tooltip = card.Tooltips.map((t) =>
      compressTooltip(resolveTooltip(t.text, card.TooltipReplacements, s.tier as TierName)),
    ).join('; ')
    details.set(s.title, { name: s.title, tooltip })
  }
  return details
}

type SubHandler = (query: string, ctx: CommandContext, suffix: string) => string | null | Promise<string | null>

const RESERVED_SUBS = new Set([
  'mob', 'monster', 'hero', 'tag', 'skill', 'day', 'enchants', 'enchantments',
  'trivia', 'skip', 'score', 'stats', 'top', 'alias', 'help', 'info',
  'refresh', 'update', 'emotes', 'status', 'join', 'part',
  'leave', 'pick', 'vote', 'party', 'shop', 'history', 'resolve', 'game',
])

const subcommands: [RegExp, SubHandler][] = [
  [/^alias$/i, (_q, ctx) => {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    return 'usage: !b alias <slang> = <item> | !b alias del <slang> | !b alias list'
  }],
  [/^alias\s+list$/i, (_q, ctx) => {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    const aliases = store.getDynamicAliases()
    if (aliases.size === 0) return 'no dynamic aliases set'
    const entries = [...aliases.entries()].map(([k, v]) => `${k}→${v}`)
    return truncate(`aliases: ${entries.join(', ')}`)
  }],
  [/^alias\s+del\s+(.+)$/i, (query, ctx) => {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    const removed = store.removeDynamicAlias(query)
    if (removed) invalidateAliasCache()
    return removed ? `removed alias "${query}"` : `no alias found for "${query}"`
  }],
  [/^(?:refresh|update)$/i, async (_q, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onRefresh) return 'refresh not available'
    return onRefresh()
  }],
  [/^emotes?\s+refresh$/i, async (_q, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onEmoteRefresh) return 'emote refresh not available'
    return onEmoteRefresh()
  }],
  [/^status$/i, (_q, ctx) => {
    if (!isAdmin(ctx.user)) return null
    return onStatus?.() ?? 'status not available'
  }],
  [/^join\s+#(\S+)$/i, async (query, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onJoinChannel) return 'join not available'
    return onJoinChannel(query.toLowerCase(), ctx.user ?? '')
  }],
  [/^part\s+#?(\S+)$/i, async (query, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onPartChannel) return 'part not available'
    return onPartChannel(query.toLowerCase(), ctx.user ?? '')
  }],
  [/^(?:mob|monster)$/i, () => 'usage: !b mob <name>'],
  [/^hero$/i, () => 'usage: !b hero <name>'],
  [/^tag$/i, () => 'usage: !b tag <tagname>'],
  [/^skill$/i, () => 'usage: !b skill <name>'],
  [/^day$/i, () => 'usage: !b day <number>'],
  [/^(?:mob|monster)\s+(.+)$/i, async (query, ctx, suffix) => {
    const monster = store.findMonster(query)
    if (!monster) {
      logMiss(query, ctx)
      const suggestions = store.suggest(query, 3)
      if (suggestions.length) return withSuffix(`no monster found for ${query} — did you mean: ${suggestions.join(', ')}?`, suffix)
      return aiOrQuip(`mob ${query}`, ctx, suffix)
    }
    logHit('mob', query, monster.Title, ctx)
    return withSuffix(formatMonster(monster, resolveSkills(monster)), suffix)
  }],
  [/^hero\s+(.+)$/i, async (query, ctx, suffix) => {
    const resolved = store.findHeroName(query)
    const items = store.byHero(query)
    if (items.length === 0) {
      logMiss(query, ctx)
      return aiOrQuip(`hero ${query}`, ctx, suffix)
    }
    logHit('hero', query, `${items.length} items`, ctx)
    return heroPoolReply(resolved ?? query, items, suffix)
  }],
  [/^enchant(?:s|ments)?$/i, (_query, ctx, suffix) => {
    const names = store.getEnchantments().map(capitalize)
    logHit('enchants', _query, `${names.length} enchants`, ctx)
    return withSuffix(truncate(`Enchantments: ${names.join(', ')}`), suffix)
  }],
  [/^tag\s+(.+)$/i, async (query, ctx, suffix) => {
    const resolved = store.findTagName(query)
    const cards = store.byTag(query)
    if (cards.length === 0) {
      logMiss(query, ctx)
      const suggestions = store.suggest(query, 3)
      if (suggestions.length) return withSuffix(`no items found with tag ${query} — did you mean: ${suggestions.join(', ')}?`, suffix)
      return aiOrQuip(`tag ${query}`, ctx, suffix)
    }
    const displayTag = resolved ?? query
    logHit('tag', query, `${cards.length} items`, ctx)
    return withSuffix(formatTagResults(displayTag, cards), suffix)
  }],
  [/^day\s+(\d+)$/i, async (query, ctx, suffix) => {
    const day = parseInt(query)
    if (day < 1 || day > 99) return `invalid day number (1-99)`
    const mobs = store.monstersByDay(day)
    if (mobs.length === 0) { logMiss(query, ctx); return aiOrQuip(`day ${day}`, ctx, suffix) }
    logHit('day', query, `${mobs.length} monsters`, ctx)
    return withSuffix(formatDayResults(day, mobs), suffix)
  }],
  [/^skill\s+(.+)$/i, async (query, ctx, suffix) => {
    const skill = store.findSkill(query)
    if (!skill) { logMiss(query, ctx); return aiOrQuip(`skill ${query}`, ctx, suffix) }
    logHit('skill', query, skill.Title, ctx)
    return withSuffix(formatItem(skill), suffix)
  }],
  [/^trivia(?:\s+([\s\S]+))?$/i, (query, ctx, suffix) => runTrivia(ctx, query ?? '', suffix)],
  // natural-language trivia start: "make a trivia about happy gilmore", "do a quiz on
  // cats", "can you start a trivia". the verb + "trivia"/"quiz" makes intent explicit, so
  // route it to the trivia game instead of letting it fall to AI chat. the topic (incl. a
  // leading "about"/"on") is handed to runTrivia, which resolves category vs custom topic.
  [/^(?:pls\s+|please\s+)?(?:can\s+(?:you|u|we)\s+)?(?:make|do|start|begin|create|run|generate|gen|give|gimme|set\s*up|lets?\s+do|let'?s\s+do|wanna|i\s+wanna|i\s+want(?:\s+to)?)\s+(?:me\s+)?(?:a|an|some|the|new)?\s*(?:new\s+)?(?:trivia|quiz)(?:\s+(?:question|round|game|q))?(?:\s+(?:about|on|for|regarding|over|covering))?\s*([\s\S]*)$/i,
    (query, ctx, suffix) => runTrivia(ctx, stripTopicConnector(query ?? ''), suffix)],
  // "quiz" as a full alias for "trivia" (quiz / quiz me / quiz about cats)
  [/^quiz(?:\s+me)?(?:\s+([\s\S]+))?$/i, (query, ctx, suffix) => runTrivia(ctx, stripTopicConnector(query ?? ''), suffix)],
  [/^(?:vibes?|directives?)(?:\s+([\s\S]+))?$/i, (query, ctx, suffix) => handleVibes(query ?? '', ctx, suffix)],
  [/^skip$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    const msg = skipTrivia(ctx.channel, ctx.user)
    return msg ? withSuffix(msg, suffix) : null
  }],
  [/^score$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return withSuffix(getTriviaScore(ctx.channel), suffix)
  }],
  // --- the depths (offline shared-hero dungeon) ---
  // descend / attack / defend / special / flee / 1 / 2 all flow through the bare-keyword
  // vote hook in index.ts (NOT !b routes). only the on-demand status + a mod reset are commands.
  [/^depths\s+reset$/i, (_q, ctx) => (ctx.channel && ctx.isMod) ? dungeon.resetRun(ctx.channel) : null],
  [/^depths$/i, (_q, ctx) => (ctx.channel ? dungeon.statusLine(ctx.channel) : null)],
  // --- raid game commands (silent) ---
  [/^join(?:\s+(.+))?$/i, (_q, ctx) => raidCmds.handleJoin('', ctx)],
  [/^leave$/i, (_q, ctx) => raidCmds.handleLeave('', ctx)],
  [/^pick\s+(.+)$/i, (query, ctx) => raidCmds.handlePick(query, ctx)],
  [/^vote\s+(.+)$/i, (query, ctx) => raidCmds.handleVote(query, ctx)],
  [/^party$/i, (_q, ctx) => raidCmds.handleParty('', ctx)],
  [/^shop$/i, (_q, ctx) => raidCmds.handleParty('', ctx)],
  [/^history$/i, (_q, ctx) => raidCmds.handleHistory('', ctx)],
  [/^resolve$/i, (_q, ctx) => raidCmds.handleResolve('', ctx)],
  [/^game\s+pace\s+(fast|normal|slow)$/i, (query, ctx) => raidCmds.handleGamePace(query, ctx)],
  [/^game\s+(on|off)$/i, (query, ctx) => raidCmds.handleGameToggle(query, ctx)],
  [/^stats(?:\s+@?(\S+))?$/i, (query, ctx, suffix) => {
    const target = query || ctx.user
    if (!target) return null
    return withSuffix(formatStats(target, ctx.channel), suffix)
  }],
  [/^top$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return withSuffix(formatTop(ctx.channel), suffix)
  }],
]

function validateTier(card: { Tiers: TierName[] }, tier?: TierName): { tier: TierName | undefined; note: string | null } {
  if (!tier) return { tier: undefined, note: null }
  if (card.Tiers.includes(tier)) return { tier, note: null }
  // find highest available tier
  const available = TIER_ORDER.filter((t) => card.Tiers.includes(t))
  const highest = available[available.length - 1]
  if (highest) return { tier: highest, note: `max tier is ${highest}` }
  return { tier: undefined, note: null }
}

// "who won the trivia?", "did tidolar win the quiz?", "trivia leaderboard" — interrogative
// questions about trivia RESULTS, answered from the DB (never the AI, which invents winners).
// scoped so a topic request like "trivia about winning" is NOT matched (no who/did, and
// "trivia about" != "trivia leaderboard").
// present-tense win|winning intentionally omitted — "who's winning" means current standings
// (handled by BARE_STANDINGS_RE), not who won the last round.
const TRIVIA_RESULT_RE = /\bwho\b[^?]*\b(won|winner)\b[^?]*\b(trivia|quiz|round|last\s*one)\b|\b(trivia|quiz)\s+(leaderboard|standings|scores?|rankings?|top)\b|\bdid\b[^?]*\bwin\b[^?]*\b(trivia|quiz|round)\b/i
// of a matched result-question, which ones want the standings table vs the last winner.
const TRIVIA_STANDINGS_RE = /\b(leaderboard|standings|scores?|rankings?|top)\b/i
// a whole-query standings ask, answered from the exact trivia table (free, no AI). anchored
// so only a bare command matches — a conversational mention falls through to the AI, which
// is itself grounded with the standings data (ai-build STANDINGS_RE) so it answers too.
const BARE_STANDINGS_RE = /^(?:the\s+|trivia\s+|quiz\s+|show\s+(?:me\s+)?(?:the\s+)?)?(?:leaderboard|leaderboards|standings|scoreboard|rankings?)\??$|^who(?:'?s|\s+is|\s+are)?\s+(?:winning|leading|in\s+(?:the\s+)?lead|on\s+top|first|ahead)(?:\s+(?:the\s+|in\s+|at\s+)?(?:trivia|quiz))?\??$|^who(?:\s+has|\s+got|'s\s+got)\s+(?:the\s+)?(?:most|highest|best|top)\s+(?:wins?|points?|scores?)\??$|^(?:points?|scores?|wins?)\s+leader(?:board)?\??$|^lead(?:er|ing)\s+in\s+(?:points?|wins?|scores?)\??$|^how\s+many\s+(?:trivia\s+|my\s+)?(?:wins?|points?|scores?)\s+(?:(?:do|have|got)\s+)?i\b.*$|^(?:do\s+i\s+have\s+)?(?:more|fewer|higher|better)\s+(?:trivia\s+)?(?:wins?|points?|scores?)\s+than\s+@\w+\??$/i

// minimal levenshtein for single-token typo matching (standings keyword proximity check)
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const la = a.length, lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  const row = Array.from({ length: lb + 1 }, (_, i) => i)
  for (let i = 1; i <= la; i++) {
    let prev = i
    for (let j = 1; j <= lb; j++) {
      const cur = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], row[j], prev) + 1
      row[j - 1] = prev
      prev = cur
    }
    row[lb] = prev
  }
  return row[lb]
}

const STANDINGS_WORDS = ['leaderboard', 'leaderboards', 'standings', 'scoreboard', 'rankings']
// returns true if q is a single-token typo (edit dist <=1) of a standings keyword
function isStandingsTypo(q: string): boolean {
  if (q.includes(' ')) return false
  const clean = q.toLowerCase().replace(/\?+$/, '')
  return STANDINGS_WORDS.some((k) => levenshtein(clean, k) <= 1)
}

// strip conversational prefixes so "what is birdge" → "birdge"
// "how about" / "what about" excluded — they're continuations, not direct lookups
const QUESTION_PREFIX = /^(?:what(?:'?s | is | are )|tell me about |show me |look up |find me |can you (?:find |look up |show ))/i

function stripQuestionPrefix(s: string): string {
  const stripped = s.replace(QUESTION_PREFIX, '')
  // only strip if something meaningful remains
  return stripped.length >= 2 ? stripped : s
}

// shared hero-pool reply ("[Vanessa] item, item, …") used by the `hero <name>` subcommand
// and by itemLookup's bare-hero routing.
function heroPoolReply(heroName: string, items: BazaarCard[], suffix: string): string {
  return withSuffix(truncate(`[${heroName}] ${items.map((i) => i.Title).join(', ')}`), suffix)
}

async function itemLookup(cleanArgs: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  const stripped = stripQuestionPrefix(cleanArgs)
  const words = stripped.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return null

  if (enchant) {
    // prefer cards that actually have the requested enchant — disambiguates
    // skill/item collisions like "depth charge" (skill) vs "Elemental Depth Charge" (item)
    const exact = store.exact(query)
    const candidates = exact ? [exact, ...store.search(query, 5)] : store.search(query, 5)
    const card = candidates.find((c) => c.Enchantments[enchant]) ?? candidates[0]
    if (!card) {
      logMiss(query, ctx)
      const s = store.suggest(query, 3)
      return s.length
        ? withSuffix(`no item found for ${query} — did you mean: ${s.join(', ')}?`, suffix)
        : aiOrQuip(`${query} ${enchant}`, ctx, suffix)
    }
    const ev = validateTier(card, tier)
    logHit('enchant', query, `${card.Title}+${enchant}`, ctx, ev.tier)
    const enchantResult = formatEnchantment(card, enchant, ev.tier)
    return withSuffix(ev.note ? `${enchantResult} (${ev.note})` : enchantResult, suffix)
  }

  // items first (exact then fuzzy) — !b mob exists for explicit monster lookups
  const exactCard = store.exact(query)
  const card = exactCard ?? store.search(query, 1)[0]

  // a bare hero name beats a mere fuzzy item match: "dooley"/"vanessa"/"pyg" mean the hero's
  // whole pool, not a card that just shares the stem ("Dooley's Scarf"). only when there's no
  // EXACT item and the query exactly IS a hero name/alias, so item queries aren't hijacked.
  if (!exactCard) {
    const hero = store.findExactHero(query)
    if (hero) {
      const heroItems = store.byHero(hero)
      if (heroItems.length > 0) {
        logHit('hero', query, `${heroItems.length} items`, ctx)
        return heroPoolReply(hero, heroItems, suffix)
      }
    }
  }

  // reject fuzzy matches where the query doesn't meaningfully overlap with the title
  const queryWords = query.toLowerCase().split(/\s+/)
  const isRelevantMatch = (title: string, isExact: boolean) => {
    if (isExact) return true
    // split CamelCase/PascalCase into words (LavaRoller → lava, roller)
    const titleWords = title.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s\-]+/)
    // single-word query: must appear as substring in title (enrage ≠ Leverage Momentum)
    if (queryWords.length === 1) return titleWords.some((tw) => tw.includes(queryWords[0]) || queryWords[0].includes(tw))
    // multi-word: exact word overlap OR substring containment (pinkbirdge contains birdge)
    return titleWords.some((tw) => tw.length >= 3 && (queryWords.includes(tw) || queryWords.some((qw) => qw.length >= 3 && (qw.includes(tw) || tw.includes(qw)))))
  }

  if (card && isRelevantMatch(card.Title, !!exactCard)) {
    const v = validateTier(card, tier)
    logHit('item', query, card.Title, ctx, v.tier)
    const result = formatItem(card, v.tier)
    return withSuffix(v.note ? `${result} (${v.note})` : result, suffix)
  }

  const monster = store.findMonster(query)
  if (monster && isRelevantMatch(monster.Title, false)) {
    logHit('mob', query, monster.Title, ctx)
    return withSuffix(formatMonster(monster, resolveSkills(monster)), suffix)
  }

  // item + monster both missed — a loose hero-name match (typo/prefix/alias) still answers
  // with that hero's pool rather than deflecting to "no item found".
  const looseHero = store.findHeroName(query)
  if (looseHero) {
    const heroItems = store.byHero(query)
    if (heroItems.length > 0) {
      logHit('hero', query, `${heroItems.length} items`, ctx)
      return heroPoolReply(looseHero, heroItems, suffix)
    }
  }

  logMiss(query, ctx)

  if (queryWords.length <= 2) {
    const suggestions = store.suggest(query, 3)
    if (suggestions.length > 0) {
      return withSuffix(`no item found for ${query} — did you mean: ${suggestions.join(', ')}?`, suffix)
    }
  }
  // no item match — fall through to AI fallback in bazaarinfo()
  return null
}

async function bazaarinfo(args: string, ctx: CommandContext): Promise<string | null> {
  // (mute is enforced centrally in handleCommand, covering every command path)
  // extract @mentions to tag at end of response
  const mentions = args.match(/@\w+/g) ?? []
  // keep usernames in AI query (strip @ only), strip fully for item lookup
  const aiQuery = args.replace(/@(\w+)/g, '$1').replace(/"/g, '').replace(/\s+/g, ' ').trim()
  const cleanArgs = args.replace(/@\w+/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim()

  // bare !b in a thread reply → read the full thread and try to help
  if (!cleanArgs && ctx.threadId && ctx.channel) {
    const thread = getThread(ctx.channel, ctx.threadId)
    const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
    const threadMsgs = thread
      .filter((m) => m.user.toLowerCase() !== botName)
      .map((m) => m.text.replace(/^!\w+\s*/, '').trim())
      .filter(Boolean)
    if (threadMsgs.length > 0) {
      // try item lookup on the first non-command message (the original question)
      const rootText = threadMsgs[0].replace(/@\w+/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim()
      const suffix = mentions.length ? ` ${mentions.join(' ')}` : ''
      if (rootText) {
        const lookupResult = await itemLookup(rootText, ctx, suffix)
        if (lookupResult !== null) return lookupResult
      }
      // no item match → AI with full thread as context
      const threadContext = threadMsgs.map((m, i) => i === 0 ? m : `followup: ${m}`).join('\n')
      return tryAiRespond(threadContext, ctx)
    }
  }

  // bare !b → riff on recent chat; help/info → describe capabilities (no hardcoded usage line)
  if (!cleanArgs) return tryAiRespond(buildBareBQuery(ctx.channel), ctx, mentions)
  if (cleanArgs === 'help' || cleanArgs === 'info') return tryAiRespond('what does this bot do', ctx, mentions)

  if (/^(how (do you|does this( bot)?) work|what are you|what is this)\b/i.test(cleanArgs)) {
    return 'twitch chatbot for The Bazaar by mellen. looks up items/heroes/monsters from bazaardb.gg, runs trivia, and answers questions. try: !b <item> | !b hero <name> | !b <question>'
  }

  // trivia-result questions ("who won the trivia?", "trivia leaderboard") answered from
  // REAL data — never routed to the AI, which would invent a winner. tightly scoped to
  // interrogative result-phrasing so a topic request ("trivia about winning") still starts
  // a round instead of being hijacked.
  if (ctx.channel && TRIVIA_RESULT_RE.test(cleanArgs)) {
    const sfx = mentions.length ? ` ${mentions.join(' ')}` : ''
    if (TRIVIA_STANDINGS_RE.test(cleanArgs)) {
      return withSuffix(getTriviaScore(ctx.channel), sfx)
    }
    if (isGameActive(ctx.channel)) return withSuffix(`a round's live right now — get your answer in!`, sfx)
    const last = db.getLastTriviaResult(ctx.channel)
    if (!last) return withSuffix(`no trivia has run here yet — start one with !b trivia`, sfx)
    if (last.winner) return withSuffix(`@${last.winner} won the last round (answer: ${last.answer})`, sfx)
    return withSuffix(`nobody got the last round — the answer was ${last.answer}`, sfx)
  }

  // a BARE standings ask ("leaderboard", "who's winning", "trivia rankings") → the exact
  // trivia top-5 table, free + no hallucination risk. anchored to the whole query so a
  // conversational mention ("i am talking about the leaderboard") falls through to the AI,
  // which is grounded with the same standings data in ai-build (so it never deflects either).
  if (ctx.channel && (BARE_STANDINGS_RE.test(cleanArgs) || (!store.exact(cleanArgs) && isStandingsTypo(cleanArgs)))) {
    const sfx = mentions.length ? ` ${mentions.join(' ')}` : ''
    if (isGameActive(ctx.channel)) return withSuffix(`a round's live right now — get your answer in!`, sfx)
    return withSuffix(getTriviaScore(ctx.channel), sfx)
  }

  // proxy ! and / commands — before dedup so cooldown messages always show
  const bangMatch = cleanArgs.match(/^!(\w+)(.*)$/)
  if (bangMatch) {
    const cmd = bangMatch[1].toLowerCase()
    if (BLOCKED_BANG_CMDS.has(cmd) || MOD_ALIAS_RE.test(cmd)) {
      return selfTimeoutDodge(ctx.channel, cmd)
    }
    return proxyWithCooldown(ctx.channel, cleanArgs, cmd)
  }
  const slashMatch = cleanArgs.match(/^\/(\w+)(.*)$/)
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase()
    if (!ALLOWED_SLASH_CMDS.has(cmd)) return null
    if ((cmd === 'announce' || cmd === 'me' || cmd === 'color') && !ctx.isMod) return null
    return cleanArgs
  }
  // embedded command: "so can u run !jory pls" → "!jory"
  // skip if asking about a command ("who has the most !a"), not requesting one
  // questions about commands mention them as nouns; requests use action verbs near them
  const isAskingAbout = /^(who|what|when|where|why|how|does|has|have|is|should|can|will|could|would|may|might|don'?t|never|please)\b/i.test(cleanArgs)
  // content-gen request — !cmd is a topic, not a request to proxy ("write a pasta about !afk")
  const isContentGen = /\b(copypasta|pasta|joke|story|poem|rant|monologue|lore|sonnet|haiku|fanfic|saga|ballad|essay|tweet|limerick|rap|song|roast|narrative|bit)\b/i.test(cleanArgs)
  if (!isAskingAbout && !isContentGen) {
    const embeddedMatch = cleanArgs.match(/!(\w+)(?:\s+(\d+))?/)
    if (embeddedMatch) {
      const cmd = embeddedMatch[1].toLowerCase()
      if (!BLOCKED_BANG_CMDS.has(cmd) && !MOD_ALIAS_RE.test(cmd)) {
        const cmdStr = embeddedMatch[2] ? `!${embeddedMatch[1]} ${embeddedMatch[2]}` : `!${embeddedMatch[1]}`
        return proxyWithCooldown(ctx.channel, cmdStr, cmd)
      }
      const dodge = selfTimeoutDodge(ctx.channel, cmd)
      if (dodge) return dodge
    }
  }

  // suppress duplicate lookups within 30s per channel (same user only)
  if (ctx.channel && ctx.user && isDuplicate(ctx.channel, `${ctx.user}:${cleanArgs}`)) return null

  const suffix = mentions.length ? ` ${mentions.join(' ')}` : ''

  // alias add: !b alias <slang> = <target>
  const aliasAdd = cleanArgs.match(/^alias\s+(.+?)\s*=\s*(.+)$/i)
  if (aliasAdd) {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    const aliasKey = aliasAdd[1].trim().toLowerCase()
    if (/\s/.test(aliasKey)) return 'alias name cannot contain spaces'
    const targetQuery = aliasAdd[2].trim()
    if (RESERVED_SUBS.has(aliasKey)) return `"${aliasKey}" is a reserved command name`
    const match = store.exact(targetQuery) ?? store.search(targetQuery, 1)[0]
    if (!match) return `no item found for ${targetQuery}`
    store.addDynamicAlias(aliasKey, match.Title, ctx.user)
    invalidateAliasCache()
    return `alias set: ${aliasKey} → ${match.Title}`
  }

  for (const [pattern, handler] of subcommands) {
    const match = cleanArgs.match(pattern)
    if (match) return await handler(match[1]?.trim() ?? cleanArgs, ctx, suffix)
  }

  // spam wall interception — handle without AI. cap at 5 TOTAL tokens.
  // only known emotes count as payload; conversational filler ("pls Mr. Clanker") is dropped.
  // if no real emotes survive the filter, fall through to AI.
  const spamMatch = cleanArgs.match(/^spam\s+(?:this\s+)?(.+)/i)
  if (spamMatch) {
    const tokens = spamMatch[1].trim().split(/\s+/).filter(Boolean)
    const emotes = [...new Set(tokens.map((t) => findEmote(t)).filter((e): e is string => !!e))]
    if (emotes.length > 0 && emotes.length <= 5 && emotes.every((t) => t.length <= 30)) {
      const out: string[] = []
      while (out.length < 5) out.push(emotes[out.length % emotes.length])
      return withSuffix(out.join(' '), suffix)
    }
  }

  // bare emote = spam intent. chat-norm for "!b <emote>" is participation,
  // not "what does this emote mean" — let the AI handle the question form
  // (e.g. "what is X?"), but a single emote name always = 5x spam.
  const bareEmote = findEmote(cleanArgs.trim())
  if (bareEmote) {
    return withSuffix(Array(5).fill(bareEmote).join(' '), suffix)
  }

  // plant intent: "anytime someone asks about X, do Y" → store a steering directive
  // instead of answering. AI-gated (rejects mean/targeting/unsafe + false positives);
  // on reject it returns null and we fall through to a normal answer.
  if (ctx.channel && DIRECTIVE_INTENT.test(cleanArgs)) {
    const planted = await handlePlantDirective(cleanArgs, ctx, suffix)
    if (planted) return planted
  }

  // keyword/mechanic definition — deterministic, BEFORE item lookup + AI so
  // "what is flying" returns the verified rule, not the fuzzy item "Flying Pig".
  // a bare keyword that is also an exact item name lets the item win.
  {
    const gloss = glossaryAnswer(cleanArgs)
    if (gloss && !(isBareKeyword(cleanArgs) && store.exact(cleanArgs.trim()))) {
      try { db.logCommand(ctx, 'glossary', cleanArgs, 'keyword') } catch {}
      return withSuffix(gloss, suffix)
    }
  }

  // detect conversational/creative queries that should skip item lookup entirely
  const isGreeting = /^(h(ello|i|ey|owdy)|yo|sup|hey+|what'?s? ?up|greetings|hola|whats good|good (morning|evening|night)|gm|gn|gg|ty|thanks|thank you|lol|lmao|wow|nice|cool|pog|based|true|real|facts|nah|bruh|bro|dude|man|omg|rip|oof|haha|o7|bye|cya|later|peace|gl|hf|glhf|ggs)\b/i.test(cleanArgs)
  const isContinuation = /^(how about|what about|and |or |but )\b/i.test(cleanArgs)
  // deictic/context questions — "what is that", "what do you mean", "wdym" — point
  // at recent chat, not an item. route to AI (it gets the Recent-chat block) so the
  // referent is read from the line above, not fuzzy-matched ("that" → "Stop That!").
  const isDeictic = /^(?:wdym|wym|huh|(?:what|who|why)(?:'?s| is| was| are| do(?:es)?| did)?\s+(?:you|they|he|she|it|that|this|dat|those|these|them|i)\b)/i.test(cleanArgs)
  const isConversational = isGreeting
    || isContinuation
    || isDeictic
    || cleanArgs.split(/\s+/).length > 4
    || /\b(continue|extend|expand|write|make|create|do|say|tell|give|sing|rap|roast|rate|rank|compare|explain|describe|imagine|pretend|spam|repeat|copypasta|pasta)\b/i.test(cleanArgs)

  // conversational queries go straight to AI — no item lookup, no fallback cooldown
  if (isConversational) {
    const response = await tryAiRespond(aiQuery, ctx, mentions)
    if (response) {
      try { db.logCommand(ctx, 'ai', cleanArgs, 'fallback') } catch {}
      return response
    }
    // a deliberate low-value reaction (gg/lol/pog, punctuation, 1-2 chars) is a DECLINE,
    // not a transient failure — stay silent rather than lie with a "glitched, run it back"
    // line that invites a doomed retry. aiBusyLine is strictly for real-query transient misses.
    if (isLowValue(cleanArgs)) return null
    // never go silent on a real creative/conversational ask — a transient AI miss
    // (timeout, retry-exhaustion) still gets an answer. every real !b is answered.
    return withSuffix(aiBusyLine(), suffix)
  }

  const lookupResult = await itemLookup(cleanArgs, ctx, suffix)
  if (lookupResult !== null) return lookupResult

  // short non-conversational queries that missed item lookup — AI fallback with cooldown
  const cd = getBFallbackCooldown(ctx.user)
  if (cd > 0) {
    const suggestions = store.suggest(cleanArgs, 3)
    if (suggestions.length) return withSuffix(`try: ${suggestions.join(', ')}`, suffix)
    return withSuffix(noMatchMsg(cleanArgs), suffix)
  }

  const aiResponse = await tryAiRespond(aiQuery, ctx, mentions)
  if (aiResponse) {
    if (ctx.user) {
      bFallbackCooldowns.set(ctx.user.toLowerCase(), Date.now())
      if (bFallbackCooldowns.size > 500) {
        const now = Date.now()
        for (const [k, t] of bFallbackCooldowns) {
          if (now - t > B_FALLBACK_CD) bFallbackCooldowns.delete(k)
        }
      }
    }
    try { db.logCommand(ctx, 'ai', cleanArgs, 'fallback') } catch {}
    return aiResponse
  }

  const suggestions = store.suggest(cleanArgs, 3)
  if (suggestions.length) return withSuffix(`try: ${suggestions.join(', ')}`, suffix)
  return withSuffix(noMatchMsg(cleanArgs), suffix)
}

// --- !b AI fallback cooldown: per-user ---
// disabled — kripp chat needs every query answered; irc rate-limit + ai concurrency cap it naturally
const B_FALLBACK_CD = 0
const bFallbackCooldowns = new Map<string, number>()

function getBFallbackCooldown(user?: string): number {
  if (!user) return 0
  const last = bFallbackCooldowns.get(user.toLowerCase())
  if (!last) return 0
  const elapsed = Date.now() - last
  return elapsed >= B_FALLBACK_CD ? 0 : Math.ceil((B_FALLBACK_CD - elapsed) / 1000)
}

// structured subcommand miss → always answer: AI if available, else quippy noMatch line
async function aiOrQuip(query: string, ctx: CommandContext, suffix: string): Promise<string> {
  if (getBFallbackCooldown(ctx.user) === 0) {
    const response = await tryAiRespond(query, ctx)
    if (response) {
      if (ctx.user) bFallbackCooldowns.set(ctx.user.toLowerCase(), Date.now())
      try { db.logCommand(ctx, 'ai', query, 'fallback') } catch {}
      return response
    }
  }
  return withSuffix(noMatchMsg(query), suffix)
}

const TRIVIA_CATEGORIES = new Set(['items', 'heroes', 'monsters', 'kripp'])

// custom-topic generation is async + costs an API call — guard against concurrent
// builds (one per channel) and a fast-fire loop that would burn calls without ever
// starting a round (e.g. repeatedly feeding a topic the model refuses).
const CUSTOM_GEN_CD = 8_000
const customPending = new Set<string>()
const customGenCooldown = new Map<string, number>()

// chatters pepper topics with emotes ("birds Birdge 🐦", "Crowge the rookery") — those
// are participation noise, not part of the topic, and they tank generation. strip unicode
// emoji/pictographs first, then drop any whitespace token that resolves to a known 7tv/
// twitch emote name. if nothing real survives, keep the original trimmed input so a lone
// emote name can still be its own topic rather than a dead miss.
// invisible/format chars chat injects (zero-width, bidi controls, soft hyphen, the
// combining grapheme joiner U+034F, Hangul fillers). stripped so a topic like "sex" with a
// trailing U+034F becomes just "sex" instead of junk — without touching real letters/accents.
const INVISIBLE_RE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/gu

function stripEmotesFromTopic(topic: string): string {
  const noEmoji = topic.replace(INVISIBLE_RE, '').replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu, ' ')
  const tokens = noEmoji.split(/\s+/).filter(Boolean)
  const kept = tokens.filter((tok) => !findEmote(tok))
  return kept.length ? kept.join(' ') : topic.trim()
}

// natural phrasing puts a connector before the subject ("trivia ON cat", "trivia
// ABOUT birds"). left in, it derails the model — "on cat" yielded an "on'yomi"
// (Japanese reading) question instead of cats. strip a single leading connector so
// the topic is just the subject. only the unambiguous-connector words, so a real
// title that opens with "of"/"for" survives.
export function stripTopicConnector(topic: string): string {
  // drop a leftover "me" from "quiz me about X" / "trivia me X", then one connector.
  const stripped = topic.trim()
    .replace(/^me\s+/i, '')
    .replace(/^(?:on|about|regarding|concerning|covering)\s+/i, '')
    .trim()
  return stripped.length >= 2 ? stripped : topic.trim()
}

// strip a trailing "framing" clause that states WHY the round is being run, not WHAT it's
// about — "...to see if kripp can answer", "...so chat can guess", "...and see who knows".
// these address the audience, not the subject; left in they (a) derail the topic model and
// (b) leak a name (a streamer handle) that hijacks routing — the literal Romania->kripp-D3
// bug. only cuts at an unambiguous testing/purpose marker so a real title survives ("how to
// train your dragon", "to kill a mockingbird" — neither uses see/test/stump/etc.).
const TOPIC_FRAMING_RE = /\s+\b(?:to\s+(?:see|test|check|find\s+out|prove|stump|quiz|challenge)|(?:let'?s\s+|and\s+)?see\s+(?:if|who|whether|how)|so\s+(?:we|i|chat|that|everyone|you|u|kripp)\b)\b[\s\S]*$/i
export function stripTopicFraming(topic: string): string {
  const stripped = topic.replace(TOPIC_FRAMING_RE, '').trim()
  return stripped.length >= 2 ? stripped : topic.trim()
}

// "trivia about chat / the last 5 min / what we just talked about" — the topic is the
// conversation itself, so the question is built from the recent chat log, not a subject.
// must be RECALL intent: a bare "chat"/"the chat" topic or an explicit "last N min /
// recent messages / what we said" phrase. a qualified topic ("Kripp chat", "twitch chat",
// "4chan") is a SUBJECT for deep-lore custom trivia, not a request to quiz the chat log.
const CHAT_TRIVIA_RE = /^(?:the |this |our |these )?(?:chat|conversation|convo|messages?|msgs?)$|\b(?:the )?last \d+\s*(?:min|minute|sec|second|message|msg)s?\b|\brecent (?:chat|messages?|msgs?|convo)\b|\bwhat (?:we|you|i|us|chat|y'?all|everyone) (?:just |were |been )?(?:talk|talked|said|saying|discuss|chatted|wrote)|\bthis (?:stream|conversation)\b/i

// a kripp-subject topic -> route to the curated verified kripp pack (in kripp channels).
// kripp/octavian must LEAD the topic — it's the SUBJECT ("kripp", "kripp's d3 runs",
// "kripparrian lore"), not merely mentioned somewhere inside it ("Romania to see if kripp
// can answer", where kripp is the audience). anchoring to the start is what separates
// subject from incidental mention, so an off-topic ask never gets hijacked to the streamer
// pack — the framing strip above is the first line of defense, this anchor is the backstop.
const KRIPP_TOPIC_RE = /^(?:the\s+)?(?:kripp(?:a|arrian|arian|errian)?|octavian)\b/i

// pull the recent chat log for chat-trivia: drop the bot's own lines + empties,
// strip a leading command trigger so messages read naturally.
function recentChatLines(channel: string): string[] {
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  return getRecent(channel, 40)
    .filter((m) => m.user.toLowerCase() !== botName)
    .map((m) => `${m.user}: ${m.text.replace(/^!\w+\s*/, '').replace(/\n/g, ' ').trim()}`)
    .filter((l) => l.split(': ').slice(1).join(': ').trim().length > 0)
}

// "trivia about @someone" -> a person target. an explicit @mention is the only trigger,
// so real-world topics ("birds", "napoleon") are never hijacked. the captured group is
// the bare twitch handle. one token only — "@a b c" isn't a username.
const PERSON_TOPIC_RE = /^@([a-z0-9_]{2,25})$/i

// on the `!b` path, @mentions are stripped out of the command text before dispatch (they
// survive only in the suffix tag), so "!b trivia about @x" reaches us as topic "about".
// a leftover bare connector like this, paired with a mention, IS the person intent —
// "trivia about cats" keeps its topic, "trivia about @x" loses it to the tag.
const PERSON_CONNECTOR_RE = /^(?:about|on|for|regarding|concerning|covering)$/i

// the emote a chatter spams most — their signature. a regular who watches them KNOWS
// this, so it makes the fairest, most-fun person-trivia question. counted exactly (the
// model can't reliably eyeball "most-used" from a sample), needs >=2 uses to be a habit.
function signatureEmote(messages: string[]): string | null {
  const counts = new Map<string, number>()
  for (const m of messages) {
    for (const tok of m.split(/\s+/)) {
      const e = findEmote(tok)
      if (e) counts.set(e, (counts.get(e) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestN = 1 // a one-off isn't a signature
  for (const [e, n] of counts) if (n > bestN) { best = e; bestN = n }
  return best
}

// assemble what we've logged about a chatter into a compact dossier for the person-trivia
// model. only in-channel data we already store. leads with OBSERVABLE persona — signature
// emote, main item, AI-extracted facts — the things a regular who watches them could
// actually answer; hidden stats come last. returns null if the profile is too thin to make
// a fair question, so the caller misses honestly instead of inventing. gated on the message
// sample, not a users-table row, so a chat-only regular (never runs a command) still counts.
function buildPersonDossier(username: string, channel: string): string | null {
  const msgs = db.getUserMessages(username, channel, 80)
  const sample = msgs
    .map((m) => m.replace(/\n/g, ' ').trim())
    .filter((m) => m.length > 0 && m.length <= 120 && !m.startsWith('!'))
    .slice(0, 25)
  const facts = db.getUserFacts(username, 6)
  if (facts.length === 0 && sample.length < 6) return null // too thin to be fair

  const lines: string[] = []
  const sig = signatureEmote(msgs)
  if (sig) lines.push(`signature emote (their most-spammed): ${sig}`)
  const stats = db.getUserStats(username, channel)
  if (stats?.favorite_item) lines.push(`most-looked-up item: ${stats.favorite_item}`)
  const tops = db.getUserTopItems(username, 4)
  if (tops.length) lines.push(`top items: ${tops.join(', ')}`)
  if (facts.length) lines.push(`facts: ${facts.join(' | ')}`)
  if (stats) {
    const t: string[] = []
    if (stats.trivia_wins) t.push(`${stats.trivia_wins} trivia wins`)
    if (stats.trivia_best_streak) t.push(`best streak ${stats.trivia_best_streak}`)
    if (stats.trivia_points) t.push(`${stats.trivia_points} trivia points`)
    if (t.length) lines.push(`trivia (hidden stats — last resort): ${t.join(', ')}`)
  }
  // their own messages — recurring words/topics the model can spot. last so persona leads.
  if (sample.length) lines.push(`recent messages:\n${sample.map((m) => `- ${m}`).join('\n')}`)

  const text = lines.join('\n')
  return text.length >= 20 ? text : null
}

async function handleCustomTrivia(ctx: CommandContext, topic: string, suffix: string): Promise<string | null> {
  const channel = ctx.channel
  if (!channel) return null
  const t = stripTopicFraming(stripTopicConnector(stripEmotesFromTopic(topic.trim())))
  // need a real topic with at least one alphanumeric char; cap length before the API call.
  if (t.length < 2 || !/[a-z0-9]/i.test(t)) return null
  if (isGameActive(channel)) {
    return withSuffix(`a trivia round is already running — wait for it`, suffix)
  }
  // kripp-subject topics -> the curated, web-verified kripp pack. the AI fact-checker
  // can't confirm niche streamer lore so the AI path would just NULL out; the pack is the
  // verified, always-lands source. null when not a kripp channel/empty pack -> AI fallback.
  if (KRIPP_TOPIC_RE.test(t)) {
    const kr = startKrippTrivia(channel)
    if (kr) return withSuffix(kr, suffix)
  }
  if (customPending.has(channel)) return null
  const last = customGenCooldown.get(channel) ?? 0
  if (Date.now() - last < CUSTOM_GEN_CD) return null

  const isChatTrivia = CHAT_TRIVIA_RE.test(t)
  // "trivia about @someone" -> quiz chat on that person, grounded in what we've logged
  // about them. checked before the generic-topic path so a username never reaches the
  // topic model (which knows nothing about them and drifts to an unrelated question).
  // the @ may survive in the topic (top-level !trivia) or only in the suffix tag (!b).
  const mention = suffix.match(/@(\w{2,25})/)?.[1] ?? null
  let person: string | null = null
  if (!isChatTrivia) {
    const pm = t.startsWith('@') ? t.match(PERSON_TOPIC_RE) : null
    if (pm) person = pm[1]
    else if (mention && PERSON_CONNECTOR_RE.test(t)) person = mention
    // a dangling connector with no target ("trivia about" alone) has nothing to quiz on —
    // don't feed the bare word to the topic model (it drifts to a nonsense question).
    else if (PERSON_CONNECTOR_RE.test(t)) return null
  }

  customPending.add(channel)
  try {
    let q: CustomTrivia | null
    let missMsg: string
    if (isChatTrivia) {
      q = await generateChatTrivia(recentChatLines(channel), channel)
      missMsg = `not enough chat to make a trivia about yet — let it cook`
    } else if (person) {
      const dossier = buildPersonDossier(person, channel)
      if (!dossier) {
        return withSuffix(`don't know enough about @${person} yet to quiz on — they gotta chat more`, suffix)
      }
      q = await generatePersonTrivia(dossier, `@${person}`, channel)
      missMsg = `couldn't make a trivia about @${person} — try again`
    } else {
      // pass recent questions AND answers so the model avoids repeats up front; if it still
      // echoes a recent question OR lands on a recent answer (same fact reworded), regenerate
      // — up to 2 retries — before giving up on uniqueness.
      const avoid = recentQuestionList(channel)
      const avoidAnswers = recentAnswerList(channel)
      q = await generateCustomTrivia(t, channel, avoid, avoidAnswers)
      for (let i = 0; q && i < 2 && (isRecentQuestion(channel, q.question) || isRecentAnswer(channel, q.answer)); i++) {
        q = await generateCustomTrivia(t, channel, avoid, avoidAnswers)
      }
      // a world-knowledge topic must NEVER dead-end. if the AI couldn't make one (niche
      // subject the verifier won't confirm, daily cap, no key, API hiccup), fall back to a
      // curated, always-true question so chat still gets a round — no "clearer topic" miss.
      if (!q) {
        const fb = startFallbackTrivia(channel)
        return withSuffix(fb ?? `trivia's catching its breath — try again in a sec`, suffix)
      }
      return withSuffix(startCustomTrivia(channel, q), suffix)
    }
    if (!q) return withSuffix(missMsg, suffix)
    return withSuffix(startCustomTrivia(channel, q), suffix)
  } finally {
    customPending.delete(channel)
    const now = Date.now()
    customGenCooldown.set(channel, now)
    if (customGenCooldown.size > 200) {
      for (const [k, v] of customGenCooldown) if (now - v > CUSTOM_GEN_CD) customGenCooldown.delete(k)
    }
  }
}

// single trivia router shared by `!trivia ...` and `!b trivia ...`. handles the
// built-in subcommands (score/skip/stats/category), then treats anything else as a
// custom AI topic.
async function runTrivia(ctx: CommandContext, rawArg: string, suffix: string): Promise<string | null> {
  if (!ctx.channel) return null
  const arg = rawArg.trim()
  const lower = arg.toLowerCase()
  // bare `!b trivia` arrives as the literal "trivia" (subcommand dispatcher falls back
  // to cleanArgs when no group captured) — treat it, like an empty arg, as a random round.
  if (!arg || lower === 'trivia') return withSuffix(startTrivia(ctx.channel), suffix)
  if (lower === 'score') return withSuffix(getTriviaScore(ctx.channel), suffix)
  if (lower === 'skip') {
    const msg = skipTrivia(ctx.channel, ctx.user)
    return msg ? withSuffix(msg, suffix) : null
  }
  if (lower === 'stats' || lower.startsWith('stats ')) {
    const target = lower.replace(/^stats\s*@?/, '').trim() || ctx.user
    if (!target) return null
    return withSuffix(formatStats(target, ctx.channel), suffix)
  }
  if (TRIVIA_CATEGORIES.has(lower)) {
    return withSuffix(startTrivia(ctx.channel, lower as 'items' | 'heroes' | 'monsters' | 'kripp'), suffix)
  }
  return await handleCustomTrivia(ctx, arg, suffix)
}

const triviaCommand: CommandHandler = (args, ctx) => runTrivia(ctx, args, '')

// --- chat-planted steering directives ("vibes") ---
// cheap prefilter for "plant a directive" intent — the AI gate is the real validator
// (and rejects false positives), this just decides when to spend a classify call. covers
// topic/per-user STEER ("anytime <who> asks ..."), persistent self-style STEER ("from now
// on end your messages with X"), and MUTE ("don't respond to X").
export const DIRECTIVE_INTENT = new RegExp([
  // steer: "anytime/whenever/when <who> asks/mentions/says ..."
  /(any\s?time|every\s?time|each\s?time|whenever|when(?:ever)?|from now on|going forward)\b[\s\S]{0,70}\b(asks?|asking|mentions?|says?|brings? up|talks? about|posts?|messages?)\b/.source,
  // steer (bot's own persistent style): "always/from now on/be sure to … end/talk/add/sign …"
  /\b(always|from\s?now\s?on|from here on(?:\s?out)?|going forward|for now on|keep|be sure to|make sure to|try to|remember to)\b[\s\S]{0,40}\b(end|start|begin|finish|sign|respond|repl|answer|talk|speak|writ|say|add|includ|use|act|behav|throw|drop|put|mention|call|greet|address|treat|emote)\w*/.source,
  // steer: "end/start/sign off your/each/every messages|replies|answers …"
  /\b(end|start|begin|finish|sign\s?off|signing\s?off|respond|repl|answer|talk|speak|writ|say)\w*[\s\S]{0,25}\b(your|each|every|all|the)\s+(messages?|replies|reply|responses?|answers?|posts?|texts?)\b/.source,
  // steer (per-user): "answer/treat/talk to <name> in/like/as <style>" — exclude pronouns/
  // determiners so "answer this in chat" / "talk to the merchant" don't fire a paid call.
  /\b(answer|respond to|repl(?:y|ies|ying) to|talk to|speak to|treat|address|greet)\s+@?(?!(?:that|this|these|those|the|a|an|it|me|us|you|them|him|her|my|your|everyone|anyone|chat|here)\b)\w{2,}\s+(in|like|as|with)\b/.source,
  // mute: "don't/stop/never respond|reply|answer|talk to ..."
  /\b(do\s?n'?t|do not|stop|never|quit|no longer)\s+(respond(?:ing)?|repl(?:y|ies|ying)|answer(?:ing)?|talk(?:ing)?|engag\w*)\b/.source,
  // mute: "ignore <name>"
  // mute: "ignore <name>" — but not "ignore that/this/the/him/it/chat/…" (plain chat)
  /\bignore\s+@?(?!(?:that|this|these|those|the|a|an|him|her|them|it|me|us|you|my|your|his|chat|everything|everyone|anyone|all|stuff|what|when|if|me\b)\b)\w{2,}/.source,
].join('|'), 'i')

const DIRECTIVE_PLANT_CD = 60_000
const directivePlantCooldown = new Map<string, number>()

async function handlePlantDirective(text: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  const channel = ctx.channel
  if (!channel || !ctx.user) return null
  const last = directivePlantCooldown.get(ctx.user.toLowerCase()) ?? 0
  if (Date.now() - last < DIRECTIVE_PLANT_CD) return null // anti-spam: 1 plant/user/60s

  // burn the window BEFORE the paid classify call — a rejected plant or a DIRECTIVE_INTENT
  // false-positive still costs a Sonnet call, so it must be throttled too, not just successes.
  const now = Date.now()
  directivePlantCooldown.set(ctx.user.toLowerCase(), now)
  if (directivePlantCooldown.size > 500) {
    for (const [k, t] of directivePlantCooldown) if (now - t > DIRECTIVE_PLANT_CD) directivePlantCooldown.delete(k)
  }

  const parsed = await parseDirective(text, channel)
  if (!parsed) return null // not a directive, AI-rejected, AI off, or cap hit → caller falls through to a normal answer

  addDirective(channel, ctx.user, parsed)
  if (parsed.mute) {
    return withSuffix(`got it — ignoring ${parsed.targetUser} for 20m (mods can undo with !b vibes clear)`, suffix)
  }
  const scope = parsed.targetUser ? `@${parsed.targetUser}'s answers` : parsed.trigger.length ? `${parsed.trigger.join('/')} answers` : 'every answer'
  return withSuffix(`got it — ${scope} get a twist for 20m: ${parsed.instruction} (mods can wipe with !b vibes clear)`, suffix)
}

function handleVibes(arg: string, ctx: CommandContext, suffix: string): string | null {
  if (!ctx.channel) return null
  if (/^clear$/i.test(arg.trim())) {
    if (!ctx.isMod && !ctx.privileged) return withSuffix(`only mods can clear vibes`, suffix)
    const n = clearDirectives(ctx.channel)
    return withSuffix(n > 0 ? `cleared ${n} active vibe${n === 1 ? '' : 's'}` : `no active vibes`, suffix)
  }
  const list = listDirectives(ctx.channel)
  if (list.length === 0) return withSuffix(`no active vibes — plant one like "anytime someone asks about X, do Y"`, suffix)
  const now = Date.now()
  const lines = list.map((d) => {
    const mins = Math.max(1, Math.round((d.expiresAt - now) / 60_000))
    if (d.mute) return `[mute @${d.targetUser}] (${mins}m, by ${d.planter})`
    const scope = d.targetUser ? `@${d.targetUser}` : d.trigger.length ? d.trigger.join('/') : 'all'
    return `[${scope}] ${d.instruction} (${mins}m, by ${d.planter})`
  })
  return withSuffix(`active vibes: ${lines.join(' · ')}`, suffix)
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
  trivia: triviaCommand,
}

// #10: block the bot's own command names from the proxy so chatters can't self-relay !b/!trivia.
// derived at module-init so it never drifts when new commands are added to the registry.
for (const k of Object.keys(commands)) BLOCKED_BANG_CMDS.add(k)

export async function handleCommand(text: string, ctx: CommandContext = {}): Promise<string | null> {
  // strip leading @mention so !b works in Twitch replies
  const cleaned = text.replace(/^@\w+\s+/, '')
  const match = cleaned.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  // muted by a chat-planted directive → stay silent across ALL commands (!b, !trivia,
  // !vibes…), so a mute can't be escaped via trivia. mods/broadcaster are never muteable.
  if (ctx.channel && ctx.user && !ctx.isMod && !ctx.privileged && isMuted(ctx.channel, ctx.user)) return null

  return handler(args.trim(), ctx)
}

export function resetDedup() {
  recentQueries.clear()
}

export function resetProxyCooldowns() {
  proxyCooldowns.clear()
  bFallbackCooldowns.clear()
}

export { PROXY_COOLDOWN }
