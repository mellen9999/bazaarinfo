import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults, formatQuests } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import { respond as aiRespond } from './ai'
import { startTrivia, getTriviaScore, formatStats, formatTop } from './trivia'

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
let commandCount = 0

type SubHandler = (query: string, ctx: CommandContext, suffix: string) => string | null | Promise<string | null>

const subcommands: [RegExp, SubHandler][] = [
  [/^(?:mob|monster)\s+(.+)$/i, (query, ctx, suffix) => {
    const monster = store.findMonster(query)
    if (!monster) { logMiss(query, ctx); return `no monster found for ${query}` }
    logHit('mob', query, monster.Title.Text, ctx)
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }],
  [/^hero\s+(.+)$/i, (query, ctx, suffix) => {
    const items = store.byHero(query)
    if (items.length === 0) return `no items found for hero ${query}`
    logHit('hero', query, `${items.length} items`, ctx)
    const result = `[${query}] ${items.map((i) => i.Title.Text).join(', ')}` + suffix
    return result.length > 480 ? result.slice(0, 477) + '...' : result
  }],
  [/^enchant(?:s|ments)?$/i, (_query, ctx, suffix) => {
    const names = store.getEnchantments().map(capitalize)
    logHit('enchants', _query, `${names.length} enchants`, ctx)
    return `Enchantments: ${names.join(', ')}` + suffix
  }],
  [/^tag\s+(.+)$/i, (query, ctx, suffix) => {
    const cards = store.byTag(query)
    if (cards.length === 0) { logMiss(query, ctx); return `no items found with tag ${query}` }
    logHit('tag', query, `${cards.length} items`, ctx)
    return formatTagResults(query, cards) + suffix
  }],
  [/^day\s+(\d+)$/i, (query, ctx, suffix) => {
    const day = parseInt(query)
    if (day < 1 || day > 10) return `day must be 1-10`
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
  [/^trivia$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return startTrivia(ctx.channel) + suffix
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
    logHit('item', query, exactCard.Title.Text, ctx, tier)
    return formatItem(exactCard, tier) + suffix
  }

  const monster = store.findMonster(query)
  if (monster) {
    logHit('mob', query, monster.Title.Text, ctx)
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }

  const fuzzyCard = store.search(query, 1)[0]
  if (fuzzyCard) {
    logHit('item', query, fuzzyCard.Title.Text, ctx, tier)
    return formatItem(fuzzyCard, tier) + suffix
  }

  // AI fallback
  const aiResponse = await aiRespond(cleanArgs, ctx)
  if (aiResponse) {
    logHit('ai', cleanArgs, 'ai', ctx)
    return aiResponse + suffix
  }

  logMiss(query, ctx)
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
  const match = text.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  const result = await handler(args.trim(), ctx)
  if (result && ++commandCount % ATTRIB_INTERVAL === 0) {
    return result + ATTRIBUTION
  }
  return result
}
