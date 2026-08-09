import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'

// Colour doctrine for the overlay: monochrome by default, hue only where the hue IS
// the information. Greys carry all structure and all text hierarchy (luminance =
// importance); a colour appears exactly once per fact it encodes.
//
//   grey ramp    structure, labels, values — everything not listed below
//   tier hue     the tier value in the stat line, and each rung of a tier ladder
//   purple 141   enchantment (stat value + effect block)
//   red 203      opponent ownership (hover-zone outline)
//
// The ladder is the second sanctioned place and the rule is unchanged, not relaxed:
// when we can't know the live tier we print every tier's value, and there the hue IS
// the information — tier windows vary per card (many items exist only at
// Gold/Diamond), so position doesn't imply tier and a bare "60/80" would be read as
// bronze/silver. Without the hue the row is ambiguous; that is the test for whether
// a colour has earned its place.
//
// Painting the tier hue on the border, the art frame, the name and the hover outline
// all at once — as this did — says "tier" four times and everything else zero times,
// so it reads as decoration and buries the one place a reader is actually looking.
//
// The greys themselves live in style.css and ONLY there. They used to be mirrored
// into an `INK` map here that nothing ever imported — a second source of truth that
// could drift from the stylesheet without a single test noticing. That is precisely
// how the card art died (a hash map nothing read, quietly going stale), so the copy
// is gone. Tier hues stay here because they are the one part of the palette real code
// consumes: tierColor() feeds the tooltip's --tier-color and the panel's tier row.

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
