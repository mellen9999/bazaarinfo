import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'

// Colour doctrine for the overlay: monochrome by default, hue only where the hue IS
// the information. Greys carry all structure and all text hierarchy (luminance =
// importance); a colour appears exactly once per fact it encodes.
//
//   grey ramp    structure, labels, values — everything not listed below
//   tier hue     the tier value in the stat line, and nowhere else
//   purple 141   enchantment (stat value + effect block)
//   red 203      opponent ownership (hover-zone outline)
//
// Painting the tier hue on the border, the art frame, the name and the hover outline
// all at once — as this did — says "tier" four times and everything else zero times,
// so it reads as decoration and buries the one place a reader is actually looking.
export const INK = {
  panel: '#080808',    // 232 — panel fill
  rule: '#303030',     // 236 — section rules
  ruleDim: '#1c1c1c',  // 234 — rules between blocks
  frame: '#585858',    // 240 — panel and art border
  label: '#6c6c6c',    // 242 — stat keys, block labels
  dim: '#949494',      // 246 — tags
  text: '#d0d0d0',     // 252 — body text
  bright: '#e4e4e4',   // 254 — card name
  ench: '#af87ff',     // 141 — enchantment
  opponent: '#ff5f5f', // 203 — opponent ownership
} as const

const TIER_COLORS: Record<string, string> = {
  Bronze: '#d75f00',    // 166
  Silver: '#bcbcbc',    // 250
  Gold: '#ffd700',      // 220
  Diamond: '#87ffff',   // 123
  Legendary: '#af87ff', // 141
}

const UNKNOWN_TIER = '#8a8a8a' // 245

// The tier's colour, for the one place the tier is stated. An unrecognised tier gets
// neutral grey rather than a guess — a wrong hue asserts a tier we don't have.
export function tierColor(tier: string): string {
  return TIER_COLORS[tier] ?? UNKNOWN_TIER
}

export function deriveValidTiers(cards: Iterable<BazaarCard>): Set<string> {
  const set = new Set<string>()
  for (const c of cards) for (const t of c.Tiers) set.add(t)
  return set
}

export function isPlausibleTierString(s: unknown, valid: Set<string>): s is TierName {
  if (typeof s !== 'string' || s.length === 0 || s.length > 32) return false
  if (valid.size > 0) return valid.has(s)
  return s in TIER_COLORS
}
