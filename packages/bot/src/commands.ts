import { formatItem, formatEnchantment, formatMonster } from '@bazaarinfo/shared'
import type { TierName } from '@bazaarinfo/shared'
import * as store from './store'
import { appendFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const MISS_LOG = resolve(homedir(), '.bazaarinfo-misses.log')

type CommandHandler = (args: string) => string | null

const TIERS = ['bronze', 'silver', 'gold', 'diamond', 'legendary']
// fallback if store hasn't loaded yet
const ENCHANTMENTS_FALLBACK = [
  'golden', 'heavy', 'icy', 'turbo', 'shielded', 'toxic',
  'fiery', 'deadly', 'radiant', 'obsidian', 'restorative', 'aegis',
]

function parseTier(args: string[]): { query: string; tier?: TierName } {
  const last = args[args.length - 1]?.toLowerCase()
  if (last && TIERS.includes(last)) {
    return {
      query: args.slice(0, -1).join(' '),
      tier: (last[0].toUpperCase() + last.slice(1)) as TierName,
    }
  }
  return { query: args.join(' ') }
}

let lobbyChannel = ''
export function setLobbyChannel(name: string) { lobbyChannel = name }

const BASE_USAGE = '!b <item> [tier] | !b <enchant> <item> [tier] | !b hero <name> | !b mob <name>'
const JOIN_USAGE = () => lobbyChannel ? ` | !join in #${lobbyChannel} to add bot, !part to remove` : ''

function bazaarinfo(args: string): string | null {
  if (!args || args === 'help' || args === 'info') return BASE_USAGE + JOIN_USAGE()

  // monster lookup: "mob lich" or "monster lich"
  const mobMatch = args.match(/^(?:mob|monster)\s+(.+)$/i)
  if (mobMatch) {
    const query = mobMatch[1].trim()
    const monster = store.findMonster(query)
    if (!monster) {
      try { appendFileSync(MISS_LOG, `${new Date().toISOString()} mob:${query}\n`) } catch {}
      return `no monster found for ${query}`
    }
    return formatMonster(monster)
  }

  // hero listing: "hero vanessa"
  const heroMatch = args.match(/^hero\s+(.+)$/i)
  if (heroMatch) {
    const heroName = heroMatch[1].trim()
    const items = store.byHero(heroName)
    if (items.length === 0) return `no items found for hero ${heroName}`
    const names = items.map((i) => i.Title.Text)
    const result = `[${heroName}] ${names.join(', ')}`
    return result.length > 480 ? result.slice(0, 477) + '...' : result
  }

  const words = args.split(/\s+/)
  const firstWord = words[0].toLowerCase()

  // enchantment: first word matches an enchantment name
  const enchList = store.getEnchantments().length > 0 ? store.getEnchantments() : ENCHANTMENTS_FALLBACK
  const enchMatches = enchList.filter((e) => e.startsWith(firstWord))
  if (enchMatches.length === 1 && words.length > 1) {
    const rest = words.slice(1)
    const { query: itemQuery, tier } = parseTier(rest)
    const card = store.exact(itemQuery) ?? store.search(itemQuery, 1)[0]
    if (!card) {
      try { appendFileSync(MISS_LOG, `${new Date().toISOString()} ${itemQuery}\n`) } catch {}
      return `no item found for ${itemQuery}`
    }
    const key = enchMatches[0][0].toUpperCase() + enchMatches[0].slice(1)
    return formatEnchantment(card, key, tier)
  }

  // item lookup (optional tier as last word)
  const { query, tier } = parseTier(words)

  // exact item/skill match wins
  const exactCard = store.exact(query)
  if (exactCard) return formatItem(exactCard, tier)

  // check monsters before fuzzy item search (avoids "lich" → "Lightbulb")
  const monster = store.findMonster(query)
  if (monster) return formatMonster(monster)

  // fuzzy item/skill search
  const fuzzyCard = store.search(query, 1)[0]
  if (fuzzyCard) return formatItem(fuzzyCard, tier)

  try { appendFileSync(MISS_LOG, `${new Date().toISOString()} ${query}\n`) } catch {}
  return `nothing found for ${query}`
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
  bazaarinfo,
  item: bazaarinfo,
  enchant: bazaarinfo,
}

export function handleCommand(text: string): string | null {
  const match = text.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  return handler(args.trim())
}
