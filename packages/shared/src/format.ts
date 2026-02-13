import type { BazaarCard, TierName, ReplacementValue } from './types'

const TIER_ORDER: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']
const TIER_EMOJI: Record<string, string> = {
  Bronze: '🟤', Silver: '⚪', Gold: '🟡', Diamond: '💎', Legendary: '🟣',
}
const SIZE_ABBREV: Record<string, string> = { Small: 'Sm', Medium: 'Med', Large: 'Lg' }
const TIER_ABBREV = (tiers: string[]) => tiers.map((t) => t[0]).join('/')
const HERO_ABBREV: Record<string, string> = {
  Pygmalien: 'Pyg',
}
const MAX_LEN = 480

function truncate(str: string): string {
  if (str.length <= MAX_LEN) return str
  // cut at last pipe separator or space before limit
  const cut = str.lastIndexOf(' | ', MAX_LEN - 4)
  if (cut > MAX_LEN * 0.5) return str.slice(0, cut) + '...'
  const space = str.lastIndexOf(' ', MAX_LEN - 4)
  if (space > MAX_LEN * 0.5) return str.slice(0, space) + '...'
  return str.slice(0, MAX_LEN - 3) + '...'
}

function resolveReplacement(val: ReplacementValue, tier?: TierName): string {
  if ('Fixed' in val) return String(val.Fixed)
  if (tier && tier in val) return String((val as Record<string, number>)[tier])
  // show all tiers with emoji
  const parts = TIER_ORDER.filter((t) => t in val).map(
    (t) => `${TIER_EMOJI[t]}${(val as Record<string, number>)[t]}`,
  )
  return parts.join('/') || '?'
}

function resolveTooltip(text: string, replacements: Record<string, ReplacementValue>, tier?: TierName): string {
  return text.replace(/\{[^}]+\}/g, (match) => {
    const val = replacements[match]
    return val ? resolveReplacement(val, tier) : match
  })
}

function getAttributes(card: BazaarCard, tier?: TierName): Record<string, number> {
  const base = { ...card.BaseAttributes }
  if (tier && card.Tiers[tier]?.OverrideAttributes) {
    Object.assign(base, card.Tiers[tier].OverrideAttributes)
  }
  return base
}

export function formatItem(card: BazaarCard, tier?: TierName): string {
  const name = card.Title.Text
  const heroes = card.Heroes.map((h) => HERO_ABBREV[h] ?? h).join(', ')

  // resolve tooltips — no emoji prefix
  const abilities = card.Tooltips.map((t) =>
    resolveTooltip(t.Content.Text, card.TooltipReplacements, tier),
  )

  // compact stats with tier overrides applied
  const attrs = getAttributes(card, tier)
  const stats: string[] = []
  if (attrs.DamageAmount) stats.push(`🗡️${attrs.DamageAmount}`)
  if (attrs.ShieldApplyAmount) stats.push(`🛡${attrs.ShieldApplyAmount}`)
  if (attrs.HealAmount) stats.push(`💚${attrs.HealAmount}`)
  if (attrs.CooldownMax) stats.push(`🕐${attrs.CooldownMax / 1000}s`)

  const parts = [
    `${name}${heroes ? ` · ${heroes}` : ''}`,
    stats.length ? stats.join(' ') : null,
    ...abilities,
  ].filter(Boolean)

  return truncate(parts.join(' | '))
}

export function formatEnchantment(card: BazaarCard, enchName: string, tier?: TierName): string {
  const ench = card.Enchantments[enchName]
  if (!ench) return `No "${enchName}" enchantment for ${card.Title.Text}`

  const tooltips = ench.Localization.Tooltips.map((t) =>
    resolveTooltip(t.Content.Text, ench.TooltipReplacements, tier),
  )

  const tags = ench.Tags.length ? ` [${ench.Tags.join(', ')}]` : ''
  return truncate(`[${card.Title.Text} - ${enchName}]${tags} ${tooltips.join(' | ')}`)
}

export function formatCompare(a: BazaarCard, b: BazaarCard, tierA?: TierName, tierB?: TierName): string {
  const line = (c: BazaarCard, tier?: TierName) => {
    const attrs = getAttributes(c, tier)
    const parts = [c.Title.Text]
    if (attrs.DamageAmount) parts.push(`🗡️${attrs.DamageAmount}`)
    if (attrs.ShieldApplyAmount) parts.push(`🛡${attrs.ShieldApplyAmount}`)
    if (attrs.HealAmount) parts.push(`💚${attrs.HealAmount}`)
    if (attrs.CooldownMax) parts.push(`🕐${attrs.CooldownMax / 1000}s`)
    return parts.join(' ')
  }
  return truncate(`${line(a, tierA)} vs ${line(b, tierB)}`)
}
