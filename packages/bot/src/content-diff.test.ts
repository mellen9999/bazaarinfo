import { describe, it, expect } from 'bun:test'
import type { BazaarCard, CardCache, Monster } from '@bazaarinfo/shared'
import { diffContent, renderDiffChat, renderDiffAlert } from './content-diff'

function makeItem(overrides: Partial<BazaarCard> = {}): BazaarCard {
  return {
    Type: 'Item',
    Title: 'Test Item',
    Size: 'Small',
    BaseTier: 'Bronze',
    Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'],
    Heroes: ['Karnok'],
    Tags: [],
    HiddenTags: [],
    DisplayTags: [],
    Tooltips: [],
    TooltipReplacements: {},
    Enchantments: {},
    Shortlink: 'https://example.com/x',
    ArtKey: 'test-item',
    ...overrides,
  } as BazaarCard
}

function makeMonster(overrides: Partial<Monster> = {}): Monster {
  return {
    Type: 'CombatEncounter',
    Title: 'Test Monster',
    Size: 'Medium',
    Tags: [],
    DisplayTags: [],
    HiddenTags: [],
    Heroes: [],
    MonsterMetadata: { available: 'day', day: 1, health: 100, board: [], skills: [] },
    Shortlink: 'https://example.com/m',
    ...overrides,
  }
}

function baseCache(overrides: Partial<CardCache> = {}): CardCache {
  return {
    items: [makeItem()],
    skills: [makeItem({ Type: 'Skill', Title: 'Test Skill' })],
    monsters: [makeMonster()],
    fetchedAt: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

describe('diffContent', () => {
  it('returns null when nothing changed', () => {
    const prev = baseCache()
    const next = baseCache()
    expect(diffContent(prev, next)).toBeNull()
  })

  it('detects new hero, enchant, tier', () => {
    const prev = baseCache()
    const nextItem = makeItem({
      Title: 'Nyx Blade',
      Heroes: ['Nyx'],
      BaseTier: 'Mythic' as any,
      Tiers: ['Mythic'] as any,
      Enchantments: { Prismatic: { tooltips: [] } },
    })
    const next = baseCache({ items: [...prev.items, nextItem] })

    const d = diffContent(prev, next)
    expect(d).not.toBeNull()
    expect(d!.newHeroes).toEqual(['Nyx'])
    expect(d!.newEnchants).toEqual(['Prismatic'])
    expect(d!.newTiers).toEqual(['Mythic'])
    expect(d!.itemDelta).toBe(1)
    expect(d!.newItemCount).toBe(1)
    expect(d!.missingArtCount).toBe(0)

    const chat = renderDiffChat(d!)
    expect(chat.length).toBeLessThanOrEqual(400)
    expect(chat).toContain('Nyx')
    expect(chat).toContain('Prismatic')
    expect(chat).toContain('Mythic')
    expect(chat.toLowerCase().startsWith('patch absorbed')).toBe(true)

    const alert = renderDiffAlert(d!)
    expect(alert).not.toBeNull()
    expect(alert!.body).toContain('ai-query.ts')
    expect(alert!.body).toContain('store.ts')
    expect(alert!.body).toContain('enchants.ts')
    expect(alert!.body).toContain('scraper')
  })

  it('count-only change: diff non-null but alert null', () => {
    const prev = baseCache()
    const nextItem = makeItem({ Title: 'Another Item' }) // same hero/tier/size, has art
    const next = baseCache({ items: [...prev.items, nextItem] })

    const d = diffContent(prev, next)
    expect(d).not.toBeNull()
    expect(d!.itemDelta).toBe(1)
    expect(d!.newHeroes).toEqual([])
    expect(d!.newEnchants).toEqual([])
    expect(d!.missingArtCount).toBe(0)

    expect(renderDiffAlert(d!)).toBeNull()
    const chat = renderDiffChat(d!)
    expect(chat).toContain('+1 items')
  })

  it('excludes Common hero and *Reference hidden tags', () => {
    const prev = baseCache()
    const nextItem = makeItem({
      Title: 'Common Trinket',
      Heroes: ['Common'],
      HiddenTags: ['BurnReference', 'Ignite'],
    })
    const next = baseCache({ items: [...prev.items, nextItem] })

    const d = diffContent(prev, next)
    expect(d).not.toBeNull()
    expect(d!.newHeroes).toEqual([])
    expect(d!.newHiddenTags).toEqual(['Ignite'])
    expect(d!.newHiddenTags).not.toContain('BurnReference')
  })

  it('detects items missing art', () => {
    const prev = baseCache()
    const withArt = makeItem({ Title: 'Has Art', ArtKey: 'has-art' })
    const withoutArt = makeItem({ Title: 'No Art', ArtKey: undefined })
    const next = baseCache({ items: [...prev.items, withArt, withoutArt] })

    const d = diffContent(prev, next)
    expect(d).not.toBeNull()
    expect(d!.newItemCount).toBe(2)
    expect(d!.missingArtCount).toBe(1)
    expect(d!.newItemsMissingArt).toEqual(['No Art'])

    const alert = renderDiffAlert(d!)
    expect(alert).not.toBeNull()
    expect(alert!.body).toContain('scripts/scrape-images.ts')
    expect(alert!.body).toContain('1 item')
  })

  it('caps newItemsMissingArt names at 5 but keeps full missingArtCount', () => {
    const prev = baseCache()
    const missing = Array.from({ length: 8 }, (_, i) => makeItem({ Title: `Missing ${i}`, ArtKey: undefined }))
    const next = baseCache({ items: [...prev.items, ...missing] })

    const d = diffContent(prev, next)
    expect(d).not.toBeNull()
    expect(d!.missingArtCount).toBe(8)
    expect(d!.newItemsMissingArt.length).toBe(5)
  })
})
