import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults, formatQuests, truncate } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import { respond as aiRespond } from './ai'
import { startTrivia, getTriviaScore, formatStats, formatTop } from './trivia'

const TIER_ORDER: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']

export interface CommandContext {
  user?: string
  channel?: string
}

type CommandHandler = (args: string, ctx: CommandContext) => string | null | Promise<string | null>

const TIERS = ['bronze', 'silver', 'gold', 'diamond', 'legendary']
// fallback if store hasn't loaded yet
const ENCHANTMENTS_FALLBACK = [
  'golden', 'heavy', 'icy', 'turbo', 'shielded', 'toxic',
  'fiery', 'deadly', 'radiant', 'obsidian', 'restorative', 'aegis',
]

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1)
}

interface ParsedArgs {
  item: string
  tier?: TierName
  enchant?: string
}

export function parseArgs(words: string[]): ParsedArgs {
  const enchList = store.getEnchantments().length > 0 ? store.getEnchantments() : ENCHANTMENTS_FALLBACK
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
  // require 3+ chars for prefix match to prevent "to"→toxic, "re"→restorative, etc.
  if (remaining.length > 1) {
    for (let i = 0; i < remaining.length; i++) {
      const lower = remaining[i].toLowerCase()
      const matches = enchList.filter((e) => e.startsWith(lower))
      if (matches.length === 1 && (lower === matches[0] || lower.length >= 3)) {
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

const BASE_USAGE = '!b <item> [tier] [enchant] | !b hero/mob/skill/tag/day/quest/enchants/trivia/score/stats | bazaardb.gg'
const JOIN_USAGE = () => lobbyChannel ? ` | add bot: type !join in ${lobbyChannel}'s chat` : ''

function logMiss(query: string, ctx: CommandContext) {
  try { db.logCommand(ctx, 'miss', query) } catch {}
}

function logHit(type: string, query: string, match: string, ctx: CommandContext, tier?: string) {
  try { db.logCommand(ctx, type as any, query, match, tier) } catch {}
}

function resolveSkills(monster: Monster): Map<string, SkillDetail> {
  const details = new Map<string, SkillDetail>()
  for (const b of monster.MonsterMetadata.board) {
    if (b.type !== 'Skill' || details.has(b.title)) continue
    const card = store.findCard(b.title)
    if (!card || !card.Tooltips.length) continue
    const tooltip = card.Tooltips.map((t) => t.Content.Text
      .replace(/\{[^}]+\}/g, (match) => {
        const val = card.TooltipReplacements[match]
        if (!val) return match
        if ('Fixed' in val) return String(val.Fixed)
        const tierVal = b.tierOverride in val ? (val as Record<string, number>)[b.tierOverride] : undefined
        return tierVal != null ? String(tierVal) : match
      }),
    ).join('; ')
    details.set(b.title, { name: b.title, tooltip })
  }
  return details
}

const ATTRIBUTION = ' | bazaardb.gg'
const ATTRIB_INTERVAL = 10
const AI_MARKER = '\x01'
let commandCount = 0

type SubHandler = (query: string, ctx: CommandContext, suffix: string) => string | null | Promise<string | null>

const subcommands: [RegExp, SubHandler][] = [
  [/^(?:mob|monster)$/i, () => 'usage: !b mob <name>'],
  [/^hero$/i, () => 'usage: !b hero <name>'],
  [/^tag$/i, () => 'usage: !b tag <tagname>'],
  [/^skill$/i, () => 'usage: !b skill <name>'],
  [/^quest$/i, () => 'usage: !b quest <item>'],
  [/^day$/i, () => 'usage: !b day <number>'],
  [/^(?:mob|monster)\s+(.+)$/i, (query, ctx, suffix) => {
    const monster = store.findMonster(query)
    if (!monster) {
      logMiss(query, ctx)
      const suggestions = store.suggest(query, 3)
      if (suggestions.length) return `no monster found for "${query}" — try: ${suggestions.join(', ')}`
      return `no monster found for ${query}`
    }
    logHit('mob', query, monster.Title.Text, ctx)
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }],
  [/^hero\s+(.+)$/i, (query, ctx, suffix) => {
    const resolved = store.findHeroName(query)
    const items = store.byHero(query)
    if (items.length === 0) return `no items found for hero ${query}`
    const displayName = resolved ?? query
    logHit('hero', query, `${items.length} items`, ctx)
    return truncate(`[${displayName}] ${items.map((i) => i.Title.Text).join(', ')}`) + suffix
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
    logHit('skill', query, skill.Title.Text, ctx)
    return formatItem(skill) + suffix
  }],
  [/^quest\s+(.+)$/i, (query, ctx, suffix) => {
    const words = query.split(/\s+/)
    const { item, tier } = parseArgs(words)
    const card = store.exact(item) ?? store.search(item, 1)[0]
    if (!card) { logMiss(query, ctx); return `no item found for ${query}` }
    logHit('quest', query, card.Title.Text, ctx, tier)
    return formatQuests(card, tier) + suffix
  }],
  [/^trivia(?:\s+(items|heroes|monsters))?$/i, (query, ctx, suffix) => {
    if (!ctx.channel) return null
    const category = query?.toLowerCase() as 'items' | 'heroes' | 'monsters' | undefined
    return startTrivia(ctx.channel, category || undefined) + suffix
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

function validateTier(card: { Tiers: Partial<Record<TierName, unknown>> }, tier?: TierName): { tier: TierName | undefined; note: string | null } {
  if (!tier) return { tier: undefined, note: null }
  if (tier in card.Tiers) return { tier, note: null }
  // find highest available tier
  const available = TIER_ORDER.filter((t) => t in card.Tiers)
  const highest = available[available.length - 1]
  if (highest) return { tier: highest, note: `max tier is ${highest}` }
  return { tier: undefined, note: null }
}

async function itemLookup(cleanArgs: string, ctx: CommandContext, suffix: string): Promise<string> {
  const words = cleanArgs.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return BASE_USAGE + JOIN_USAGE()

  if (enchant) {
    const card = store.exact(query) ?? store.search(query, 1)[0]
    if (!card) { logMiss(query, ctx); return `no item found for ${query}` }
    logHit('enchant', query, `${card.Title.Text}+${enchant}`, ctx, tier)
    return formatEnchantment(card, enchant, tier) + suffix
  }

  const exactCard = store.exact(query)
  if (exactCard) {
    const v = validateTier(exactCard, tier)
    logHit('item', query, exactCard.Title.Text, ctx, v.tier)
    const result = formatItem(exactCard, v.tier)
    return (v.note ? `${result} (${v.note})` : result) + suffix
  }

  const monster = store.findMonster(query)
  if (monster) {
    logHit('mob', query, monster.Title.Text, ctx)
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }

  const fuzzyCard = store.search(query, 1)[0]
  if (fuzzyCard) {
    const v = validateTier(fuzzyCard, tier)
    logHit('item', query, fuzzyCard.Title.Text, ctx, v.tier)
    const result = formatItem(fuzzyCard, v.tier)
    return (v.note ? `${result} (${v.note})` : result) + suffix
  }

  // check suggestions first — short queries with suggestions are likely misspellings
  const suggestions = store.suggest(query, 3)
  const wordCount = cleanArgs.split(/\s+/).length

  if (suggestions.length > 0 && wordCount <= 2) {
    logMiss(query, ctx)
    return `nothing found for "${query}" — try: ${suggestions.join(', ')}`
  }

  // AI fallback for longer/conversational queries
  const aiResponse = await aiRespond(cleanArgs, ctx)
  if (aiResponse) {
    logHit('ai', cleanArgs, 'ai', ctx)
    return AI_MARKER + aiResponse + suffix
  }

  logMiss(query, ctx)
  if (suggestions.length) return `nothing found for "${query}" — try: ${suggestions.join(', ')}`
  return `nothing found for ${query}`
}

async function bazaarinfo(args: string, ctx: CommandContext): Promise<string | null> {
  const mentions = args.match(/@\w+/g) ?? []
  const cleanArgs = args.replace(/@\w+/g, '').replace(/["']/g, '').replace(/\s+/g, ' ').trim()

  if (!cleanArgs || cleanArgs === 'help' || cleanArgs === 'info') return BASE_USAGE + JOIN_USAGE()

  const suffix = mentions.length ? ' ' + mentions.join(' ') : ''

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

  let result = await handler(args.trim(), ctx)
  if (!result) return null

  // strip AI marker and skip attribution for AI responses
  const isAi = result.startsWith(AI_MARKER)
  if (isAi) result = result.slice(1)

  // tag the user so responses are attributed in busy chat
  if (ctx.user) result = `${result} @${ctx.user}`

  if (!isAi && ++commandCount % ATTRIB_INTERVAL === 0) {
    return result + ATTRIBUTION
  }
  return result
}
