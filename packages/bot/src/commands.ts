import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults, truncate, resolveTooltip, compressTooltip, TIER_ORDER } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import type { CmdType } from './db'
import { startTrivia, getTriviaScore, formatStats, formatTop, invalidateAliasCache } from './trivia'
import { aiRespond, dedupeEmote, dedupeMention, fixEmoteCase, fixEmotePunctuation } from './ai'
import { isEmote, findEmote } from './emotes'
import { getThread } from './chatbuf'
import { log } from './log'

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

/** shared AI call + post-processing (dedup emotes/mentions, append missing @mentions) */
async function tryAiRespond(query: string, ctx: CommandContext, mentions: string[] = []): Promise<string | null> {
  let result: Awaited<ReturnType<typeof aiRespond>> = null
  try { result = await aiRespond(query, { ...ctx, direct: true }) } catch (e) { log(`ai: call failed: ${e}`) }
  if (!result?.text) return null
  let response = dedupeMention(dedupeEmote(fixEmotePunctuation(fixEmoteCase(result.text, ctx.channel), ctx.channel), ctx.channel), ctx.channel, ctx.user)
  if (mentions.length > 0) {
    const lower = response.toLowerCase()
    const missing = mentions.map((m) => m.toLowerCase()).filter((m) => !lower.includes(m))
    if (missing.length > 0) response = withSuffix(response, ` ${missing.join(' ')}`)
  }
  return response
}

function withSuffix(text: string, suffix: string): string {
  const combined = text + suffix
  if (combined.length <= MAX_LEN) return combined
  // trim text to make room for suffix
  const budget = MAX_LEN - suffix.length
  if (budget <= 0) return text.slice(0, MAX_LEN)
  const cut = text.slice(0, budget)
  const lastBreak = Math.max(cut.lastIndexOf(' | '), cut.lastIndexOf(' '))
  const trimmed = lastBreak > budget * 0.5 ? cut.slice(0, lastBreak) + '...' : cut.slice(0, budget - 3) + '...'
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
])

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

  // extract tier from any position (exact match wins over enchant prefix)
  const tierIdx = remaining.findIndex((w) => TIERS.includes(w.toLowerCase()))
  if (tierIdx !== -1) {
    tier = capitalize(remaining[tierIdx].toLowerCase()) as TierName
    remaining.splice(tierIdx, 1)
  }

  // extract enchantment from any position if other words remain for item
  // require exact match or prefix within 2 chars of full name to avoid "shield"→"shielded"
  if (remaining.length > 1 && remaining.length <= 8) {
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

let lobbyChannel = ''
export function setLobbyChannel(name: string) { lobbyChannel = name }

const OWNER = (process.env.BOT_OWNER ?? '').toLowerCase()
let onRefresh: (() => Promise<string>) | null = null
export function setRefreshHandler(handler: () => Promise<string>) { onRefresh = handler }

let onEmoteRefresh: (() => Promise<string>) | null = null
export function setEmoteRefreshHandler(handler: () => Promise<string>) { onEmoteRefresh = handler }

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

const BASE_USAGE = '!b <item> [tier] [enchant] | !b hero/mob/skill/tag/day/enchants/trivia/score/stats | bazaardb.gg'
const JOIN_USAGE = () => lobbyChannel ? ` | add bot: type !join in ${lobbyChannel}'s chat` : ''

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
  'trivia', 'score', 'stats', 'top', 'alias', 'help', 'info',
  'refresh', 'emotes',
])

const subcommands: [RegExp, SubHandler][] = [
  [/^alias$/i, (_q, ctx) => {
    if (!ctx.user || !ALIAS_ADMINS.has(ctx.user)) return 'alias management is restricted'
    return 'usage: !b alias <slang> = <item> | !b alias del <slang> | !b alias list'
  }],
  [/^alias\s+list$/i, (_q, ctx) => {
    if (!ctx.user || !ALIAS_ADMINS.has(ctx.user)) return 'alias management is restricted'
    const aliases = store.getDynamicAliases()
    if (aliases.size === 0) return 'no dynamic aliases set'
    const entries = [...aliases.entries()].map(([k, v]) => `${k}→${v}`)
    return truncate(`aliases: ${entries.join(', ')}`)
  }],
  [/^alias\s+del\s+(.+)$/i, (query, ctx) => {
    if (!ctx.user || !ALIAS_ADMINS.has(ctx.user)) return 'alias management is restricted'
    const removed = store.removeDynamicAlias(query)
    if (removed) invalidateAliasCache()
    return removed ? `removed alias "${query}"` : `no alias found for "${query}"`
  }],
  [/^refresh$/i, async (_q, ctx) => {
    if (ctx.user !== OWNER) return null
    if (!onRefresh) return 'refresh not available'
    return onRefresh()
  }],
  [/^emotes?\s+refresh$/i, async (_q, ctx) => {
    if (ctx.user !== OWNER) return null
    if (!onEmoteRefresh) return 'emote refresh not available'
    return onEmoteRefresh()
  }],
  [/^(?:mob|monster)$/i, () => 'usage: !b mob <name>'],
  [/^hero$/i, () => 'usage: !b hero <name>'],
  [/^tag$/i, () => 'usage: !b tag <tagname>'],
  [/^skill$/i, () => 'usage: !b skill <name>'],
  [/^day$/i, () => 'usage: !b day <number>'],
  [/^(?:mob|monster)\s+(.+)$/i, (query, ctx, suffix) => {
    const monster = store.findMonster(query)
    if (!monster) {
      logMiss(query, ctx)
      const suggestions = store.suggest(query, 3)
      if (suggestions.length) return `no monster found for ${query} — try: ${suggestions.join(', ')}`
      return `no monster found for ${query}`
    }
    logHit('mob', query, monster.Title, ctx)
    return withSuffix(formatMonster(monster, resolveSkills(monster)), suffix)
  }],
  [/^hero\s+(.+)$/i, (query, ctx, suffix) => {
    const resolved = store.findHeroName(query)
    const items = store.byHero(query)
    if (items.length === 0) return `no items found for hero ${query}`
    const displayName = resolved ?? query
    logHit('hero', query, `${items.length} items`, ctx)
    return withSuffix(truncate(`[${displayName}] ${items.map((i) => i.Title).join(', ')}`), suffix)
  }],
  [/^enchant(?:s|ments)?$/i, (_query, ctx, suffix) => {
    const names = store.getEnchantments().map(capitalize)
    logHit('enchants', _query, `${names.length} enchants`, ctx)
    return withSuffix(truncate(`Enchantments: ${names.join(', ')}`), suffix)
  }],
  [/^tag\s+(.+)$/i, (query, ctx, suffix) => {
    const resolved = store.findTagName(query)
    const cards = store.byTag(query)
    if (cards.length === 0) {
      logMiss(query, ctx)
      const suggestions = store.suggest(query, 3)
      if (suggestions.length) return `no items found with tag ${query} — try: ${suggestions.join(', ')}`
      return `no items found with tag ${query}`
    }
    const displayTag = resolved ?? query
    logHit('tag', query, `${cards.length} items`, ctx)
    return withSuffix(formatTagResults(displayTag, cards), suffix)
  }],
  [/^day\s+(\d+)$/i, (query, ctx, suffix) => {
    const day = parseInt(query)
    if (day < 1 || day > 99) return `invalid day number (1-99)`
    const mobs = store.monstersByDay(day)
    if (mobs.length === 0) { logMiss(query, ctx); return `no monsters found for day ${day}` }
    logHit('day', query, `${mobs.length} monsters`, ctx)
    return withSuffix(formatDayResults(day, mobs), suffix)
  }],
  [/^skill\s+(.+)$/i, (query, ctx, suffix) => {
    const skill = store.findSkill(query)
    if (!skill) { logMiss(query, ctx); return `no skill found for ${query}` }
    logHit('skill', query, skill.Title, ctx)
    return withSuffix(formatItem(skill), suffix)
  }],
  [/^trivia(?:\s+(items|heroes|monsters))?$/i, (query, ctx, suffix) => {
    if (!ctx.channel) return null
    const validCategories = new Set(['items', 'heroes', 'monsters'])
    const category = validCategories.has(query?.toLowerCase()) ? query.toLowerCase() as 'items' | 'heroes' | 'monsters' : undefined
    return withSuffix(startTrivia(ctx.channel, category), suffix)
  }],
  [/^score$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return withSuffix(getTriviaScore(ctx.channel), suffix)
  }],
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

// strip conversational prefixes so "what is birdge" → "birdge"
// "how about" / "what about" excluded — they're continuations, not direct lookups
const QUESTION_PREFIX = /^(?:what(?:'?s | is | are )|tell me about |show me |look up |find me |can you (?:find |look up |show ))/i

function stripQuestionPrefix(s: string): string {
  const stripped = s.replace(QUESTION_PREFIX, '')
  // only strip if something meaningful remains
  return stripped.length >= 2 ? stripped : s
}

async function itemLookup(cleanArgs: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  const stripped = stripQuestionPrefix(cleanArgs)
  const words = stripped.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return BASE_USAGE + JOIN_USAGE()

  if (enchant) {
    const card = store.exact(query) ?? store.search(query, 1)[0]
    if (!card) { logMiss(query, ctx); return `no item found for ${query}` }
    logHit('enchant', query, `${card.Title}+${enchant}`, ctx, tier)
    return withSuffix(formatEnchantment(card, enchant, tier), suffix)
  }

  // items first (exact then fuzzy) — !b mob exists for explicit monster lookups
  const exactCard = store.exact(query)
  const card = exactCard ?? store.search(query, 1)[0]

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

  logMiss(query, ctx)

  // check if query is a known emote (prevent AI hallucination for emote lookups)
  const emoteMatch = queryWords.map((w) => findEmote(w)).find(Boolean)
  if (emoteMatch) return withSuffix(`${emoteMatch} is an emote, not a bazaar item`, suffix)

  if (queryWords.length <= 2) {
    const suggestions = store.suggest(query, 3)
    if (suggestions.length > 0) {
      return withSuffix(`no ${query} — did you mean: ${suggestions.join(', ')}?`, suffix)
    }
  }
  // no item match — fall through to AI fallback in bazaarinfo()
  return null
}

async function bazaarinfo(args: string, ctx: CommandContext): Promise<string | null> {
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

  if (!cleanArgs || cleanArgs === 'help' || cleanArgs === 'info') return BASE_USAGE + JOIN_USAGE()

  if (/^(how (do you|does this( bot)?) work|what are you|what is this)\b/i.test(cleanArgs)) {
    return 'twitch chatbot for The Bazaar by mellen. looks up items/heroes/monsters from bazaardb.gg, runs trivia, and answers questions. try: !b <item> | !b hero <name> | !b <question>'
  }

  // proxy ! and / commands — before dedup so cooldown messages always show
  const bangMatch = cleanArgs.match(/^!(\w+)(.*)$/)
  if (bangMatch) {
    const cmd = bangMatch[1].toLowerCase()
    if (BLOCKED_BANG_CMDS.has(cmd)) return null
    return proxyWithCooldown(ctx.channel, cleanArgs, cmd)
  }
  const slashMatch = cleanArgs.match(/^\/(\w+)(.*)$/)
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase()
    if (!ALLOWED_SLASH_CMDS.has(cmd)) return null
    if (cmd === 'announce' && !ctx.isMod) return null
    return cleanArgs
  }
  // embedded command: "so can u run !jory pls" → "!jory"
  // skip if asking about a command ("who has the most !a"), not requesting one
  // questions about commands mention them as nouns; requests use action verbs near them
  const isAskingAbout = /^(who|what|when|where|why|how|does|has|have|is|should|can|will|could|would|may|might|don'?t|never|please)\b/i.test(cleanArgs)
  if (!isAskingAbout) {
    const embeddedMatch = cleanArgs.match(/!(\w+)(?:\s+(\d+))?/)
    if (embeddedMatch) {
      const cmd = embeddedMatch[1].toLowerCase()
      if (!BLOCKED_BANG_CMDS.has(cmd)) {
        const cmdStr = embeddedMatch[2] ? `!${embeddedMatch[1]} ${embeddedMatch[2]}` : `!${embeddedMatch[1]}`
        return proxyWithCooldown(ctx.channel, cmdStr, cmd)
      }
    }
  }

  // suppress duplicate lookups within 30s per channel (same user only)
  if (ctx.channel && ctx.user && isDuplicate(ctx.channel, `${ctx.user}:${cleanArgs}`)) return null

  const suffix = mentions.length ? ` ${mentions.join(' ')}` : ''

  // alias add: !b alias <slang> = <target>
  const aliasAdd = cleanArgs.match(/^alias\s+(.+?)\s*=\s*(.+)$/i)
  if (aliasAdd) {
    if (!ctx.user || !ALIAS_ADMINS.has(ctx.user)) return 'alias management is restricted'
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
    if (match) return handler(match[1]?.trim() ?? cleanArgs, ctx, suffix)
  }

  // spam wall interception — handle without AI, just repeat the word
  const spamMatch = cleanArgs.match(/^spam\s+(?:this\s+)?(.+)/i)
  if (spamMatch) {
    const word = spamMatch[1].trim()
    if (word.length > 0 && word.length <= 30) {
      const reps = 10
      return withSuffix(Array(reps).fill(word).join(' '), suffix)
    }
  }

  // detect conversational/creative queries that should skip item lookup entirely
  const isGreeting = /^(h(ello|i|ey|owdy)|yo|sup|hey+|what'?s? ?up|greetings|hola|whats good|good (morning|evening|night)|gm|gn|gg|ty|thanks|thank you|lol|lmao|wow|nice|cool|pog|based|true|real|facts|nah|bruh|bro|dude|man|omg|rip|oof|haha|o7|bye|cya|later|peace|gl|hf|glhf|ggs)\b/i.test(cleanArgs)
  const isContinuation = /^(how about|what about|and |or |but )\b/i.test(cleanArgs)
  const isConversational = isGreeting
    || isContinuation
    || cleanArgs.split(/\s+/).length > 4
    || /\b(continue|extend|expand|write|make|create|do|say|tell|give|sing|rap|roast|rate|rank|compare|explain|describe|imagine|pretend|spam|repeat|copypasta|pasta)\b/i.test(cleanArgs)

  // conversational queries go straight to AI — no item lookup, no fallback cooldown
  if (isConversational) {
    const response = await tryAiRespond(aiQuery, ctx, mentions)
    if (response) {
      try { db.logCommand(ctx, 'ai', cleanArgs, 'fallback') } catch {}
    }
    return response
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
const B_FALLBACK_CD = 10_000
const bFallbackCooldowns = new Map<string, number>()

function getBFallbackCooldown(user?: string): number {
  if (!user) return 0
  const last = bFallbackCooldowns.get(user.toLowerCase())
  if (!last) return 0
  const elapsed = Date.now() - last
  return elapsed >= B_FALLBACK_CD ? 0 : Math.ceil((B_FALLBACK_CD - elapsed) / 1000)
}

const triviaCommand: CommandHandler = (args, ctx) => {
  if (!ctx.channel) return null
  const validCategories = new Set(['items', 'heroes', 'monsters'])
  const trimmed = args.trim().toLowerCase()
  if (trimmed === 'score') return getTriviaScore(ctx.channel)
  if (trimmed.startsWith('stats')) {
    const target = trimmed.replace(/^stats\s*@?/, '').trim() || ctx.user
    if (!target) return null
    return formatStats(target, ctx.channel)
  }
  const category = validCategories.has(trimmed) ? trimmed as 'items' | 'heroes' | 'monsters' : undefined
  return startTrivia(ctx.channel, category)
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
  trivia: triviaCommand,
}

export async function handleCommand(text: string, ctx: CommandContext = {}): Promise<string | null> {
  // strip leading @mention so !b works in Twitch replies
  const cleaned = text.replace(/^@\w+\s+/, '')
  const match = cleaned.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  return handler(args.trim(), ctx)
}

export function resetDedup() {
  recentQueries.clear()
}

export function resetProxyCooldowns() {
  proxyCooldowns.clear()
}

export { PROXY_COOLDOWN }
