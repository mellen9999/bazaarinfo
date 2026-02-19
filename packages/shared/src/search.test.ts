import { describe, expect, it } from 'bun:test'
import { buildIndex, searchCards, searchPrefix, buildTitleMap, findExact } from './search'
import type { BazaarCard } from './types'

function makeCard(title: string): BazaarCard {
  return {
    Type: 'Item',
    Title: title,
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'],
    Tooltips: [],
    TooltipReplacements: {},
    DisplayTags: [],
    HiddenTags: [],
    Tags: [],
    Heroes: [],
    Enchantments: {},
    Shortlink: 'https://bzdb.to/test',
  }
}

const cards = [
  makeCard('Boomerang'),
  makeCard('Lighthouse'),
  makeCard('Letter Opener'),
  makeCard('Assault Focus'),
  makeCard('Nesting Doll'),
  makeCard('Rocket Boots'),
  makeCard('Shield'),
  makeCard('Horse Shoe'),
]

const index = buildIndex(cards)
const SCORE_GATE = 0.15

function gatedSearch(query: string, limit = 5) {
  return searchCards(index, query, limit).filter((r) => r.score <= SCORE_GATE)
}

describe('searchCards score gate', () => {
  it('exact match returns low score', () => {
    const results = searchCards(index, 'Boomerang', 1)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].score).toBeLessThan(0.05)
    expect(results[0].item.Title).toBe('Boomerang')
  })

  it('close typo passes gate', () => {
    const results = gatedSearch('boomrang')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].item.Title).toBe('Boomerang')
  })

  it('multi-word exact passes gate', () => {
    const results = gatedSearch('rocket boots')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].item.Title).toBe('Rocket Boots')
  })

  it('"horse" does not match Lighthouse', () => {
    const results = gatedSearch('horse')
    const titles = results.map((r) => r.item.Title)
    expect(titles).not.toContain('Lighthouse')
  })

  it('"horse" matches Horse Shoe', () => {
    const results = gatedSearch('horse')
    const titles = results.map((r) => r.item.Title)
    expect(titles).toContain('Horse Shoe')
  })

  it('"lettuce" does not match Letter Opener', () => {
    const results = gatedSearch('lettuce')
    const titles = results.map((r) => r.item.Title)
    expect(titles).not.toContain('Letter Opener')
  })

  it('"ass" matches Assault Focus (valid prefix of "assault")', () => {
    const results = gatedSearch('ass')
    const titles = results.map((r) => r.item.Title)
    expect(titles).toContain('Assault Focus')
  })

  it('"epstein" does not match Nesting Doll', () => {
    const results = gatedSearch('epstein')
    const titles = results.map((r) => r.item.Title)
    expect(titles).not.toContain('Nesting Doll')
  })

  it('garbage query returns empty after gate', () => {
    const results = gatedSearch('xyzgarbage')
    expect(results).toHaveLength(0)
  })
})

describe('searchPrefix', () => {
  it('matches by title prefix', () => {
    const results = searchPrefix(cards, 'boom')
    expect(results).toHaveLength(1)
    expect(results[0].Title).toBe('Boomerang')
  })

  it('is case insensitive', () => {
    const results = searchPrefix(cards, 'ROCK')
    expect(results).toHaveLength(1)
    expect(results[0].Title).toBe('Rocket Boots')
  })

  it('returns empty for no match', () => {
    expect(searchPrefix(cards, 'zzz')).toHaveLength(0)
  })

  it('respects limit', () => {
    const manyCards = [makeCard('Axe A'), makeCard('Axe B'), makeCard('Axe C')]
    const results = searchPrefix(manyCards, 'axe', 2)
    expect(results).toHaveLength(2)
  })
})

describe('buildTitleMap + findExact', () => {
  it('findExact with titleMap', () => {
    const map = buildTitleMap(cards)
    const result = findExact(cards, 'Boomerang', map)
    expect(result?.Title).toBe('Boomerang')
  })

  it('findExact is case insensitive', () => {
    const map = buildTitleMap(cards)
    expect(findExact(cards, 'SHIELD', map)?.Title).toBe('Shield')
  })

  it('findExact without titleMap (linear scan)', () => {
    const result = findExact(cards, 'Horse Shoe')
    expect(result?.Title).toBe('Horse Shoe')
  })

  it('findExact returns undefined for no match', () => {
    const map = buildTitleMap(cards)
    expect(findExact(cards, 'nonexistent', map)).toBeUndefined()
  })

  it('buildTitleMap overwrites duplicate titles (last wins)', () => {
    const dupes = [makeCard('Sword'), makeCard('Sword')]
    const map = buildTitleMap(dupes)
    expect(map.size).toBe(1)
  })
})
