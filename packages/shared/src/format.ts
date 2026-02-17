import type { BazaarCard, TierName, ReplacementValue, Monster, Quest } from './types'

const TIER_ORDER: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']
const TIER_EMOJI: Record<string, string> = {
  Bronze: '🟤', Silver: '⚪', Gold: '🟡', Diamond: '💎', Legendary: '🟣',
}
const HERO_ABBREV: Record<string, string> = {
  Pygmalien: 'Pyg',
}
const MAX_LEN = 480

function tierPrefix(tier?: TierName): string {
  return tier ? `${TIER_EMOJI[tier]} ` : ''
}

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

interface StatEntry {
  key: string
  emoji: string
  format?: 'ms' | 'pct'
  minShow?: number
}

const STAT_CONFIG: StatEntry[] = [
  { key: 'DamageAmount', emoji: '🗡️' },
  { key: 'ShieldApplyAmount', emoji: '🛡' },
  { key: 'HealAmount', emoji: '💚' },
  { key: 'BurnApplyAmount', emoji: '🔥' },
  { key: 'PoisonApplyAmount', emoji: '🧪' },
  { key: 'FreezeAmount', emoji: '🧊', format: 'ms' },
  { key: 'SlowAmount', emoji: '🐌', format: 'ms' },
  { key: 'HasteAmount', emoji: '⚡', format: 'ms' },
  { key: 'RegenApplyAmount', emoji: '🌿' },
  { key: 'Lifesteal', emoji: '🩸', format: 'pct' },
  { key: 'CritChance', emoji: '🎯', format: 'pct' },
  { key: 'Multicast', emoji: '🔁', minShow: 2 },
  { key: 'AmmoMax', emoji: '🔋' },
  { key: 'ChargeAmount', emoji: '⏳', format: 'ms' },
  { key: 'CooldownMax', emoji: '🕐', format: 'ms' },
]

function fmtVal(v: number, format?: 'ms' | 'pct'): string {
  if (format === 'ms') return v / 1000 + 's'
  if (format === 'pct') return v + '%'
  return String(v)
}

function formatStat(emoji: string, key: string, base: number, card: BazaarCard, tier?: TierName, format?: 'ms' | 'pct'): string {
  const val = tier ? (getAttributes(card, tier)[key] ?? base) : base
  if (tier) return `${emoji}${fmtVal(val, format)}`

  // no tier specified — show tier range if values differ
  const tierVals = TIER_ORDER
    .filter((t) => t in card.Tiers)
    .map((t) => card.Tiers[t]?.OverrideAttributes?.[key])
    .filter((v) => v != null) as number[]

  if (tierVals.length === 0 || tierVals.every((v) => v === base)) {
    return `${emoji}${fmtVal(base, format)}`
  }

  const allVals = [base, ...tierVals]
  const unique = [...new Set(allVals)]
  return `${emoji}${unique.map((v) => fmtVal(v, format)).join('/')}`
}

function statLine(attrs: Record<string, number>, card: BazaarCard, tier?: TierName): string {
  const s: string[] = []
  for (const { key, emoji, format, minShow } of STAT_CONFIG) {
    const val = attrs[key]
    if (val == null) continue
    if (minShow != null && val < minShow) continue
    s.push(formatStat(emoji, key, val, card, tier, format))
  }
  return s.join(' ')
}

const SIZE_LABEL: Record<string, string> = { Small: 'S', Medium: 'M', Large: 'L' }

export function formatItem(card: BazaarCard, tier?: TierName): string {
  const prefix = tierPrefix(tier)
  const name = card.Title.Text
  const size = SIZE_LABEL[card.Size] ? ` [${SIZE_LABEL[card.Size]}]` : ''
  const heroes = card.Heroes.map((h) => HERO_ABBREV[h] ?? h).join(', ')
  const abilities = card.Tooltips.map((t) =>
    resolveTooltip(t.Content.Text, card.TooltipReplacements, tier),
  )
  const stats = statLine(getAttributes(card, tier), card, tier)

  const tags = card.DisplayTags?.length ? ` [${card.DisplayTags.join(', ')}]` : ''

  const questHint = card.Quests?.length ? `!b quest ${name} for quests` : null

  const parts = [
    `${prefix}${name}${size}${heroes ? ` · ${heroes}` : ''}${tags}`,
    stats || null,
    ...abilities,
    questHint,
  ].filter(Boolean)

  return truncate(parts.join(' | '))
}

export function formatTagResults(tag: string, cards: BazaarCard[]): string {
  if (cards.length === 0) return `no items found with tag ${tag}`
  const names = cards.map((c) => c.Title.Text)
  return truncate(`[${tag}] ${names.join(', ')}`)
}

export function formatDayResults(day: number, monsters: Monster[]): string {
  if (monsters.length === 0) return `no monsters found for day ${day}`
  const entries = monsters.map((m) => `${m.Title.Text} (${m.MonsterMetadata.health}HP)`)
  return truncate(`[Day ${day}] ${entries.join(', ')}`)
}

export function formatEnchantment(card: BazaarCard, enchName: string, tier?: TierName): string {
  const ench = card.Enchantments[enchName]
  if (!ench) return `No "${enchName}" enchantment for ${card.Title.Text}`

  const tooltips = ench.Localization.Tooltips.map((t) =>
    resolveTooltip(t.Content.Text, ench.TooltipReplacements, tier),
  )

  const tags = ench.Tags.length ? ` [${ench.Tags.join(', ')}]` : ''
  return truncate(`${tierPrefix(tier)}[${card.Title.Text} - ${enchName}]${tags} ${tooltips.join(' | ')}`)
}

export interface SkillDetail {
  name: string
  tooltip: string
}

export function formatMonster(monster: Monster, skillDetails?: Map<string, SkillDetail>): string {
  const meta = monster.MonsterMetadata
  const day = meta.day != null ? `Day ${meta.day}` : meta.available || '?'
  const hp = meta.health

  // separate items and skills
  const items: string[] = []
  const skills: string[] = []
  const itemCounts = new Map<string, number>()
  const itemLabels = new Map<string, string>()

  for (const b of meta.board) {
    const key = `${b.title}|${b.tierOverride}`
    const emoji = TIER_EMOJI[b.tierOverride] ?? ''

    if (b.type === 'Skill' && skillDetails?.has(b.title)) {
      const detail = skillDetails.get(b.title)!
      skills.push(`${emoji}${b.title}: ${detail.tooltip}`)
    } else {
      itemCounts.set(key, (itemCounts.get(key) ?? 0) + 1)
      if (!itemLabels.has(key)) itemLabels.set(key, `${emoji}${b.title}`)
    }
  }

  for (const [key, label] of itemLabels) {
    const count = itemCounts.get(key)!
    items.push(count > 1 ? `${label} x${count}` : label)
  }

  const parts = [
    `${monster.Title.Text} · ${day} · ${hp}HP`,
    items.length ? items.join(', ') : null,
    ...skills,
  ].filter(Boolean)

  return truncate(parts.join(' | '))
}

export function formatQuests(card: BazaarCard, tier?: TierName): string {
  if (!card.Quests?.length) return `${card.Title.Text} has no quests`

  const questLines = card.Quests.map((q) => {
    const entry = q.Entries[0]
    if (!entry) return null
    const req = entry.Localization.Tooltips[0]?.Content.Text
    if (!req) return null
    const reward = entry.Reward.Localization.Tooltips
      .map((t) => resolveTooltip(t.Content.Text, entry.Reward.TooltipReplacements, tier))
      .join('; ')
    return `${req} → ${reward}`
  }).filter(Boolean)

  if (questLines.length === 0) return `${card.Title.Text} has no quests`
  return truncate(`[${card.Title.Text}] Quests: ${questLines.join(' | ')}`)
}
