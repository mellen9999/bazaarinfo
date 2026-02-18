import { describe, expect, it } from 'bun:test'
import { buildIndex, searchCards } from './search'
import type { BazaarCard } from './types'

function makeCard(title: string): BazaarCard {
  return {
    Id: title.toLowerCase().replace(/\s/g, '-'),
    Type: 'Item',
    Title: { Text: title },
    Description: null,
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: {
      Bronze: { AbilityIds: [], AuraIds: [], OverrideAttributes: {}, ActiveTooltips: [] },
      Silver: { AbilityIds: [], AuraIds: [], OverrideAttributes: {}, ActiveTooltips: [] },
      Gold: { AbilityIds: [], AuraIds: [], OverrideAttributes: {}, ActiveTooltips: [] },
      Diamond: { AbilityIds: [], AuraIds: [], OverrideAttributes: {}, ActiveTooltips: [] },
    },
    BaseAttributes: {},
    Tooltips: [],
    TooltipReplacements: {},
    DisplayTags: [],
    HiddenTags: [],
    Tags: [],
    Heroes: [],
    Enchantments: {},
    Art: '',
    ArtLarge: '',
    ArtBlur: '',
    Uri: '',
    DroppedBy: null,
    Quests: null,
    Transform: null,
    _originalTitleText: title,
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
    expect(results[0].item.Title.Text).toBe('Boomerang')
  })

  it('close typo passes gate', () => {
    const results = gatedSearch('boomrang')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].item.Title.Text).toBe('Boomerang')
  })

  it('multi-word exact passes gate', () => {
    const results = gatedSearch('rocket boots')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].item.Title.Text).toBe('Rocket Boots')
  })

  it('"horse" does not match Lighthouse', () => {
    const results = gatedSearch('horse')
    const titles = results.map((r) => r.item.Title.Text)
    expect(titles).not.toContain('Lighthouse')
  })

  it('"horse" matches Horse Shoe', () => {
    const results = gatedSearch('horse')
    const titles = results.map((r) => r.item.Title.Text)
    expect(titles).toContain('Horse Shoe')
  })

  it('"lettuce" does not match Letter Opener', () => {
    const results = gatedSearch('lettuce')
    const titles = results.map((r) => r.item.Title.Text)
    expect(titles).not.toContain('Letter Opener')
  })

  it('"ass" matches Assault Focus (valid prefix of "assault")', () => {
    const results = gatedSearch('ass')
    const titles = results.map((r) => r.item.Title.Text)
    expect(titles).toContain('Assault Focus')
  })

  it('"epstein" does not match Nesting Doll', () => {
    const results = gatedSearch('epstein')
    const titles = results.map((r) => r.item.Title.Text)
    expect(titles).not.toContain('Nesting Doll')
  })

  it('garbage query returns empty after gate', () => {
    const results = gatedSearch('xyzgarbage')
    expect(results).toHaveLength(0)
  })
})
