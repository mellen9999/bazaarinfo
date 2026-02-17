import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail } from '@bazaarinfo/shared'
import * as store from './store'
import { appendFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const MISS_LOG = resolve(homedir(), '.bazaarinfo-misses.log')
const HIT_LOG = resolve(homedir(), '.bazaarinfo-hits.log')

interface CommandContext {
  user?: string
  channel?: string
}

type CommandHandler = (args: string, ctx: CommandContext) => string | null

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
  if (remaining.length > 1) {
    for (let i = 0; i < remaining.length; i++) {
      const lower = remaining[i].toLowerCase()
      const matches = enchList.filter((e) => e.startsWith(lower))
      if (matches.length === 1) {
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

const BASE_USAGE = '!b <item> [tier] [enchant] | !b hero/mob/skill/tag/day/enchants | bazaardb.gg'
const JOIN_USAGE = () => lobbyChannel ? ` | !join in #${lobbyChannel} to add bot, !part to remove` : ''

function logMiss(query: string, ctx: CommandContext, prefix = '') {
  const who = ctx.user ? ` user:${ctx.user}` : ''
  const where = ctx.channel ? ` ch:${ctx.channel}` : ''
  try { appendFileSync(MISS_LOG, `${new Date().toISOString()} ${prefix}${query}${who}${where}\n`) } catch {}
}

function logHit(type: string, query: string, match: string, ctx: CommandContext, tier?: string) {
  const parts = [
    new Date().toISOString(),
    `type:${type}`,
    `q:${query}`,
    `match:${match}`,
    tier ? `tier:${tier}` : null,
    ctx.user ? `user:${ctx.user}` : null,
    ctx.channel ? `ch:${ctx.channel}` : null,
  ].filter(Boolean).join(' ')
  try { appendFileSync(HIT_LOG, parts + '\n') } catch {}
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

function bazaarinfo(args: string, ctx: CommandContext): string | null {
  // extract @mentions to append to response
  const mentions = args.match(/@\w+/g) ?? []
  const cleanArgs = args.replace(/@\w+/g, '').replace(/\s+/g, ' ').trim()

  if (!cleanArgs || cleanArgs === 'help' || cleanArgs === 'info') return BASE_USAGE + JOIN_USAGE()

  const suffix = mentions.length ? ' ' + mentions.join(' ') : ''

  // monster lookup: "mob lich" or "monster lich"
  const mobMatch = cleanArgs.match(/^(?:mob|monster)\s+(.+)$/i)
  if (mobMatch) {
    const query = mobMatch[1].trim()
    const monster = store.findMonster(query)
    if (!monster) {
      logMiss(query, ctx, 'mob:')
      return `no monster found for ${query}`
    }
    logHit('mob', query, monster.Title.Text, ctx)
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }

  // hero listing: "hero vanessa"
  const heroMatch = cleanArgs.match(/^hero\s+(.+)$/i)
  if (heroMatch) {
    const heroName = heroMatch[1].trim()
    const items = store.byHero(heroName)
    if (items.length === 0) return `no items found for hero ${heroName}`
    logHit('hero', heroName, `${items.length} items`, ctx)
    const names = items.map((i) => i.Title.Text)
    const result = `[${heroName}] ${names.join(', ')}` + suffix
    return result.length > 480 ? result.slice(0, 477) + '...' : result
  }

  // enchant list: "enchants" or "enchantments"
  if (/^enchant(?:s|ments)?$/i.test(cleanArgs)) {
    const names = store.getEnchantments().map(capitalize)
    logHit('enchants', cleanArgs, `${names.length} enchants`, ctx)
    return `Enchantments: ${names.join(', ')}` + suffix
  }

  // tag search: "tag burn"
  const tagMatch = cleanArgs.match(/^tag\s+(.+)$/i)
  if (tagMatch) {
    const tag = tagMatch[1].trim()
    const cards = store.byTag(tag)
    if (cards.length === 0) {
      logMiss(tag, ctx, 'tag:')
      return `no items found with tag ${tag}`
    }
    logHit('tag', tag, `${cards.length} items`, ctx)
    return formatTagResults(tag, cards) + suffix
  }

  // day lookup: "day 5"
  const dayMatch = cleanArgs.match(/^day\s+(\d+)$/i)
  if (dayMatch) {
    const day = parseInt(dayMatch[1])
    if (day < 1 || day > 10) return `day must be 1-10`
    const mobs = store.monstersByDay(day)
    if (mobs.length === 0) {
      logMiss(String(day), ctx, 'day:')
      return `no monsters found for day ${day}`
    }
    logHit('day', String(day), `${mobs.length} monsters`, ctx)
    return formatDayResults(day, mobs) + suffix
  }

  // skill lookup: "skill ink blast"
  const skillMatch = cleanArgs.match(/^skill\s+(.+)$/i)
  if (skillMatch) {
    const query = skillMatch[1].trim()
    const skill = store.findSkill(query)
    if (!skill) {
      logMiss(query, ctx, 'skill:')
      return `no skill found for ${query}`
    }
    logHit('skill', query, skill.Title.Text, ctx)
    return formatItem(skill) + suffix
  }

  // order-agnostic parse: tier and enchant can be anywhere
  const words = cleanArgs.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return BASE_USAGE + JOIN_USAGE()

  // enchantment route
  if (enchant) {
    const card = store.exact(query) ?? store.search(query, 1)[0]
    if (!card) {
      logMiss(query, ctx)
      return `no item found for ${query}`
    }
    logHit('enchant', query, `${card.Title.Text}+${enchant}`, ctx, tier)
    return formatEnchantment(card, enchant, tier) + suffix
  }

  // exact item/skill match wins
  const exactCard = store.exact(query)
  if (exactCard) {
    logHit('item', query, exactCard.Title.Text, ctx, tier)
    return formatItem(exactCard, tier) + suffix
  }

  // check monsters before fuzzy item search (avoids "lich" → "Lightbulb")
  const monster = store.findMonster(query)
  if (monster) {
    logHit('mob', query, monster.Title.Text, ctx)
    return formatMonster(monster, resolveSkills(monster)) + suffix
  }

  // fuzzy item/skill search
  const fuzzyCard = store.search(query, 1)[0]
  if (fuzzyCard) {
    logHit('item', query, fuzzyCard.Title.Text, ctx, tier)
    return formatItem(fuzzyCard, tier) + suffix
  }

  logMiss(query, ctx)
  return `nothing found for ${query}`
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
}

export function handleCommand(text: string, ctx: CommandContext = {}): string | null {
  const match = text.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  const result = handler(args.trim(), ctx)
  if (result && ++commandCount % ATTRIB_INTERVAL === 0) {
    return result + ATTRIBUTION
  }
  return result
}
