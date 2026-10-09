import { describe, it, expect } from 'bun:test'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { NO_FILTERS, hasFilter, filterLabel, filterOptions, cycleValue, matchesFilters, applyFilters } from './card-filters'
import { ENGLISH } from './i18n'

const card = (o: Partial<BazaarCard>): BazaarCard => ({
  Type: 'Item', Title: 'x', Size: 'Small', BaseTier: 'Bronze', Tiers: ['Bronze', 'Silver'], Heroes: ['Common'],
  Tags: [], HiddenTags: [], DisplayTags: [], Tooltips: [], TooltipReplacements: {}, Enchantments: {}, Shortlink: '',
  ...o,
})

const cards = [
  card({ Title: 'a', Heroes: ['Vanessa'], Size: 'Large', Tiers: ['Gold', 'Diamond'] }),
  card({ Title: 'b', Heroes: ['Common'], Size: 'Medium' }),
  card({ Title: 'c', Heroes: ['Mak'], Type: 'Skill', Tiers: ['Legendary'] }),
  card({ Title: 'd', Heroes: ['Vanessa', 'Mak'], Size: 'Small' }),
]

describe('filterOptions', () => {
  it('offers only what the data has, in natural order', () => {
    const o = filterOptions(cards)
    expect(o.hero).toEqual(['Mak', 'Vanessa', 'Common'])
    expect(o.type).toEqual(['Item', 'Skill'])
    expect(o.size).toEqual(['Small', 'Medium', 'Large'])
    expect(o.tier).toEqual(['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'])
  })

  it('omits values nothing uses', () => {
    const o = filterOptions([card({ Tiers: ['Gold'] })])
    expect(o.tier).toEqual(['Gold'])
    expect(o.type).toEqual(['Item'])
    expect(o.size).toEqual(['Small'])
  })

  it('is empty before the data lands', () => {
    expect(filterOptions([])).toEqual({ hero: [], type: [], size: [], tier: [] })
  })
})

describe('cycleValue', () => {
  const opts = ['a', 'b']
  it('walks any, each value, then back to any', () => {
    expect(cycleValue(opts, null)).toBe('a')
    expect(cycleValue(opts, 'a')).toBe('b')
    expect(cycleValue(opts, 'b')).toBeNull()
  })

  it('walks backwards too', () => {
    expect(cycleValue(opts, null, -1)).toBe('b')
    expect(cycleValue(opts, 'b', -1)).toBe('a')
    expect(cycleValue(opts, 'a', -1)).toBeNull()
  })

  it('steps from any when the value is no longer offered', () => {
    expect(cycleValue(opts, 'gone')).toBe('a')
  })

  it('stays on any with nothing to choose', () => {
    expect(cycleValue([], null)).toBeNull()
    expect(cycleValue([], 'a', -1)).toBeNull()
  })
})

describe('matchesFilters', () => {
  it('matches everything with no filter', () => {
    expect(cards.every((c) => matchesFilters(c, NO_FILTERS))).toBe(true)
  })

  it('matches multi-hero cards on either hero', () => {
    expect(cards.filter((c) => matchesFilters(c, { ...NO_FILTERS, hero: 'Mak' })).map((c) => c.Title)).toEqual(['c', 'd'])
  })

  it('treats Common as neutral', () => {
    expect(cards.filter((c) => matchesFilters(c, { ...NO_FILTERS, hero: 'Common' })).map((c) => c.Title)).toEqual(['b'])
  })

  it('matches a tier the card has, not just its base', () => {
    expect(cards.filter((c) => matchesFilters(c, { ...NO_FILTERS, tier: 'Diamond' })).map((c) => c.Title)).toEqual(['a'])
  })

  it('ands the chips together', () => {
    const f = { hero: 'Vanessa', type: 'Item', size: 'Small', tier: null }
    expect(cards.filter((c) => matchesFilters(c, f)).map((c) => c.Title)).toEqual(['d'])
  })

  it('survives a card missing its arrays', () => {
    const bare = { Title: 'z', Type: 'Item', Size: 'Small' } as unknown as BazaarCard
    expect(matchesFilters(bare, { ...NO_FILTERS, hero: 'Mak' })).toBe(false)
    expect(matchesFilters(bare, NO_FILTERS)).toBe(true)
  })
})

describe('applyFilters', () => {
  it('caps the list and counts the rest', () => {
    const r = applyFilters(cards, NO_FILTERS, 3)
    expect(r.shown.map((c) => c.Title)).toEqual(['a', 'b', 'c'])
    expect(r.more).toBe(1)
  })

  it('has no remainder when everything fits', () => {
    expect(applyFilters(cards, { ...NO_FILTERS, type: 'Skill' }, 8)).toEqual({ shown: [cards[2]], more: 0 })
  })

  it('is empty when nothing matches', () => {
    expect(applyFilters(cards, { ...NO_FILTERS, hero: 'Nobody' }, 8)).toEqual({ shown: [], more: 0 })
  })
})

describe('labels and state', () => {
  it('words the neutral hero the way viewers do, all lowercase', () => {
    expect(filterLabel('hero', 'Common', ENGLISH)).toBe('neutral')
    expect(filterLabel('hero', 'The Dragons', ENGLISH)).toBe('the dragons')
    expect(filterLabel('tier', 'Gold', ENGLISH)).toBe('gold')
    expect(filterLabel('type', 'Common', ENGLISH)).toBe('common')
  })

  it('knows when a chip is set', () => {
    expect(hasFilter(NO_FILTERS)).toBe(false)
    expect(hasFilter({ ...NO_FILTERS, size: 'Large' })).toBe(true)
  })
})
