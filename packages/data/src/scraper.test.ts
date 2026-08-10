import { describe, expect, it } from 'bun:test'
import { computeDisplayTags, toCard, toMonster, parseDump, parseDumpWithStats, applyCooldowns, extractCooldown, checkDeltaGuard, loadPrevCooldowns } from './scraper'
import type { DumpEntry } from './scraper'
import type { CardCache } from '@bazaarinfo/shared'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

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
    delete entry.TooltipReplacements
    delete entry.Enchantments
    const card = toCard(entry)
    expect(card.Tooltips).toEqual([])
    expect(card.TooltipReplacements).toEqual({})
    expect(card.Enchantments).toEqual({})
  })

  it('passes through an unknown tier instead of throwing', () => {
    const entry = makeDumpEntry({ BaseTier: 'Mythical' })
    expect(toCard(entry).BaseTier).toBe('Mythical' as any)
  })

  it('passes through an unknown size instead of throwing', () => {
    const entry = makeDumpEntry({ Size: 'Huge' })
    expect(toCard(entry).Size).toBe('Huge' as any)
  })

  it('passes through an unknown tier in the Tiers array', () => {
    const entry = makeDumpEntry({ Tiers: ['Bronze', 'Unobtanium'] })
    expect(toCard(entry).Tiers).toEqual(['Bronze', 'Unobtanium'] as any)
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
    expect((cache as any).events).toHaveLength(0)
  })

  it('collects EventEncounters separately from items', () => {
    const dump: Record<string, any> = {
      a: makeDumpEntry({ Type: 'Item', Title: 'Sword' }),
      b: makeDumpEntry({
        Type: 'EventEncounter',
        Title: 'The Travel Agent',
        Size: 'Medium',
        BaseTier: 'Diamond',
        Heroes: ['Common'],
        Tags: ['EventEncounter', 'Common'],
        HiddenTags: [],
        Tiers: [],
        Tooltips: [],
        TooltipReplacements: {},
        Enchantments: {},
      }),
    }
    const cache = parseDump(dump)
    expect(cache.items).toHaveLength(1)
    expect(cache.skills).toHaveLength(0)
    expect(cache.monsters).toHaveLength(0)
    const events = (cache as any).events as any[]
    expect(events).toHaveLength(1)
    expect(events[0].Title).toBe('The Travel Agent')
  })

  // PedestalEncounters (the map locations) were the entire "skipped bad entries" line on
  // every scrape — 28 real cards dropped, so asking about one got a miss and then an
  // invented answer. Same shape and same empty Tooltips as events, so same bucket.
  it('ingests PedestalEncounters instead of dropping them', () => {
    const dump: Record<string, any> = {
      a: makeDumpEntry({ Type: 'Item', Title: 'Sword' }),
      b: makeDumpEntry({
        Type: 'PedestalEncounter',
        Title: 'Murkwood Bayou',
        Size: 'Medium',
        BaseTier: 'Legendary',
        Heroes: ['Common'],
        Tags: ['PedestalEncounter', 'Common'],
        HiddenTags: [],
        Tiers: [],
        Tooltips: [],
        TooltipReplacements: {},
        Enchantments: {},
      }),
    }
    const msgs: string[] = []
    const { cache } = parseDumpWithStats(dump, (m) => msgs.push(m))
    expect(msgs.some((m) => m.startsWith('skipped'))).toBe(false)
    expect(cache.items).toHaveLength(1)
    const events = (cache as any).events as any[]
    expect(events).toHaveLength(1)
    expect(events[0].Title).toBe('Murkwood Bayou')
  })
})

describe('applyCooldowns', () => {
  it('attaches uniform cooldown by Title match', () => {
    const cache = parseDump({ a: makeDumpEntry({ Title: 'Boomerang' }) })
    applyCooldowns(cache, new Map([['Boomerang', 4]]))
    expect(cache.items[0].Cooldown).toBe(4)
  })

  it('attaches per-tier cooldown', () => {
    const cache = parseDump({ a: makeDumpEntry({ Title: 'Boomerang' }) })
    applyCooldowns(cache, new Map([['Boomerang', { Bronze: 12, Silver: 10, Gold: 8 }]]))
    expect(cache.items[0].Cooldown).toEqual({ Bronze: 12, Silver: 10, Gold: 8 })
  })

  it('leaves Cooldown undefined when no match', () => {
    const cache = parseDump({ a: makeDumpEntry({ Title: 'Boomerang' }) })
    applyCooldowns(cache, new Map([['Other', 5]]))
    expect(cache.items[0].Cooldown).toBeUndefined()
  })
})

describe('extractCooldown', () => {
  it('returns single number when all tiers match', () => {
    const cd = extractCooldown({ tiers: {
      Bronze: { tooltips: ['Cooldown 4 seconds', 'Deal 20'] },
      Silver: { tooltips: ['Cooldown 4 seconds', 'Deal 40'] },
      Gold: { tooltips: ['Cooldown 4 seconds', 'Deal 60'] },
    }})
    expect(cd).toBe(4)
  })

  it('returns per-tier object when values differ', () => {
    const cd = extractCooldown({ tiers: {
      Silver: { tooltips: ['Cooldown 12 seconds'] },
      Gold: { tooltips: ['Cooldown 10 seconds'] },
      Diamond: { tooltips: ['Cooldown 8 seconds'] },
    }})
    expect(cd).toEqual({ Silver: 12, Gold: 10, Diamond: 8 })
  })

  it('returns null when no cooldown found', () => {
    const cd = extractCooldown({ tiers: {
      Bronze: { tooltips: ['Deal 20 damage'] },
    }})
    expect(cd).toBeNull()
  })

  it('handles fractional cooldowns', () => {
    const cd = extractCooldown({ tiers: {
      Bronze: { tooltips: ['Cooldown 2.5 seconds'] },
    }})
    expect(cd).toBe(2.5)
  })
})

describe('parseDumpWithStats — unknown tier/size tolerance', () => {
  it('keeps an item with an unknown tier and size, reporting them as unknown rather than skipped', () => {
    const dump: Record<string, any> = {
      a: makeDumpEntry({ Title: 'Prototype Sword', BaseTier: 'Mythic', Size: 'Huge', Tiers: ['Mythic'] }),
    }
    const { cache, stats } = parseDumpWithStats(dump)
    expect(cache.items).toHaveLength(1)
    expect(cache.items[0].BaseTier).toBe('Mythic' as any)
    expect(cache.items[0].Size).toBe('Huge' as any)
    expect(stats.unknownTiers).toEqual(['Mythic'])
    expect(stats.unknownSizes).toEqual(['Huge'])
    expect(stats.skipped).toBe(0)
    expect(stats.total).toBe(1)
  })

  it('reports no unknowns when all tiers/sizes are valid', () => {
    const dump: Record<string, any> = { a: makeDumpEntry() }
    const { stats } = parseDumpWithStats(dump)
    expect(stats.unknownTiers).toEqual([])
    expect(stats.unknownSizes).toEqual([])
  })
})

function makeEmptyCache(overrides: Partial<CardCache> = {}): CardCache {
  return { items: [], skills: [], monsters: [], fetchedAt: new Date(0).toISOString(), ...overrides }
}

function fillArray<T>(n: number, val: T): T[] {
  return Array.from({ length: n }, () => val)
}

describe('checkDeltaGuard', () => {
  it('throws when items drop more than 30% vs the previous cache', () => {
    const cache = makeEmptyCache({ items: fillArray(60, {} as any) })
    expect(() => checkDeltaGuard(cache, { items: 812, skills: 100, monsters: 20 }, undefined))
      .toThrow('bad dump: items 812→60 (>30% drop vs previous cache)')
  })

  it('passes when the drop is under 30%', () => {
    const cache = makeEmptyCache({ items: fillArray(700, {} as any), skills: fillArray(100, {} as any), monsters: fillArray(20, {} as any) })
    expect(() => checkDeltaGuard(cache, { items: 800, skills: 100, monsters: 20 }, undefined)).not.toThrow()
  })

  it('force bypasses the delta guard', () => {
    const cache = makeEmptyCache({ items: fillArray(60, {} as any) })
    expect(() => checkDeltaGuard(cache, { items: 812, skills: 100, monsters: 20 }, true)).not.toThrow()
  })

  it('is inactive when prev.items is at or below the 200 floor', () => {
    const cache = makeEmptyCache({ items: fillArray(1, {} as any) })
    expect(() => checkDeltaGuard(cache, { items: 200, skills: 10, monsters: 5 }, undefined)).not.toThrow()
  })

  it('is a no-op when prev is not provided', () => {
    const cache = makeEmptyCache({ items: fillArray(1, {} as any) })
    expect(() => checkDeltaGuard(cache, undefined, undefined)).not.toThrow()
  })
})

describe('applyCooldowns — onlyMissing (carry-forward pass)', () => {
  it('fills only items without a Cooldown, leaving freshly-matched ones alone', () => {
    const cache = parseDump({
      a: makeDumpEntry({ Title: 'Boomerang' }),
      b: makeDumpEntry({ Title: 'Slingshot' }),
    })
    applyCooldowns(cache, new Map([['Boomerang', 4]])) // fresh match
    const carried = applyCooldowns(cache, new Map([['Boomerang', 99], ['Slingshot', 2]]), true)
    expect(cache.items.find((i) => i.Title === 'Boomerang')!.Cooldown).toBe(4) // untouched
    expect(cache.items.find((i) => i.Title === 'Slingshot')!.Cooldown).toBe(2) // filled
    expect(carried).toBe(1)
  })
})

describe('loadPrevCooldowns', () => {
  function tmpCachePath(): string {
    return join(tmpdir(), `bazaarinfo-scraper-test-${randomUUID()}.json`)
  }

  it('extracts Title -> Cooldown from a real previous cache file', async () => {
    const path = tmpCachePath()
    const cache: CardCache = makeEmptyCache({
      items: [
        { ...toCard(makeDumpEntry({ Title: 'Boomerang' })), Cooldown: 4 },
        { ...toCard(makeDumpEntry({ Title: 'No Cooldown Sword' })) }, // never had one
      ],
    })
    await Bun.write(path, JSON.stringify(cache))
    try {
      const map = await loadPrevCooldowns(path)
      expect(map.get('Boomerang')).toBe(4)
      expect(map.has('No Cooldown Sword')).toBe(false)
    } finally {
      await Bun.file(path).delete()
    }
  })

  it('fails soft (empty map) when the file does not exist', async () => {
    const map = await loadPrevCooldowns(join(tmpdir(), `bazaarinfo-scraper-test-missing-${randomUUID()}.json`))
    expect(map.size).toBe(0)
  })

  it('fails soft (empty map) on malformed JSON', async () => {
    const path = tmpCachePath()
    await Bun.write(path, 'not valid json{{{')
    try {
      const map = await loadPrevCooldowns(path)
      expect(map.size).toBe(0)
    } finally {
      await Bun.file(path).delete()
    }
  })
})

describe('parseDumpWithStats — art coverage', () => {
  it('counts cards missing ArtKey and alerts past the ratio threshold', () => {
    const dump: Record<string, any> = {}
    for (let i = 0; i < 10; i++) {
      dump[`item${i}`] = makeDumpEntry({ Title: `No Art Card ${i}` }) // no ArtKey, not in ART_MAP
    }
    const msgs: string[] = []
    const { stats } = parseDumpWithStats(dump, (m) => msgs.push(m))
    expect(stats.artMisses).toBe(10)
    expect(stats.artMissSamples.length).toBe(5)
    expect(msgs.some((m) => m.startsWith('ALERT: art coverage low'))).toBe(true)
  })

  it('does not alert when misses are under the ratio threshold', () => {
    const dump: Record<string, any> = {}
    for (let i = 0; i < 9; i++) {
      dump[`item${i}`] = makeDumpEntry({ Title: `Art Card ${i}`, ArtKey: `key${i}` })
    }
    dump.miss = makeDumpEntry({ Title: 'One Miss' }) // 1/10 = 10%, at (not over) the threshold
    const msgs: string[] = []
    const { stats } = parseDumpWithStats(dump, (m) => msgs.push(m))
    expect(stats.artMisses).toBe(1)
    expect(msgs.some((m) => m.startsWith('ALERT:'))).toBe(false)
  })

  it('counts zero misses when every card carries an explicit ArtKey', () => {
    const dump: Record<string, any> = { a: makeDumpEntry({ Title: 'Sword', ArtKey: 'sword-key' }) }
    const { stats } = parseDumpWithStats(dump)
    expect(stats.artMisses).toBe(0)
  })
})
