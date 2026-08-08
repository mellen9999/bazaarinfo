import { describe, expect, it } from 'bun:test'
import { tierColor, deriveValidTiers, isPlausibleTierString } from './tiers'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'

const FAKE = (tiers: TierName[]): BazaarCard => ({
  Title: 'x', Tiers: tiers, BaseTier: tiers[0],
  Heroes: [], Tags: [], DisplayTags: [], HiddenTags: [],
  Tooltips: [], TooltipReplacements: {}, Enchantments: {},
  Size: 'Small', Type: 'Item', ArtKey: '', Shortlink: '',
} as unknown as BazaarCard)

const TIERS = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']

describe('tierColor', () => {
  it('gives every known tier its own colour', () => {
    const colors = TIERS.map(tierColor)
    expect(new Set(colors).size).toBe(TIERS.length)
    for (const c of colors) expect(c).not.toBe(tierColor('Mythic'))
  })

  it('always returns a colour', () => {
    for (const t of [...TIERS, 'Mythic', '']) {
      expect(tierColor(t)).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('falls back to one neutral grey for anything unknown', () => {
    expect(tierColor('')).toBe(tierColor('Mythic'))
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
