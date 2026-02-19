import { describe, expect, it } from 'bun:test'
import { computeDisplayTags, toCard, toMonster, parseDump } from './scraper'
import type { DumpEntry } from './scraper'

function makeDumpEntry(overrides: Partial<DumpEntry> = {}): DumpEntry {
  return {
    Type: 'Item',
    Title: 'Test Sword',
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'],
    Heroes: ['Vanessa'],
    Tags: ['Weapon', 'Vanessa', 'Medium', 'Item'],
    HiddenTags: [],
    Tooltips: [{ text: 'Deal {Damage} damage', type: 'Active' }],
    TooltipReplacements: { Damage: { Fixed: 10 } },
    Enchantments: {},
    Shortlink: 'https://bzdb.to/test',
    ...overrides,
  }
}

describe('computeDisplayTags', () => {
  it('filters out Type, Size, and Heroes from tags', () => {
    const entry = makeDumpEntry()
    const tags = computeDisplayTags(entry)
    expect(tags).toEqual(['Weapon'])
  })

  it('filters out HiddenTags', () => {
    const entry = makeDumpEntry({ HiddenTags: ['Weapon'] })
    const tags = computeDisplayTags(entry)
    expect(tags).toEqual([])
  })

  it('handles missing Tags/HiddenTags/Heroes', () => {
    const entry = makeDumpEntry()
    // @ts-expect-error testing missing fields
    delete entry.Tags
    // @ts-expect-error testing missing fields
    delete entry.Heroes
    const tags = computeDisplayTags(entry)
    expect(tags).toEqual([])
  })
})

describe('toCard', () => {
  it('converts a DumpEntry to BazaarCard', () => {
    const card = toCard(makeDumpEntry())
    expect(card.Type).toBe('Item')
    expect(card.Title).toBe('Test Sword')
    expect(card.Size).toBe('Medium')
    expect(card.BaseTier).toBe('Bronze')
    expect(card.Tiers).toEqual(['Bronze', 'Silver', 'Gold', 'Diamond'])
    expect(card.DisplayTags).toEqual(['Weapon'])
    expect(card.Shortlink).toBe('https://bzdb.to/test')
  })

  it('defaults missing optional fields', () => {
    const entry = makeDumpEntry()
    // @ts-expect-error testing missing fields
    delete entry.Tooltips
    // @ts-expect-error testing missing fields
    delete entry.TooltipReplacements
    // @ts-expect-error testing missing fields
    delete entry.Enchantments
    const card = toCard(entry)
    expect(card.Tooltips).toEqual([])
    expect(card.TooltipReplacements).toEqual({})
    expect(card.Enchantments).toEqual({})
  })

  it('throws on invalid tier', () => {
    const entry = makeDumpEntry({ BaseTier: 'Mythical' })
    expect(() => toCard(entry)).toThrow('unknown tier: Mythical')
  })

  it('throws on invalid size', () => {
    const entry = makeDumpEntry({ Size: 'Huge' })
    expect(() => toCard(entry)).toThrow('unknown size: Huge')
  })

  it('throws on invalid tier in Tiers array', () => {
    const entry = makeDumpEntry({ Tiers: ['Bronze', 'Unobtanium'] })
    expect(() => toCard(entry)).toThrow('unknown tier: Unobtanium')
  })
})

describe('toMonster', () => {
  it('returns null when no MonsterMetadata', () => {
    expect(toMonster(makeDumpEntry())).toBeNull()
  })

  it('converts a monster DumpEntry', () => {
    const entry = makeDumpEntry({
      Type: 'CombatEncounter',
      Title: 'Dragon',
      MonsterMetadata: {
        available: 'Always',
        day: 3,
        health: 100,
        board: [{ title: 'Claw', tier: 'Bronze' as any, id: '1' }],
        skills: [],
      },
    })
    const monster = toMonster(entry)
    expect(monster).not.toBeNull()
    expect(monster!.Type).toBe('CombatEncounter')
    expect(monster!.Title).toBe('Dragon')
    expect(monster!.MonsterMetadata.health).toBe(100)
    expect(monster!.MonsterMetadata.day).toBe(3)
  })
})

describe('parseDump', () => {
  it('separates items, skills, and monsters', () => {
    const dump: Record<string, any> = {
      a: makeDumpEntry({ Type: 'Item', Title: 'Sword' }),
      b: makeDumpEntry({ Type: 'Skill', Title: 'Fireball' }),
      c: makeDumpEntry({
        Type: 'CombatEncounter',
        Title: 'Goblin',
        MonsterMetadata: {
          available: 'Always',
          day: 1,
          health: 50,
          board: [],
          skills: [],
        },
      }),
    }
    const cache = parseDump(dump)
    expect(cache.items).toHaveLength(1)
    expect(cache.items[0].Title).toBe('Sword')
    expect(cache.skills).toHaveLength(1)
    expect(cache.skills[0].Title).toBe('Fireball')
    expect(cache.monsters).toHaveLength(1)
    expect(cache.monsters[0].Title).toBe('Goblin')
    expect(cache.fetchedAt).toBeTruthy()
  })

  it('skips CombatEncounters without MonsterMetadata', () => {
    const dump: Record<string, any> = {
      a: makeDumpEntry({ Type: 'CombatEncounter', Title: 'Ghost' }),
    }
    const cache = parseDump(dump)
    expect(cache.monsters).toHaveLength(0)
  })

  it('ignores unknown types', () => {
    const dump: Record<string, any> = {
      a: makeDumpEntry({ Type: 'Unknown', Title: 'Mystery' }),
    }
    const cache = parseDump(dump)
    expect(cache.items).toHaveLength(0)
    expect(cache.skills).toHaveLength(0)
    expect(cache.monsters).toHaveLength(0)
  })
})
