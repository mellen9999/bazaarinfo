import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults, truncate, resolveTooltip, compressTooltip, TIER_ORDER } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import type { CmdType } from './db'
import { startTrivia, getTriviaScore, formatStats, formatTop, invalidateAliasCache } from './trivia'
import { aiRespond, dedupeEmote, fixEmoteCase, getAiCooldown } from './ai'

const MAX_LEN = 480

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

// ! commands blocked from proxy — system cmds from streamlabs, streamelements, nightbot, etc.
const BLOCKED_BANG_CMDS = new Set([
  // moderation
  'ban', 'unban', 'timeout', 'untimeout', 'permit', 'nuke', 'unnuke',
  'mod', 'unmod', 'vip', 'unvip', 'block', 'unblock',
  // stream control
  'title', 'settitle', 'game', 'setgame', 'commercial', 'raid', 'unraid', 'host', 'unhost', 'marker',
  'so', 'shoutout',
  // chat modes
  'slow', 'slowoff', 'followers', 'followersoff', 'subscribers', 'subscribersoff',
  'emoteonly', 'emoteonlyoff', 'uniquechat', 'uniquechatoff', 'clear',
  // command management
  'commands', 'addcom', 'editcom', 'delcom', 'deletecom', 'disablecom', 'enablecom',
  // song request (streamlabs + streamelements)
  'sr', 'songrequest', 'songs', 'skip', 'wrongsong', 'volume', 'queue', 'playlist',
  // loyalty / gambling (streamelements)
  'points', 'loyalty', 'givepoints', 'removepoints', 'top', 'leaderboard',
  'roulette', 'gamble', 'slots', 'duel',
  // giveaway / raffle / poll
  'giveaway', 'raffle', 'enter', 'poll', 'vote', 'winner',
  // nightbot extras
  'regulars', 'filters', 'timers',
])

// / commands: allowlist only — everything else blocked
const ALLOWED_SLASH_CMDS = new Set([
  'me', 'announce', 'color',
])

// --- proxy cooldown: per-channel per-command, 30s window ---
const PROXY_COOLDOWN = 30_000
const proxyCooldowns = new Map<string, number>()

function proxyWithCooldown(channel: string | undefined, cmdStr: string, cmd: string): string {
  if (!channel) return cmdStr
  const key = `${channel}:${cmd.toLowerCase()}`
  const now = Date.now()
  const last = proxyCooldowns.get(key)
  if (last && now - last < PROXY_COOLDOWN) {
    const left = Math.ceil((PROXY_COOLDOWN - (now - last)) / 1000)
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
const BOT_NAME = (process.env.TWITCH_USERNAME ?? '').toLowerCase()
const mentionRe = BOT_NAME ? new RegExp(`@${BOT_NAME}\\b`, 'i') : null
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
      if (suggestions.length) return `no monster found for "${query}" — try: ${suggestions.join(', ')}`
      return `no monster found for ${query}`
    }
    logHit('mob', query, monster.Title, ctx)
    return withSuffix(formatMonster(monster, resolveSkills(monster)), suffix)
  }],
  [/^hero\s+(.+)$/i, (query, ctx, suffix) => {
    const resolved = store.findHeroName(query)
    const items = store.byHero(query)
    if (items.length === 0) return `no items found for hero "${query}"`
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
      if (suggestions.length) return `no items found with tag "${query}" — try: ${suggestions.join(', ')}`
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
    if (!skill) { logMiss(query, ctx); return `no skill found for "${query}"` }
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
    return withSuffix(formatStats(target), suffix)
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

// --- deterministic string tricks (reverse, uppercase, etc.) ---
// uses raw args (before quote stripping) so quoted strings are preserved

const Q = '[""\u201C\u201D]' // ASCII + smart quotes
const STRING_TRICK_RE = new RegExp(`\\breverse\\b.*?${Q}(.+?)${Q}|\\breverse\\b.*\\b(\\S+)$`, 'i')
const UPPERCASE_TRICK_RE = new RegExp(`\\b(?:uppercase|upcase|caps)\\b.*?${Q}(.+?)${Q}|\\b(?:uppercase|upcase|caps)\\b.*\\b(\\S+)$`, 'i')
const LOWERCASE_TRICK_RE = new RegExp(`\\b(?:lowercase|downcase)\\b.*?${Q}(.+?)${Q}|\\b(?:lowercase|downcase)\\b.*\\b(\\S+)$`, 'i')

function handleStringTrick(raw: string): string | null {
  let m = raw.match(STRING_TRICK_RE)
  if (m) {
    const target = m[1] ?? m[2]
    return [...target].reverse().join('')
  }
  m = raw.match(UPPERCASE_TRICK_RE)
  if (m) return (m[1] ?? m[2]).toUpperCase()
  m = raw.match(LOWERCASE_TRICK_RE)
  if (m) return (m[1] ?? m[2]).toLowerCase()
  return null
}

// questions with 3+ words starting with these go straight to AI for analysis
const QUESTION_PREFIX = /^(why|how|should|would|could|does|do|did|is|are|was|were|can|will|who|where|when|what)\b/i

async function itemLookup(cleanArgs: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  const words = cleanArgs.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return BASE_USAGE + JOIN_USAGE()


  // conversational game questions → AI for analysis (it has tools to look up cards)
  if (!tier && !enchant && words.length >= 3 && (QUESTION_PREFIX.test(query) || query.includes('?'))) {
    let aiResult: Awaited<ReturnType<typeof aiRespond>> = null
    try { aiResult = await aiRespond(cleanArgs, ctx) } catch {}
    if (aiResult?.text) {
      logHit('ai', cleanArgs, 'ai', ctx)
      return dedupeEmote(fixEmoteCase(aiResult.text, ctx.channel), ctx.channel)
    }
    // AI failed — fall through to normal lookup
  }

  if (enchant) {
    const card = store.exact(query) ?? store.search(query, 1)[0]
    if (!card) { logMiss(query, ctx); return `no item found for "${query}"` }
    logHit('enchant', query, `${card.Title}+${enchant}`, ctx, tier)
    return withSuffix(formatEnchantment(card, enchant, tier), suffix)
  }

  // items first (exact then fuzzy) — !b mob exists for explicit monster lookups
  const card = store.exact(query) ?? store.search(query, 1)[0]

  // for conversational queries (>3 words), only accept fuzzy match if the item title
  // shares a meaningful word with the query — prevents "right" matching "Right Eye"
  const queryWords = query.toLowerCase().split(/\s+/)
  const isRelevantMatch = (title: string) => {
    if (queryWords.length <= 3) return true
    const titleWords = title.toLowerCase().split(/\s+/)
    return titleWords.some((tw) => tw.length >= 3 && queryWords.includes(tw))
  }

  if (card && isRelevantMatch(card.Title)) {
    const v = validateTier(card, tier)
    logHit('item', query, card.Title, ctx, v.tier)
    const result = formatItem(card, v.tier)
    return withSuffix(v.note ? `${result} (${v.note})` : result, suffix)
  }

  const monster = store.findMonster(query)
  if (monster && isRelevantMatch(monster.Title)) {
    logHit('mob', query, monster.Title, ctx)
    return withSuffix(formatMonster(monster, resolveSkills(monster)), suffix)
  }

  logMiss(query, ctx)

  // always try AI first — every miss is an opportunity to be interesting
  let aiResult: Awaited<ReturnType<typeof aiRespond>> = null
  try { aiResult = await aiRespond(cleanArgs, ctx) } catch {}
  if (aiResult?.text) {
    logHit('ai', cleanArgs, 'ai', ctx)
    return dedupeEmote(fixEmoteCase(aiResult.text, ctx.channel), ctx.channel)
  }

  // AI failed — check if on cooldown, otherwise show suggestions
  const cd = getAiCooldown(ctx.user, ctx.channel)
  if (cd > 0) return withSuffix(`on cooldown (${cd}s)`, suffix)

  if (queryWords.length <= 2) {
    const suggestions = store.suggest(query, 3)
    if (suggestions.length > 0) {
      return withSuffix(`no "${query}" — did you mean: ${suggestions.join(', ')}?`, suffix)
    }
  }
  return withSuffix(`no match for "${truncate(query, 40)}"`, suffix)
}

async function bazaarinfo(args: string, ctx: CommandContext): Promise<string | null> {
  // deterministic string tricks — check raw args before quote stripping
  const trick = handleStringTrick(args)
  if (trick) return trick

  // extract @mentions to tag at end of response
  const mentions = args.match(/@\w+/g) ?? []
  const cleanArgs = args.replace(/@\w+/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim()

  if (!cleanArgs || cleanArgs === 'help' || cleanArgs === 'info') return BASE_USAGE + JOIN_USAGE()

  if (/^(how (do you|does this( bot)?) work|what are you|what is this)\b/i.test(cleanArgs)) {
    return 'twitch chatbot for The Bazaar by mellen. looks up items/heroes/monsters from bazaardb.gg, runs trivia, and answers questions with AI. try: !b <item> | !b hero <name> | !b trivia'
  }

  // proxy ! and / commands — before dedup so cooldown messages always show
  const bangMatch = cleanArgs.match(/^!(\w+)(.*)$/)
  if (bangMatch) {
    const cmd = bangMatch[1].toLowerCase()
    if (BLOCKED_BANG_CMDS.has(cmd) && !ctx.isMod) return null
    return proxyWithCooldown(ctx.channel, cleanArgs, cmd)
  }
  const slashMatch = cleanArgs.match(/^\/(\w+)(.*)$/)
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase()
    if (!ALLOWED_SLASH_CMDS.has(cmd)) return null
    return cleanArgs
  }
  // embedded command: "so can u run !jory pls" → "!jory"
  const embeddedMatch = cleanArgs.match(/!(\w+)(?:\s+(\d+))?/)
  if (embeddedMatch) {
    const cmd = embeddedMatch[1].toLowerCase()
    if (!BLOCKED_BANG_CMDS.has(cmd)) {
      const cmdStr = embeddedMatch[2] ? `!${embeddedMatch[1]} ${embeddedMatch[2]}` : `!${embeddedMatch[1]}`
      return proxyWithCooldown(ctx.channel, cmdStr, cmd)
    }
  }

  // suppress duplicate lookups within 30s per channel
  if (ctx.channel && isDuplicate(ctx.channel, cleanArgs)) return null

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
    if (!match) return `no item found for "${targetQuery}"`
    store.addDynamicAlias(aliasKey, match.Title, ctx.user)
    invalidateAliasCache()
    return `alias set: ${aliasKey} → ${match.Title}`
  }

  for (const [pattern, handler] of subcommands) {
    const match = cleanArgs.match(pattern)
    if (match) return handler(match[1]?.trim() ?? cleanArgs, ctx, suffix)
  }

  return itemLookup(cleanArgs, ctx, suffix)
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
}

async function handleMention(text: string, ctx: CommandContext): Promise<string | null> {
  if (!mentionRe) return null
  if (!mentionRe.test(text)) return null

  const query = text.replace(mentionRe, '').replace(/@\w+/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim()
  if (!query) return null
  if (ctx.channel && isDuplicate(ctx.channel, `mention:${query}`)) return null
  if (ctx.user && getAiCooldown(ctx.user, ctx.channel) > 0) return null

  const aiResult = await aiRespond(query, { ...ctx, mention: true })
  if (aiResult?.text && aiResult.text.trim() !== '-') {
    try { db.logCommand(ctx, 'ai', query, 'mention') } catch {}
    const response = dedupeEmote(fixEmoteCase(aiResult.text, ctx.channel), ctx.channel)
    return ctx.user ? `${response} @${ctx.user}` : response
  }
  return null
}

export async function handleCommand(text: string, ctx: CommandContext = {}): Promise<string | null> {
  // strip leading @mention so !b works in Twitch replies
  const cleaned = text.replace(/^@\w+\s+/, '')
  const match = cleaned.match(/^!(\w+)\s*(.*)$/)
  if (!match) return handleMention(text, ctx)

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return handleMention(text, ctx)

  return handler(args.trim(), ctx)
}

export function resetDedup() {
  recentQueries.clear()
}

export function resetProxyCooldowns() {
  proxyCooldowns.clear()
}

export { PROXY_COOLDOWN }
