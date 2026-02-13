import type { BazaarCard, TierName, ReplacementValue } from './types'

const TIER_ORDER: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']

function resolveReplacement(val: ReplacementValue, tier?: TierName): string {
  if ('Fixed' in val) return String(val.Fixed)
  if (tier && tier in val) return String((val as Record<string, number>)[tier])
  // show all tiers
  const parts = TIER_ORDER.filter((t) => t in val).map(
    (t) => `${t[0]}:${(val as Record<string, number>)[t]}`,
  )
  return parts.join('/') || '?'
}

function resolveTooltip(text: string, replacements: Record<string, ReplacementValue>, tier?: TierName): string {
  return text.replace(/\{[^}]+\}/g, (match) => {
    const val = replacements[match]
    return val ? resolveReplacement(val, tier) : match
  })
}

export function formatItem(card: BazaarCard, tier?: TierName): string {
  const name = card.Title.Text
  const size = card.Size
  const heroes = card.Heroes.join(', ')
  const tiers = Object.keys(card.Tiers).join('/')

  // resolve tooltips
  const abilities = card.Tooltips.map((t) => {
    const text = resolveTooltip(t.Content.Text, card.TooltipReplacements, tier)
    const tag = t.TooltipType === 'Active' ? '⚡' : '🛡'
    return `${tag} ${text}`
  })

  // key stats
  const attrs = card.BaseAttributes
  const stats: string[] = []
  if (attrs.DamageAmount) stats.push(`DMG:${attrs.DamageAmount}`)
  if (attrs.ShieldApplyAmount) stats.push(`SHD:${attrs.ShieldApplyAmount}`)
  if (attrs.HealAmount) stats.push(`HEAL:${attrs.HealAmount}`)
  if (attrs.CooldownMax) stats.push(`CD:${attrs.CooldownMax / 1000}s`)
  if (attrs.BuyPrice) stats.push(`Buy:${attrs.BuyPrice}`)

  const parts = [
    `[${name}] ${size} | ${tiers} | ${heroes}`,
    stats.length ? stats.join(' ') : null,
    ...abilities,
  ].filter(Boolean)

  // twitch chat limit ~500 chars
  const result = parts.join(' | ')
  return result.length > 480 ? result.slice(0, 477) + '...' : result
}

export function formatItemShort(card: BazaarCard): string {
  return `[${card.Title.Text}] ${card.Size} ${Object.keys(card.Tiers).join('/')} - ${card.Heroes.join(', ')}`
}

export function formatEnchantment(card: BazaarCard, enchName: string, tier?: TierName): string {
  const ench = card.Enchantments[enchName]
  if (!ench) return `No "${enchName}" enchantment for ${card.Title.Text}`

  const tooltips = ench.Localization.Tooltips.map((t) =>
    resolveTooltip(t.Content.Text, ench.TooltipReplacements, tier),
  )

  const tags = ench.Tags.length ? ` [${ench.Tags.join(', ')}]` : ''
  return `[${card.Title.Text} - ${enchName}]${tags} ${tooltips.join(' | ')}`
}

export function formatCompare(a: BazaarCard, b: BazaarCard): string {
  const line = (c: BazaarCard) => {
    const attrs = c.BaseAttributes
    const parts = [`${c.Title.Text} (${c.Size})`]
    if (attrs.DamageAmount) parts.push(`DMG:${attrs.DamageAmount}`)
    if (attrs.ShieldApplyAmount) parts.push(`SHD:${attrs.ShieldApplyAmount}`)
    if (attrs.HealAmount) parts.push(`HEAL:${attrs.HealAmount}`)
    if (attrs.CooldownMax) parts.push(`CD:${attrs.CooldownMax / 1000}s`)
    return parts.join(' ')
  }
  return `${line(a)} vs ${line(b)}`
}
