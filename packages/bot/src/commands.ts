import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults, truncate, resolveTooltip, TIER_ORDER } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import { startTrivia, getTriviaScore, formatStats, formatTop, invalidateAliasCache } from './trivia'
import { aiRespond } from './ai'

const ALIAS_ADMINS = new Set(['tidolar'])

export interface CommandContext {
  user?: string
  channel?: string
  privileged?: boolean
}

type CommandHandler = (args: string, ctx: CommandContext) => string | null | Promise<string | null>

const TIERS = ['bronze', 'silver', 'gold', 'diamond', 'legendary']

function capitalize(s: string): string {
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
  if (remaining.length > 1) {
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

const BASE_USAGE = '!b <item> [tier] [enchant] | !b hero/mob/skill/tag/day/enchants/trivia/score/stats | bazaardb.gg'
const JOIN_USAGE = () => lobbyChannel ? ` | add bot: type !join in ${lobbyChannel}'s chat` : ''

function logMiss(query: string, ctx: CommandContext) {
  try { db.logCommand(ctx, 'miss', query) } catch {}
}

function logHit(type: string, query: string, match: string, ctx: CommandContext, tier?: string) {
  try { db.logCommand(ctx, type as any, query, match, tier) } catch {}
}

function resolveSkills(monster: Monster): Map<string, SkillDetail> {
  const details = new Map<string, SkillDetail>()
  for (const s of monster.MonsterMetadata.skills) {
    if (details.has(s.title)) continue
    const card = store.findCard(s.title)
    if (!card || !card.Tooltips.length) continue
    const tooltip = card.Tooltips.map((t) =>
      resolveTooltip(t.text, card.TooltipReplacements, s.tier as TierName),
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
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }],
  [/^hero\s+(.+)$/i, (query, ctx, suffix) => {
    const resolved = store.findHeroName(query)
    const items = store.byHero(query)
    if (items.length === 0) return `no items found for hero ${query}`
    const displayName = resolved ?? query
    logHit('hero', query, `${items.length} items`, ctx)
    return truncate(`[${displayName}] ${items.map((i) => i.Title).join(', ')}`) + suffix
  }],
  [/^enchant(?:s|ments)?$/i, (_query, ctx, suffix) => {
    const names = store.getEnchantments().map(capitalize)
    logHit('enchants', _query, `${names.length} enchants`, ctx)
    return `Enchantments: ${names.join(', ')}` + suffix
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
    return formatTagResults(displayTag, cards) + suffix
  }],
  [/^day\s+(\d+)$/i, (query, ctx, suffix) => {
    const day = parseInt(query)
    if (day < 1 || day > 99) return `invalid day number`
    const mobs = store.monstersByDay(day)
    if (mobs.length === 0) { logMiss(query, ctx); return `no monsters found for day ${day}` }
    logHit('day', query, `${mobs.length} monsters`, ctx)
    return formatDayResults(day, mobs) + suffix
  }],
  [/^skill\s+(.+)$/i, (query, ctx, suffix) => {
    const skill = store.findSkill(query)
    if (!skill) { logMiss(query, ctx); return `no skill found for ${query}` }
    logHit('skill', query, skill.Title, ctx)
    return formatItem(skill) + suffix
  }],
  [/^trivia(?:\s+(items|heroes|monsters))?$/i, (query, ctx, suffix) => {
    if (!ctx.channel) return null
    const validCategories = new Set(['items', 'heroes', 'monsters'])
    const category = validCategories.has(query?.toLowerCase()) ? query.toLowerCase() as 'items' | 'heroes' | 'monsters' : undefined
    return startTrivia(ctx.channel, category) + suffix
  }],
  [/^score$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return getTriviaScore(ctx.channel) + suffix
  }],
  [/^stats(?:\s+@?(\S+))?$/i, (query, ctx, suffix) => {
    const target = query || ctx.user
    if (!target) return null
    return formatStats(target) + suffix
  }],
  [/^top$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return formatTop(ctx.channel) + suffix
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

async function itemLookup(cleanArgs: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  const words = cleanArgs.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return BASE_USAGE + JOIN_USAGE()

  if (enchant) {
    const card = store.exact(query) ?? store.search(query, 1)[0]
    if (!card) { logMiss(query, ctx); return `no item found for ${query}` }
    logHit('enchant', query, `${card.Title}+${enchant}`, ctx, tier)
    return formatEnchantment(card, enchant, tier) + suffix
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
    return (v.note ? `${result} (${v.note})` : result) + suffix
  }

  const monster = store.findMonster(query)
  if (monster && isRelevantMatch(monster.Title)) {
    logHit('mob', query, monster.Title, ctx)
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }

  // suggestions for short typo queries, silence for everything else
  const suggestions = store.suggest(query, 3)

  logMiss(query, ctx)
  if (suggestions.length > 0 && queryWords.length <= 2) {
    return `nothing found for "${query}" — try: ${suggestions.join(', ')}` + suffix
  }

  // AI fallback on miss
  const aiResult = await aiRespond(cleanArgs, ctx)
  if (aiResult) {
    logHit('ai', cleanArgs, 'ai', ctx)
    // collect mentions: AI-generated + original message, dedupe, append at end
    // skip @asker if their name already appears in the response body
    const allMentions = new Set<string>()
    const textLower = aiResult.text.toLowerCase()
    const userLower = ctx.user?.toLowerCase() ?? ''
    const alreadyNamed = userLower && new RegExp(`\\b${userLower}\\b`).test(textLower)
    if (ctx.user && !alreadyNamed) allMentions.add(`@${ctx.user}`)
    for (const m of aiResult.mentions) {
      if (m.toLowerCase() !== `@${userLower}`) allMentions.add(m)
    }
    for (const m of (suffix.match(/@\w+/g) ?? [])) allMentions.add(m.toLowerCase())
    const tags = allMentions.size > 0 ? ' ' + [...allMentions].join(' ') : ''
    return aiResult.text + tags
  }

  return `nothing found for "${query}"` + suffix
}

async function bazaarinfo(args: string, ctx: CommandContext): Promise<string | null> {
  const mentions = args.match(/@\w+/g) ?? []
  const cleanArgs = args.replace(/@\w+/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim()

  if (!cleanArgs || cleanArgs === 'help' || cleanArgs === 'info') return BASE_USAGE + JOIN_USAGE()

  const suffix = mentions.length ? ' ' + mentions.join(' ') : ''

  // alias add: !b alias <slang> = <target>
  const aliasAdd = cleanArgs.match(/^alias\s+(.+?)\s*=\s*(.+)$/i)
  if (aliasAdd) {
    if (!ctx.user || !ALIAS_ADMINS.has(ctx.user)) return 'alias management is restricted'
    const aliasKey = aliasAdd[1].trim().toLowerCase()
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
