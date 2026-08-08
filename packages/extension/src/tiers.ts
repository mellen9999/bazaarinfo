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
// Luminance runs the whole ramp in one direction: the fill is the darkest end and
// the outer frame the brightest, so the card cuts a hard edge out of the video.
// Only that outer edge is bright — internal rules stay dim, because a box where
// every line shouts has no frame, just noise.
//
// Nothing that carries words sits below 246. 242 measures 3.8:1 on this fill, which
// is under AA at 13px — it reads as a quiet label in a mock and as unreadable over
// moving video.
export const INK = {
  panel: '#000000',    // 16  — panel fill, the dark end
  rule: '#303030',     // 236 — section rules
  ruleDim: '#1c1c1c',  // 234 — rules between blocks
  artFrame: '#585858', // 240 — art box, the mid step
  sep: '#4e4e4e',      // 239 — punctuation, never words
  label: '#949494',    // 246 — stat keys, block labels, tags (AA floor)
  text: '#d0d0d0',     // 252 — body text
  frame: '#eeeeee',    // 255 — the outer border, the bright end
  bright: '#ffffff',   // 231 — card name; content outranks chrome
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
