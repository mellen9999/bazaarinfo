// The search surface's filter chips, as plain data. Each chip is one of these keys
// and holds either a value or null ("any"); a card must match every chip that is set.
// Kept free of the UI so the rules are testable and the panel and the overlay cannot
// disagree about what "gold" or "neutral" means.

import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import type { I18n } from './i18n'

export type FilterKey = 'hero' | 'type' | 'size' | 'tier'
export type Filters = Record<FilterKey, string | null>

export const FILTER_KEYS: readonly FilterKey[] = ['hero', 'type', 'size', 'tier']
export const NO_FILTERS: Filters = { hero: null, type: null, size: null, tier: null }

// Where the data says a card belongs to no hero. Shown as "neutral" — the viewer's
// word for it — but compared as the dump spells it.
const NEUTRAL = 'Common'

// Natural order, not alphabetical: "large" before "medium" is nobody's mental model.
const SIZES = ['Small', 'Medium', 'Large']
const TIERS: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']
const TYPES = ['Item', 'Skill']

export function hasFilter(f: Filters): boolean {
  return FILTER_KEYS.some((k) => f[k] !== null)
}

// The chip's own name: the game's word when it has one, else the key as we spell it.
const FILTER_WORD: Record<FilterKey, string> = { hero: 'Hero', type: 'Type', size: 'Size', tier: 'Tier' }
export function filterName(key: FilterKey, i18n: I18n): string {
  return i18n.has(FILTER_WORD[key]) ? i18n.word(FILTER_WORD[key]) : key
}

export function filterLabel(key: FilterKey, value: string, i18n: I18n): string {
  // "neutral" is our word, not the game's: only swap it if the game has a word for Common
  if (key === 'hero' && value === NEUTRAL) return i18n.has(NEUTRAL) ? i18n.word(NEUTRAL) : 'neutral'
  return i18n.word(value)
}

// Only values that exist in the loaded data, so a chip can never cycle into an empty
// list because the dump has no Legendary skills (or a new hero arrives unannounced).
export function filterOptions(cards: BazaarCard[]): Record<FilterKey, string[]> {
  const heroes = new Set<string>()
  const types = new Set<string>()
  const sizes = new Set<string>()
  const tiers = new Set<string>()
  for (const c of cards) {
    for (const h of c.Heroes ?? []) heroes.add(h)
    types.add(c.Type)
    sizes.add(c.Size)
    for (const t of c.Tiers ?? []) tiers.add(t)
  }
  const heroList = [...heroes].filter((h) => h !== NEUTRAL).sort()
  if (heroes.has(NEUTRAL)) heroList.push(NEUTRAL)
  return {
    hero: heroList,
    type: TYPES.filter((t) => types.has(t)),
    size: SIZES.filter((s) => sizes.has(s)),
    tier: TIERS.filter((t) => tiers.has(t)),
  }
}

// any -> first -> ... -> last -> any, or the same walked backwards. A value that is
// no longer offered (data refreshed under the chip) steps from "any".
export function cycleValue(options: string[], current: string | null, dir: 1 | -1 = 1): string | null {
  if (options.length === 0) return null
  const i = current === null ? -1 : options.indexOf(current)
  // slots: 0 = any, 1..n = options
  const slot = (i + 1 + dir + options.length + 1) % (options.length + 1)
  return slot === 0 ? null : options[slot - 1]
}

export function matchesFilters(card: BazaarCard, f: Filters): boolean {
  if (f.hero !== null && !(card.Heroes ?? []).includes(f.hero)) return false
  if (f.type !== null && card.Type !== f.type) return false
  if (f.size !== null && card.Size !== f.size) return false
  if (f.tier !== null && !(card.Tiers ?? []).includes(f.tier as TierName)) return false
  return true
}

// The first `cap` matches in the given order, and how many more there were. The
// overlay cannot scroll a list, so a long one is cut and counted rather than clipped.
export function applyFilters(cards: BazaarCard[], f: Filters, cap: number): { shown: BazaarCard[]; more: number } {
  const shown: BazaarCard[] = []
  let total = 0
  for (const c of cards) {
    if (!matchesFilters(c, f)) continue
    total++
    if (shown.length < cap) shown.push(c)
  }
  return { shown, more: total - shown.length }
}
