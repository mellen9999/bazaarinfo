import { formatItem, formatEnchantment, formatCompare } from '@bazaarinfo/shared'
import type { TierName } from '@bazaarinfo/shared'
import * as store from './store'

type CommandHandler = (args: string) => string | null

const TIERS = ['bronze', 'silver', 'gold', 'diamond', 'legendary']
const ENCHANTMENTS = [
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

const BASE_USAGE = '!b <item> [tier] | !b <enchant> <item> [tier] | !b <item> vs <item> | !b hero <name>'
const JOIN_USAGE = () => lobbyChannel ? ` | !join in #${lobbyChannel} to add bot, !part to remove` : ''

function bazaarinfo(args: string): string | null {
  if (!args || args === 'help' || args === 'info') return BASE_USAGE + JOIN_USAGE()

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

  // compare: "x vs y"
  const vsParts = args.split(/\s+vs\s+/i)
  if (vsParts.length === 2 && vsParts[0] && vsParts[1]) {
    const a = store.exact(vsParts[0].trim()) ?? store.search(vsParts[0].trim(), 1)[0]
    const b = store.exact(vsParts[1].trim()) ?? store.search(vsParts[1].trim(), 1)[0]
    if (!a) return `no item found for ${vsParts[0].trim()}`
    if (!b) return `no item found for ${vsParts[1].trim()}`
    return formatCompare(a, b)
  }

  const words = args.split(/\s+/)
  const firstWord = words[0].toLowerCase()

  // enchantment: first word matches an enchantment name
  const enchMatches = ENCHANTMENTS.filter((e) => e.startsWith(firstWord))
  if (enchMatches.length === 1 && words.length > 1) {
    const rest = words.slice(1)
    const { query: itemQuery, tier } = parseTier(rest)
    const card = store.exact(itemQuery) ?? store.search(itemQuery, 1)[0]
    if (!card) return `no item found for ${itemQuery}`
    const key = enchMatches[0][0].toUpperCase() + enchMatches[0].slice(1)
    return formatEnchantment(card, key, tier)
  }

  // item lookup (optional tier as last word)
  const { query, tier } = parseTier(words)
  const card = store.exact(query) ?? store.search(query, 1)[0]
  if (!card) return `no item found for ${query}`
  return formatItem(card, tier)
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
  bazaarinfo,
  item: bazaarinfo,
  enchant: bazaarinfo,
  compare: bazaarinfo,
}

export function handleCommand(text: string): string | null {
  const match = text.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  return handler(args.trim())
}
