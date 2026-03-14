import type { BazaarCard, TierName, ReplacementValue, Monster } from './types'

export const TIER_ORDER: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']
const TIER_EMOJI: Record<string, string> = {
  Bronze: '🟤', Silver: '⚪', Gold: '🟡', Diamond: '💎', Legendary: '🟣',
}
const HERO_ABBREV: Record<string, string> = {
  Pygmalien: 'Pyg',
}
const MAX_LEN = 480

// hoisted: compiled once at module load, not per call
const RE_PLACEHOLDER = /\{[^}]+\}/g
const RE_SECONDS_PARENS = /(\d+) second\(s\)/g
const RE_SECONDS = /(\d+) seconds?\b/g
const RE_ITEMS_PARENS = /\bitem\(s\)/g
const RE_EVERY = /\bEvery (\S+),/g
const RE_FOR_THE_FIGHT = /\bfor the fight\b/gi
const RE_FOR_EACH = /\bfor each\b/gi
const RE_START_OF_DAY = /\bat the start of each day,?\s*/gi
const RE_SELL_OR_BUY = /\bWhen you sell or buy:?\s*/gi
const RE_SELL_BUY_THIS = /\bWhen you (sell|buy) this,?\s*/gi
const RE_SELL_BUY = /\bWhen you (sell|buy):?\s*/gi
const RE_RANDOM_ENEMY = /\ba random enemy\b/g
const RE_HTTPS = /https:\/\//

function tierPrefix(tier?: TierName): string {
  return tier ? `${TIER_EMOJI[tier]} ` : ''
}

export function truncate(str: string): string {
  if (str.length <= MAX_LEN) return str
  const cut = str.lastIndexOf(' | ', MAX_LEN - 4)
  if (cut > MAX_LEN * 0.5) return str.slice(0, cut) + '...'
  const space = str.lastIndexOf(' ', MAX_LEN - 4)
  if (space > MAX_LEN * 0.5) return str.slice(0, space) + '...'
  return str.slice(0, MAX_LEN - 3) + '...'
}

function resolveReplacement(val: ReplacementValue, tier?: TierName): string {
  if (typeof val !== 'object' || val === null) return String(val)
  if ('Fixed' in val) return String(val.Fixed)
  // compute available tiers once — used for both fallback lookup and display path
  const available = TIER_ORDER.filter((t) => t in val)
  if (tier) {
    if (tier in val) {
      const v = (val as Record<string, number>)[tier]
      return v != null ? String(v) : '?'
    }
    // Legendary falls back to Diamond, etc. — use highest available tier
    if (available.length) {
      const v = (val as Record<string, number>)[available[available.length - 1]]
      return v != null ? String(v) : '?'
    }
  }
  const parts = available.map((t) => `${TIER_EMOJI[t]}${(val as Record<string, number>)[t]}`)
  return parts.join('/') || '?'
}

export function resolveTooltip(text: string, replacements: Record<string, ReplacementValue>, tier?: TierName): string {
  return text.replace(RE_PLACEHOLDER, (match) => {
    const val = replacements[match]
    return val ? resolveReplacement(val, tier) : match
  })
}

// compress resolved tooltip text for tighter chat output
export function compressTooltip(text: string): string {
  return text
    .replace(RE_SECONDS_PARENS, '$1s')           // "3 second(s)" → "3s"
    .replace(RE_SECONDS, '$1s')                  // "3 seconds" → "3s"
    .replace(RE_ITEMS_PARENS, 'items')
    .replace(RE_EVERY, '[$1]')                   // "Every 3s," → "[3s]"
    .replace(RE_FOR_THE_FIGHT, '(fight)')
    .replace(RE_FOR_EACH, 'per')
    .replace(RE_START_OF_DAY, 'Daily: ')
    .replace(RE_SELL_OR_BUY, 'On sell/buy: ')
    .replace(RE_SELL_BUY_THIS, 'On $1: ')
    .replace(RE_SELL_BUY, 'On $1: ')
    .replace(RE_RANDOM_ENEMY, 'random enemy')
}

const SIZE_LABEL: Record<string, string> = { Small: 'S', Medium: 'M', Large: 'L' }

function appendShortlink(text: string, shortlink?: string): string {
  if (!shortlink) return text
  const suffix = ` · ${shortlink.replace(RE_HTTPS, '')}`
  if (text.length + suffix.length <= MAX_LEN) return text + suffix
  return text
}

export function formatItem(card: BazaarCard, tier?: TierName): string {
  const prefix = tierPrefix(tier)
  const name = card.Title
  const size = SIZE_LABEL[card.Size] ? ` [${SIZE_LABEL[card.Size]}]` : ''
  const heroes = card.Heroes.map((h) => HERO_ABBREV[h] ?? h).join(', ')
  const abilities = card.Tooltips.map((t) =>
    compressTooltip(resolveTooltip(t.text, card.TooltipReplacements, tier)),
  )

  const tags = card.DisplayTags?.length ? ` [${card.DisplayTags.join(', ')}]` : ''

  const parts = [
    `${prefix}${name}${size}${heroes ? ` · ${heroes}` : ''}${tags}`,
    ...abilities,
  ].filter(Boolean)

  const result = truncate(parts.join(' | '))
  return appendShortlink(result, card.Shortlink)
}

export function formatTagResults(tag: string, cards: BazaarCard[]): string {
  if (cards.length === 0) return `no items found with tag ${tag}`
  const names = cards.map((c) => c.Title)
  return truncate(`[${tag}] ${names.join(', ')}`)
}

export function formatDayResults(day: number, monsters: Monster[]): string {
  if (monsters.length === 0) return `no monsters found for day ${day}`
  const entries = monsters.map((m) => `${m.Title} (${m.MonsterMetadata.health}HP)`)
  return truncate(`[Day ${day}] ${entries.join(', ')}`)
}

export function formatEnchantment(card: BazaarCard, enchName: string, tier?: TierName): string {
  const ench = card.Enchantments[enchName]
  if (!ench) return `No "${enchName}" enchantment for ${card.Title}`

  const tooltips = ench.tooltips.map((t) =>
    compressTooltip(resolveTooltip(t.text, ench.tooltipReplacements ?? {}, tier)),
  )

  const tags = ench.tags?.length ? ` [${ench.tags.join(', ')}]` : ''
  const result = truncate(`${tierPrefix(tier)}[${card.Title} - ${enchName}]${tags} ${tooltips.join(' | ')}`)
  return appendShortlink(result, card.Shortlink)
}

export interface SkillDetail {
  name: string
  tooltip: string
}

export function formatMonster(monster: Monster, skillDetails?: Map<string, SkillDetail>): string {
  const meta = monster.MonsterMetadata
  const day = meta.day != null ? `Day ${meta.day}` : meta.available || '?'
  const hp = meta.health

  const items: string[] = []
  const skills: string[] = []
  const boardGroups = new Map<string, { label: string; count: number }>()

  for (const b of meta.board) {
    const key = `${b.title}|${b.tier}`
    const existing = boardGroups.get(key)
    if (existing) existing.count++
    else boardGroups.set(key, { label: `${TIER_EMOJI[b.tier] ?? ''}${b.title}`, count: 1 })
  }

  for (const { label, count } of boardGroups.values()) {
    items.push(count > 1 ? `${label} x${count}` : label)
  }

  for (const s of meta.skills) {
    const emoji = TIER_EMOJI[s.tier] ?? ''
    if (skillDetails?.has(s.title)) {
      const detail = skillDetails.get(s.title)!
      skills.push(`${emoji}${s.title}: ${detail.tooltip}`)
    } else {
      skills.push(`${emoji}${s.title}`)
    }
  }

  const parts = [
    `${monster.Title} · ${day} · ${hp}HP`,
    items.length ? items.join(', ') : null,
    ...skills,
  ].filter(Boolean)

  const result = truncate(parts.join(' | '))
  return appendShortlink(result, monster.Shortlink)
}
