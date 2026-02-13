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

const BASE_USAGE = '!b <item> [tier] [enchant] | !b hero <name> | !b mob <name> | data: bazaardb.gg'
const JOIN_USAGE = () => lobbyChannel ? ` | !join in #${lobbyChannel} to add bot, !part to remove` : ''

function logMiss(query: string, prefix = '') {
  try { appendFileSync(MISS_LOG, `${new Date().toISOString()} ${prefix}${query}\n`) } catch {}
}

function bazaarinfo(args: string): string | null {
  if (!args || args === 'help' || args === 'info') return BASE_USAGE + JOIN_USAGE()

  // monster lookup: "mob lich" or "monster lich"
  const mobMatch = args.match(/^(?:mob|monster)\s+(.+)$/i)
  if (mobMatch) {
    const query = mobMatch[1].trim()
    const monster = store.findMonster(query)
    if (!monster) {
      logMiss(query, 'mob:')
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

  // order-agnostic parse: tier and enchant can be anywhere
  const words = args.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return BASE_USAGE + JOIN_USAGE()

  // enchantment route
  if (enchant) {
    const card = store.exact(query) ?? store.search(query, 1)[0]
    if (!card) {
      logMiss(query)
      return `no item found for ${query}`
    }
    return formatEnchantment(card, enchant, tier)
  }

  // exact item/skill match wins
  const exactCard = store.exact(query)
  if (exactCard) return formatItem(exactCard, tier)

  // check monsters before fuzzy item search (avoids "lich" → "Lightbulb")
  const monster = store.findMonster(query)
  if (monster) return formatMonster(monster)

  // fuzzy item/skill search
  const fuzzyCard = store.search(query, 1)[0]
  if (fuzzyCard) return formatItem(fuzzyCard, tier)

  logMiss(query)
  return `nothing found for ${query}`
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
}

export function handleCommand(text: string): string | null {
  const match = text.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  return handler(args.trim())
}
