import { formatItem, formatItemShort, formatEnchantment, formatCompare } from '@bazaarinfo/shared'
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

const commands: Record<string, CommandHandler> = {
  item(args) {
    if (!args) return 'usage: !item <name> [tier]'
    const parts = args.split(/\s+/)
    const { query, tier } = parseTier(parts)

    const card = store.exact(query) ?? store.search(query, 1)[0]
    if (!card) return `no item found for "${query}"`
    return formatItem(card, tier)
  },

  enc(args) {
    if (!args) return 'usage: !enc <type> [item]'
    const parts = args.split(/\s+/)
    const enchType = parts[0].toLowerCase()

    // find matching enchantment name
    const enchName = ENCHANTMENTS.find((e) => e.startsWith(enchType))
    if (!enchName) return `unknown enchantment "${enchType}". options: ${ENCHANTMENTS.join(', ')}`

    const itemQuery = parts.slice(1).join(' ')
    if (!itemQuery) return `usage: !enc ${enchName} <item>`

    const card = store.exact(itemQuery) ?? store.search(itemQuery, 1)[0]
    if (!card) return `no item found for "${itemQuery}"`

    const key = enchName[0].toUpperCase() + enchName.slice(1)
    return formatEnchantment(card, key)
  },

  hero(args) {
    if (!args) return 'usage: !hero <name>'
    const heroItems = store.byHero(args.trim())
    if (!heroItems.length) return `no items found for hero "${args}"`
    const names = heroItems.slice(0, 15).map((i) => i.Title.Text)
    const more = heroItems.length > 15 ? ` (+${heroItems.length - 15} more)` : ''
    return `[${args}] ${heroItems.length} items: ${names.join(', ')}${more}`
  },

  compare(args) {
    if (!args) return 'usage: !compare <item> vs <item>'
    const [aQuery, bQuery] = args.split(/\s+vs\s+/i)
    if (!aQuery || !bQuery) return 'usage: !compare <item> vs <item>'

    const a = store.exact(aQuery.trim()) ?? store.search(aQuery.trim(), 1)[0]
    const b = store.exact(bQuery.trim()) ?? store.search(bQuery.trim(), 1)[0]
    if (!a) return `no item found for "${aQuery.trim()}"`
    if (!b) return `no item found for "${bQuery.trim()}"`

    return formatCompare(a, b)
  },

  help() {
    return '!item <name> [tier] | !enc <type> <item> | !hero <name> | !compare <a> vs <b>'
  },
}

export function handleCommand(text: string): string | null {
  const match = text.match(/^!(\w+)\s*(.*)$/)
  if (!match) return null

  const [, cmd, args] = match
  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  return handler(args.trim())
}
