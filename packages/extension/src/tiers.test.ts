import { describe, expect, it } from 'bun:test'
import { tierStyle, deriveValidTiers, isPlausibleTierString } from './tiers'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'

const FAKE = (tiers: TierName[]): BazaarCard => ({
  Title: 'x', Tiers: tiers, BaseTier: tiers[0],
  Heroes: [], Tags: [], DisplayTags: [], HiddenTags: [],
  Tooltips: [], TooltipReplacements: {}, Enchantments: {},
  Size: 'Small', Type: 'Item', ArtKey: '', Shortlink: '',
} as unknown as BazaarCard)

describe('tierStyle', () => {
  it('returns canonical styles for known tiers', () => {
    for (const t of ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']) {
      const s = tierStyle(t)
      expect(s.color).not.toBe('#9aa0a6')
      expect(s.gradient).toContain('linear-gradient')
    }
  })

  it('falls back gracefully for unknown tier', () => {
    const s = tierStyle('Mythic')
    expect(s.color).toBe('#9aa0a6')
    expect(s.gradient).toContain('linear-gradient')
    expect(s.hzColor).toBeTruthy()
  })

  it('handles empty string', () => {
    expect(tierStyle('').color).toBe('#9aa0a6')
  })
})

describe('deriveValidTiers', () => {
  it('extracts unique tiers from card list', () => {
    const cards = [FAKE(['Bronze', 'Silver']), FAKE(['Silver', 'Gold'])]
    const set = deriveValidTiers(cards)
    expect(set.size).toBe(3)
    expect(set.has('Bronze')).toBe(true)
    expect(set.has('Silver')).toBe(true)
    expect(set.has('Gold')).toBe(true)
  })

  it('returns empty set for no cards', () => {
    expect(deriveValidTiers([]).size).toBe(0)
  })
})

describe('isPlausibleTierString', () => {
  const known = new Set(['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'])

  it('accepts known tiers from validation set', () => {
    expect(isPlausibleTierString('Gold', known)).toBe(true)
  })

  it('rejects unknown tier when set is populated', () => {
    expect(isPlausibleTierString('Mythic', known)).toBe(false)
  })

  it('falls back to canonical 5 when set is empty (bootstrap)', () => {
    const empty = new Set<string>()
    expect(isPlausibleTierString('Bronze', empty)).toBe(true)
    expect(isPlausibleTierString('Mythic', empty)).toBe(false)
  })

  it('rejects non-strings, empty, oversized', () => {
    expect(isPlausibleTierString(null, known)).toBe(false)
    expect(isPlausibleTierString(42, known)).toBe(false)
    expect(isPlausibleTierString('', known)).toBe(false)
    expect(isPlausibleTierString('x'.repeat(33), known)).toBe(false)
  })
})
