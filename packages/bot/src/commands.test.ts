import { describe, expect, it, mock, beforeEach } from 'bun:test'
import type { BazaarCard, TierName, Monster } from '@bazaarinfo/shared'

// --- mock fs and store before importing commands ---
const mockAppendFileSync = mock<(path: string, data: string) => void>(() => {})
mock.module('fs', () => ({ appendFileSync: mockAppendFileSync }))

const mockExact = mock<(name: string) => BazaarCard | undefined>(() => undefined)
const mockSearch = mock<(query: string, limit: number) => BazaarCard[]>(() => [])
const mockGetEnchantments = mock<() => string[]>(() => [])
const mockByHero = mock<(hero: string) => BazaarCard[]>(() => [])
const mockFindMonster = mock<(query: string) => Monster | undefined>(() => undefined)
const mockFindCard = mock<(name: string) => BazaarCard | undefined>(() => undefined)

mock.module('./store', () => ({
  exact: mockExact,
  search: mockSearch,
  getEnchantments: mockGetEnchantments,
  byHero: mockByHero,
  findMonster: mockFindMonster,
  findCard: mockFindCard,
}))

const { handleCommand, parseArgs } = await import('./commands')

// --- test fixtures ---
function t() {
  return { AbilityIds: [], AuraIds: [], OverrideAttributes: {}, ActiveTooltips: [] }
}

function makeCard(overrides: Partial<BazaarCard> = {}): BazaarCard {
  return {
    Id: 'test-001',
    Type: 'Item',
    Title: { Text: 'Boomerang' },
    Description: null,
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: { Bronze: t(), Silver: t(), Gold: t(), Diamond: t() },
    BaseAttributes: { DamageAmount: 20, CooldownMax: 4000 },
    Tooltips: [
      { Content: { Text: 'Deal {DamageAmount} Damage' }, TooltipType: 'Active' },
    ],
    TooltipReplacements: {
      '{DamageAmount}': { Fixed: 60 },
    },
    DisplayTags: [],
    HiddenTags: [],
    Tags: [],
    Heroes: ['Pygmalien'],
    Enchantments: {
      Fiery: {
        Tags: ['Burn'],
        HiddenTags: [],
        Localization: {
          Tooltips: [{ Content: { Text: 'Burn for {BurnAmount}' }, TooltipType: 'Active' }],
        },
        TooltipReplacements: {
          '{BurnAmount}': { Bronze: 5, Silver: 10, Gold: 15, Diamond: 20 },
        },
        DisplayTags: [],
      },
    },
    Art: '',
    ArtLarge: '',
    ArtBlur: '',
    Uri: '',
    DroppedBy: null,
    Quests: null,
    Transform: null,
    _originalTitleText: 'Boomerang',
    ...overrides,
  }
}

const boomerang = makeCard()
const shield = makeCard({
  Id: 'test-002',
  Title: { Text: 'Shield' },
  Size: 'Large',
  BaseAttributes: { ShieldApplyAmount: 25, CooldownMax: 5000 },
  Tooltips: [{ Content: { Text: 'Block damage' }, TooltipType: 'Passive' }],
  TooltipReplacements: {},
  Heroes: ['Vanessa'],
  Enchantments: {},
})

beforeEach(() => {
  mockAppendFileSync.mockReset()
  mockExact.mockReset()
  mockSearch.mockReset()
  mockGetEnchantments.mockReset()
  mockByHero.mockReset()
  mockFindMonster.mockReset()
  mockFindCard.mockReset()
  mockExact.mockImplementation(() => undefined)
  mockSearch.mockImplementation(() => [])
  mockGetEnchantments.mockImplementation(() => [])
  mockByHero.mockImplementation(() => [])
  mockFindMonster.mockImplementation(() => undefined)
  mockFindCard.mockImplementation(() => undefined)
})

// ---------------------------------------------------------------------------
// parseArgs — unit tests for the order-agnostic parser
// ---------------------------------------------------------------------------
describe('parseArgs', () => {
  it('parses item only', () => {
    const result = parseArgs(['boomerang'])
    expect(result).toEqual({ item: 'boomerang', tier: undefined, enchant: undefined })
  })

  it('parses multi-word item', () => {
    const result = parseArgs(['tinfoil', 'hat'])
    expect(result).toEqual({ item: 'tinfoil hat', tier: undefined, enchant: undefined })
  })

  it('extracts tier from end', () => {
    const result = parseArgs(['boomerang', 'gold'])
    expect(result.tier).toBe('Gold')
    expect(result.item).toBe('boomerang')
  })

  it('extracts tier from start', () => {
    const result = parseArgs(['gold', 'boomerang'])
    expect(result.tier).toBe('Gold')
    expect(result.item).toBe('boomerang')
  })

  it('extracts tier from middle', () => {
    const result = parseArgs(['tinfoil', 'diamond', 'hat'])
    expect(result.tier).toBe('Diamond')
    expect(result.item).toBe('tinfoil hat')
  })

  it('extracts tier case-insensitively', () => {
    expect(parseArgs(['boomerang', 'GOLD']).tier).toBe('Gold')
    expect(parseArgs(['boomerang', 'Silver']).tier).toBe('Silver')
    expect(parseArgs(['boomerang', 'LEGENDARY']).tier).toBe('Legendary')
  })

  it('extracts enchant from start', () => {
    const result = parseArgs(['fiery', 'boomerang'])
    expect(result.enchant).toBe('Fiery')
    expect(result.item).toBe('boomerang')
  })

  it('extracts enchant from end', () => {
    const result = parseArgs(['boomerang', 'fiery'])
    expect(result.enchant).toBe('Fiery')
    expect(result.item).toBe('boomerang')
  })

  it('extracts enchant from middle of multi-word', () => {
    const result = parseArgs(['tinfoil', 'fiery', 'hat'])
    expect(result.enchant).toBe('Fiery')
    expect(result.item).toBe('tinfoil hat')
  })

  it('extracts both tier and enchant — enchant first', () => {
    const result = parseArgs(['fiery', 'boomerang', 'gold'])
    expect(result.enchant).toBe('Fiery')
    expect(result.tier).toBe('Gold')
    expect(result.item).toBe('boomerang')
  })

  it('extracts both tier and enchant — tier first', () => {
    const result = parseArgs(['gold', 'fiery', 'boomerang'])
    expect(result.enchant).toBe('Fiery')
    expect(result.tier).toBe('Gold')
    expect(result.item).toBe('boomerang')
  })

  it('extracts both tier and enchant — item in middle', () => {
    const result = parseArgs(['fiery', 'boomerang', 'gold'])
    expect(result.enchant).toBe('Fiery')
    expect(result.tier).toBe('Gold')
    expect(result.item).toBe('boomerang')
  })

  it('extracts both — all 6 orderings of 3 words', () => {
    const orderings = [
      ['fiery', 'boomerang', 'gold'],
      ['fiery', 'gold', 'boomerang'],
      ['boomerang', 'fiery', 'gold'],
      ['boomerang', 'gold', 'fiery'],
      ['gold', 'fiery', 'boomerang'],
      ['gold', 'boomerang', 'fiery'],
    ]
    for (const words of orderings) {
      const result = parseArgs(words)
      expect(result.tier).toBe('Gold')
      expect(result.enchant).toBe('Fiery')
      expect(result.item).toBe('boomerang')
    }
  })

  it('extracts both with multi-word item — all orderings', () => {
    const orderings = [
      ['fiery', 'tinfoil', 'hat', 'gold'],
      ['gold', 'fiery', 'tinfoil', 'hat'],
      ['tinfoil', 'hat', 'gold', 'fiery'],
      ['tinfoil', 'hat', 'fiery', 'gold'],
      ['gold', 'tinfoil', 'hat', 'fiery'],
      ['fiery', 'gold', 'tinfoil', 'hat'],
      ['tinfoil', 'fiery', 'hat', 'gold'],
      ['tinfoil', 'gold', 'hat', 'fiery'],
      ['tinfoil', 'fiery', 'gold', 'hat'],
      ['tinfoil', 'gold', 'fiery', 'hat'],
      ['gold', 'tinfoil', 'fiery', 'hat'],
      ['fiery', 'tinfoil', 'gold', 'hat'],
    ]
    for (const words of orderings) {
      const result = parseArgs(words)
      expect(result.tier).toBe('Gold')
      expect(result.enchant).toBe('Fiery')
      expect(result.item).toBe('tinfoil hat')
    }
  })

  it('enchant prefix matching works', () => {
    const result = parseArgs(['fier', 'boomerang'])
    expect(result.enchant).toBe('Fiery')
  })

  it('does not extract enchant if it would leave no item', () => {
    const result = parseArgs(['fiery'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('fiery')
  })

  it('does not extract enchant if prefix is ambiguous', () => {
    // if multiple enchants start with same prefix, no extraction
    mockGetEnchantments.mockImplementation(() => ['fiery', 'fierce'])
    const result = parseArgs(['fie', 'boomerang'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('fie boomerang')
  })

  it('"gold" is tier, not "golden" enchant prefix', () => {
    const result = parseArgs(['gold', 'boomerang'])
    expect(result.tier).toBe('Gold')
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('boomerang')
  })

  it('"golden" is enchant, not tier', () => {
    const result = parseArgs(['golden', 'boomerang'])
    expect(result.tier).toBeUndefined()
    expect(result.enchant).toBe('Golden')
    expect(result.item).toBe('boomerang')
  })

  it('all tier names work', () => {
    for (const tier of ['bronze', 'silver', 'gold', 'diamond', 'legendary']) {
      const result = parseArgs(['boomerang', tier])
      expect(result.tier).toBe(tier[0].toUpperCase() + tier.slice(1))
      expect(result.item).toBe('boomerang')
    }
  })

  it('tier-only input returns tier and empty item', () => {
    const result = parseArgs(['gold'])
    expect(result.tier).toBe('Gold')
    expect(result.item).toBe('')
  })
})

// ---------------------------------------------------------------------------
// handleCommand — basic routing
// ---------------------------------------------------------------------------
describe('handleCommand routing', () => {
  it('returns null for non-command text', () => {
    expect(handleCommand('hello world')).toBeNull()
  })

  it('returns null for unknown commands', () => {
    expect(handleCommand('!unknown test')).toBeNull()
  })

  it('returns null for text without ! prefix', () => {
    expect(handleCommand('bazaar boomerang')).toBeNull()
  })

  it('handles !b case-insensitively', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!B boomerang')
    expect(result).toBeTruthy()
    expect(result).toContain('Boomerang')
  })

  it('shows usage when no args given', () => {
    const result = handleCommand('!b')
    expect(result).toContain('!b')
    expect(result).toContain('<item>')
  })

  it('trims whitespace from args', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b   boomerang   ')
    expect(result).toContain('Boomerang')
  })

  it('removed aliases do not route', () => {
    expect(handleCommand('!item boomerang')).toBeNull()
    expect(handleCommand('!enchant fiery boomerang')).toBeNull()
    expect(handleCommand('!compare boomerang')).toBeNull()
    expect(handleCommand('!bazaarinfo boomerang')).toBeNull()
  })

  it('only !b routes to handler', () => {
    mockExact.mockImplementation(() => boomerang)
    expect(handleCommand('!b boomerang')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// !b — item lookup
// ---------------------------------------------------------------------------
describe('!b item lookup', () => {
  it('looks up item by exact match first', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang')
    expect(result).toContain('Boomerang ·')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('falls back to fuzzy search when exact match fails', () => {
    mockSearch.mockImplementation(() => [boomerang])
    const result = handleCommand('!b boomrang')
    expect(result).toContain('Boomerang ·')
    expect(mockSearch).toHaveBeenCalledWith('boomrang', 1)
  })

  it('returns not found when no match at all', () => {
    const result = handleCommand('!b xyznonexistent')
    expect(result).toContain('nothing found for xyznonexistent')
  })

  it('handles multi-word item names', () => {
    const tinfoil = makeCard({ Title: { Text: 'Tinfoil Hat' } })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = handleCommand('!b tinfoil hat')
    expect(result).toContain('Tinfoil Hat ·')
  })

  it('falls back to monster if no item found', () => {
    const lich: Monster = {
      Id: 'lich-001', Type: 'CombatEncounter', Title: { Text: 'Lich' },
      Description: null, Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [], Uri: '',
      MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [] },
    }
    mockFindMonster.mockImplementation((q) => q === 'lich' ? lich : undefined)
    const result = handleCommand('!b lich')
    expect(result).toContain('Lich')
    expect(result).toContain('Day 5')
  })
})

// ---------------------------------------------------------------------------
// !b — item with tier (any order)
// ---------------------------------------------------------------------------
describe('!b item + tier (any order)', () => {
  beforeEach(() => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
  })

  it('tier at end: !b boomerang gold', () => {
    const result = handleCommand('!b boomerang gold')
    expect(result).toContain('Boomerang')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('tier at start: !b gold boomerang', () => {
    const result = handleCommand('!b gold boomerang')
    expect(result).toContain('Boomerang')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('tier case-insensitive: !b boomerang DIAMOND', () => {
    const result = handleCommand('!b boomerang DIAMOND')
    expect(result).toContain('Boomerang')
  })

  it('all five tiers work at end', () => {
    for (const tier of ['bronze', 'silver', 'gold', 'diamond', 'legendary']) {
      mockExact.mockClear()
      mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
      const result = handleCommand(`!b boomerang ${tier}`)
      expect(result).toContain('Boomerang')
    }
  })

  it('all five tiers work at start', () => {
    for (const tier of ['bronze', 'silver', 'gold', 'diamond', 'legendary']) {
      mockExact.mockClear()
      mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
      const result = handleCommand(`!b ${tier} boomerang`)
      expect(result).toContain('Boomerang')
    }
  })

  it('multi-word item with tier at end', () => {
    const tinfoil = makeCard({ Title: { Text: 'Tinfoil Hat' } })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = handleCommand('!b tinfoil hat gold')
    expect(result).toContain('Tinfoil Hat')
    expect(mockExact).toHaveBeenCalledWith('tinfoil hat')
  })

  it('multi-word item with tier at start', () => {
    const tinfoil = makeCard({ Title: { Text: 'Tinfoil Hat' } })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = handleCommand('!b gold tinfoil hat')
    expect(result).toContain('Tinfoil Hat')
    expect(mockExact).toHaveBeenCalledWith('tinfoil hat')
  })

  it('multi-word item with tier in middle', () => {
    const tinfoil = makeCard({ Title: { Text: 'Tinfoil Hat' } })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = handleCommand('!b tinfoil gold hat')
    expect(result).toContain('Tinfoil Hat')
  })

  it('does not eat non-tier last word as tier', () => {
    const hat = makeCard({ Title: { Text: 'Fancy Hat' } })
    mockExact.mockImplementation((name) => name === 'fancy hat' ? hat : undefined)
    const result = handleCommand('!b fancy hat')
    expect(result).toContain('Fancy Hat')
    expect(mockExact).toHaveBeenCalledWith('fancy hat')
  })
})

// ---------------------------------------------------------------------------
// !b — enchantment (any order)
// ---------------------------------------------------------------------------
describe('!b enchantment (any order)', () => {
  it('enchant first: !b fiery boomerang', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b fiery boomerang')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('enchant last: !b boomerang fiery', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang fiery')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('enchant prefix: !b fier boomerang', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b fier boomerang')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('enchant prefix at end: !b boomerang fier', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang fier')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('icy enchantment any order', () => {
    const card = makeCard({
      Enchantments: {
        Icy: {
          Tags: [], HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Freeze' }, TooltipType: 'Passive' }] },
          TooltipReplacements: {}, DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation(() => card)
    expect(handleCommand('!b icy boomerang')).toContain('[Boomerang - Icy]')
    expect(handleCommand('!b boomerang icy')).toContain('[Boomerang - Icy]')
  })

  it('returns not found when enchantment item doesnt exist', () => {
    const result = handleCommand('!b fiery nonexistent')
    expect(result).toContain('no item found for nonexistent')
  })

  it('multi-word item after enchantment', () => {
    const hat = makeCard({
      Title: { Text: 'Tinfoil Hat' },
      Enchantments: {
        Fiery: {
          Tags: [], HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Burn it' }, TooltipType: 'Active' }] },
          TooltipReplacements: {}, DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? hat : undefined)
    expect(handleCommand('!b fiery tinfoil hat')).toContain('[Tinfoil Hat - Fiery]')
    expect(handleCommand('!b tinfoil hat fiery')).toContain('[Tinfoil Hat - Fiery]')
    expect(handleCommand('!b tinfoil fiery hat')).toContain('[Tinfoil Hat - Fiery]')
  })

  it('single word alone is item lookup not enchant', () => {
    const result = handleCommand('!b fiery')
    expect(result).toContain('nothing found for fiery')
  })

  it('single word alone is item lookup not enchant (toxic)', () => {
    const result = handleCommand('!b toxic')
    expect(result).toContain('nothing found for toxic')
  })
})

// ---------------------------------------------------------------------------
// !b — enchantment + tier (any order, all permutations)
// ---------------------------------------------------------------------------
describe('!b enchant + tier (any order)', () => {
  beforeEach(() => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
  })

  it('enchant item tier', () => {
    expect(handleCommand('!b fiery boomerang gold')).toContain('[Boomerang - Fiery]')
  })

  it('enchant tier item', () => {
    expect(handleCommand('!b fiery gold boomerang')).toContain('[Boomerang - Fiery]')
  })

  it('item enchant tier', () => {
    expect(handleCommand('!b boomerang fiery gold')).toContain('[Boomerang - Fiery]')
  })

  it('item tier enchant', () => {
    expect(handleCommand('!b boomerang gold fiery')).toContain('[Boomerang - Fiery]')
  })

  it('tier enchant item', () => {
    expect(handleCommand('!b gold fiery boomerang')).toContain('[Boomerang - Fiery]')
  })

  it('tier item enchant', () => {
    expect(handleCommand('!b gold boomerang fiery')).toContain('[Boomerang - Fiery]')
  })

  it('all 6 orderings produce same result', () => {
    const orderings = [
      '!b fiery boomerang gold',
      '!b fiery gold boomerang',
      '!b boomerang fiery gold',
      '!b boomerang gold fiery',
      '!b gold fiery boomerang',
      '!b gold boomerang fiery',
    ]
    const results = orderings.map((cmd) => handleCommand(cmd))
    for (const r of results) {
      expect(r).toContain('[Boomerang - Fiery]')
    }
  })

  it('multi-word item + enchant + tier all orderings', () => {
    const hat = makeCard({
      Title: { Text: 'Tinfoil Hat' },
      Enchantments: {
        Fiery: {
          Tags: [], HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Burn' }, TooltipType: 'Active' }] },
          TooltipReplacements: {}, DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? hat : undefined)
    const cmds = [
      '!b fiery tinfoil hat gold',
      '!b gold fiery tinfoil hat',
      '!b tinfoil hat fiery gold',
      '!b tinfoil hat gold fiery',
      '!b gold tinfoil hat fiery',
      '!b fiery gold tinfoil hat',
    ]
    for (const cmd of cmds) {
      expect(handleCommand(cmd)).toContain('[Tinfoil Hat - Fiery]')
    }
  })
})

// ---------------------------------------------------------------------------
// !b — "gold" vs "golden" disambiguation
// ---------------------------------------------------------------------------
describe('!b gold vs golden', () => {
  beforeEach(() => {
    const card = makeCard({
      Enchantments: {
        Golden: {
          Tags: ['Gold'], HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Extra gold' }, TooltipType: 'Passive' }] },
          TooltipReplacements: {}, DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation(() => card)
  })

  it('"gold boomerang" → gold tier item lookup', () => {
    const result = handleCommand('!b gold boomerang')
    expect(result).toContain('Boomerang ·')
    expect(result).not.toContain('Golden')
  })

  it('"golden boomerang" → golden enchantment', () => {
    const result = handleCommand('!b golden boomerang')
    expect(result).toContain('[Boomerang - Golden]')
  })

  it('"boomerang gold" → gold tier item lookup', () => {
    const result = handleCommand('!b boomerang gold')
    expect(result).toContain('Boomerang ·')
    expect(result).not.toContain('Golden')
  })

  it('"boomerang golden" → golden enchantment', () => {
    const result = handleCommand('!b boomerang golden')
    expect(result).toContain('[Boomerang - Golden]')
  })
})

// ---------------------------------------------------------------------------
// !b hero
// ---------------------------------------------------------------------------
describe('!b hero', () => {
  it('lists hero items', () => {
    mockByHero.mockImplementation(() => [boomerang])
    const result = handleCommand('!b hero pygmalien')
    expect(result).toContain('[pygmalien]')
    expect(result).toContain('Boomerang')
  })

  it('returns not found for unknown hero', () => {
    const result = handleCommand('!b hero nobody')
    expect(result).toContain('no items found for hero nobody')
  })

  it('hero keyword is case-insensitive', () => {
    mockByHero.mockImplementation(() => [boomerang])
    expect(handleCommand('!b HERO pygmalien')).toContain('Boomerang')
    expect(handleCommand('!b Hero Pygmalien')).toContain('Boomerang')
  })

  it('truncates long hero output', () => {
    const cards = Array.from({ length: 100 }, (_, i) =>
      makeCard({ Title: { Text: 'Item' + 'X'.repeat(20) + i } }),
    )
    mockByHero.mockImplementation(() => cards)
    const result = handleCommand('!b hero pyg')!
    expect(result.length).toBeLessThanOrEqual(480)
    expect(result).toEndWith('...')
  })
})

// ---------------------------------------------------------------------------
// !b mob / monster
// ---------------------------------------------------------------------------
describe('!b mob/monster', () => {
  const lich: Monster = {
    Id: 'lich-001', Type: 'CombatEncounter', Title: { Text: 'Lich' },
    Description: null, Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
    Heroes: [], Uri: '',
    MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [] },
  }

  it('mob prefix finds monster', () => {
    mockFindMonster.mockImplementation((q) => q === 'lich' ? lich : undefined)
    const result = handleCommand('!b mob lich')
    expect(result).toContain('Lich')
    expect(result).toContain('Day 5')
  })

  it('monster prefix finds monster', () => {
    mockFindMonster.mockImplementation((q) => q === 'lich' ? lich : undefined)
    const result = handleCommand('!b monster lich')
    expect(result).toContain('Lich')
  })

  it('mob prefix is case-insensitive', () => {
    mockFindMonster.mockImplementation(() => lich)
    expect(handleCommand('!b MOB lich')).toContain('Lich')
    expect(handleCommand('!b Mob lich')).toContain('Lich')
  })

  it('monster prefix is case-insensitive', () => {
    mockFindMonster.mockImplementation(() => lich)
    expect(handleCommand('!b MONSTER lich')).toContain('Lich')
  })

  it('returns not found for unknown monster', () => {
    const result = handleCommand('!b mob xyzmonster')
    expect(result).toContain('no monster found for xyzmonster')
  })

  it('multi-word monster name', () => {
    const dragon: Monster = {
      Id: 'dragon-001', Type: 'CombatEncounter', Title: { Text: 'Fire Dragon' },
      Description: null, Size: 'Large', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [], Uri: '',
      MonsterMetadata: { available: 'Rare', day: null, health: 500, board: [] },
    }
    mockFindMonster.mockImplementation((q) => q === 'fire dragon' ? dragon : undefined)
    expect(handleCommand('!b mob fire dragon')).toContain('Fire Dragon')
  })

  it('shows skill tooltips from board', () => {
    const skillCard = makeCard({
      Title: { Text: 'Ink Blast' },
      Type: 'Item',
      Tooltips: [{ Content: { Text: 'Deal {Dmg} damage to all' }, TooltipType: 'Active' }],
      TooltipReplacements: { '{Dmg}': { Bronze: 10, Gold: 30 } },
    })
    const boss: Monster = {
      Id: 'boss-001', Type: 'CombatEncounter', Title: { Text: 'Octoboss' },
      Description: null, Size: 'Large', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [], Uri: '',
      MonsterMetadata: {
        available: 'Always', day: 8, health: 500,
        board: [
          { baseId: 'x', title: 'Sword', size: 'Small', tierOverride: 'Gold', type: 'Item', url: '', art: '', artBlur: '' },
          { baseId: 'y', title: 'Ink Blast', size: 'Medium', tierOverride: 'Gold', type: 'Skill', url: '', art: '', artBlur: '' },
        ],
      },
    }
    mockFindMonster.mockImplementation(() => boss)
    mockFindCard.mockImplementation((name) => name === 'Ink Blast' ? skillCard : undefined)
    const result = handleCommand('!b mob octoboss')!
    expect(result).toContain('Ink Blast: Deal 30 damage to all')
    expect(result).toContain('🟡Sword')
  })

  it('shows skills without card data as regular entries', () => {
    const boss: Monster = {
      Id: 'boss-002', Type: 'CombatEncounter', Title: { Text: 'Mystery' },
      Description: null, Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [], Uri: '',
      MonsterMetadata: {
        available: 'Always', day: 1, health: 50,
        board: [
          { baseId: 'z', title: 'Unknown Skill', size: 'Small', tierOverride: 'Bronze', type: 'Skill', url: '', art: '', artBlur: '' },
        ],
      },
    }
    mockFindMonster.mockImplementation(() => boss)
    const result = handleCommand('!b mob mystery')!
    expect(result).toContain('Unknown Skill')
  })
})

// ---------------------------------------------------------------------------
// !b — edge cases
// ---------------------------------------------------------------------------
describe('!b edge cases', () => {
  it('handles single character input', () => {
    const result = handleCommand('!b x')
    expect(result).toContain('nothing found for x')
  })

  it('handles extra whitespace between words', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b   boomerang')
    expect(result).toContain('Boomerang ·')
  })

  it('output never exceeds 480 chars', () => {
    const longCard = makeCard({
      Title: { Text: 'A'.repeat(200) },
      Tooltips: [
        { Content: { Text: 'B'.repeat(200) }, TooltipType: 'Active' },
        { Content: { Text: 'C'.repeat(200) }, TooltipType: 'Passive' },
      ],
    })
    mockExact.mockImplementation(() => longCard)
    const result = handleCommand('!b test')!
    expect(result.length).toBeLessThanOrEqual(480)
  })

  it('does not match unregistered commands', () => {
    expect(handleCommand('!hero pygmalien')).toBeNull()
    expect(handleCommand('!help')).toBeNull()
    expect(handleCommand('!enc fiery boomerang')).toBeNull()
    expect(handleCommand('!item boomerang')).toBeNull()
  })

  it('handles empty string after command', () => {
    const result = handleCommand('!b ')
    expect(result).toContain('!b')
  })

  it('help and info show usage', () => {
    expect(handleCommand('!b help')).toContain('!b')
    expect(handleCommand('!b info')).toContain('!b')
  })

  it('tier-only input shows usage', () => {
    const result = handleCommand('!b gold')
    // tier extracted, empty item → shows usage
    expect(result).toContain('!b')
  })
})

// ---------------------------------------------------------------------------
// Integration: verify format output structure
// ---------------------------------------------------------------------------
describe('!b output format integration', () => {
  it('item output uses compact stat format', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b boomerang')!
    expect(result).toContain('🗡️20')
    expect(result).toContain('4s')
    expect(result).not.toContain('DMG:')
    expect(result).not.toContain('CD:')
    expect(result).not.toContain('Buy:')
  })

  it('item output uses emoji stats', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b boomerang')!
    expect(result).toContain('🗡️20')
    expect(result).toContain('🕐4s')
  })

  it('enchantment output includes tags and tooltip', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b fiery boomerang')!
    expect(result).toContain('[Boomerang - Fiery]')
    expect(result).toContain('[Burn]')
    expect(result).toContain('Burn for')
  })
})

// ---------------------------------------------------------------------------
// Analytics logging
// ---------------------------------------------------------------------------
describe('analytics logging', () => {
  it('logs hit on exact item match', () => {
    mockExact.mockImplementation(() => boomerang)
    handleCommand('!b boomerang', { user: 'tidolar', channel: 'mellen' })
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).toContain('type:item')
    expect(hitCall![1]).toContain('match:Boomerang')
    expect(hitCall![1]).toContain('user:tidolar')
    expect(hitCall![1]).toContain('ch:mellen')
  })

  it('logs hit on fuzzy item match', () => {
    mockSearch.mockImplementation(() => [boomerang])
    handleCommand('!b boom', { user: 'chatter' })
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).toContain('type:item')
    expect(hitCall![1]).toContain('q:boom')
    expect(hitCall![1]).toContain('match:Boomerang')
  })

  it('logs hit with tier on tiered item lookup', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    handleCommand('!b diamond boomerang', { user: 'test' })
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).toContain('tier:Diamond')
  })

  it('logs hit on enchantment lookup', () => {
    mockExact.mockImplementation(() => boomerang)
    handleCommand('!b fiery boomerang', { user: 'test' })
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).toContain('type:enchant')
    expect(hitCall![1]).toContain('match:Boomerang+Fiery')
  })

  it('logs hit on monster lookup via mob prefix', () => {
    const lich: Monster = {
      Id: 'lich-001', Type: 'CombatEncounter', Title: { Text: 'Lich' },
      Description: null, Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [], Uri: '',
      MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [] },
    }
    mockFindMonster.mockImplementation(() => lich)
    handleCommand('!b mob lich', { user: 'test' })
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).toContain('type:mob')
    expect(hitCall![1]).toContain('match:Lich')
  })

  it('logs hit on hero lookup', () => {
    mockByHero.mockImplementation(() => [boomerang])
    handleCommand('!b hero vanessa', { user: 'test' })
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).toContain('type:hero')
    expect(hitCall![1]).toContain('q:vanessa')
  })

  it('logs miss with user context', () => {
    handleCommand('!b xyznothing', { user: 'chatter', channel: 'stream' })
    const missCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('misses'))
    expect(missCall).toBeTruthy()
    expect(missCall![1]).toContain('xyznothing')
    expect(missCall![1]).toContain('user:chatter')
    expect(missCall![1]).toContain('ch:stream')
  })

  it('logs mob miss with user context', () => {
    handleCommand('!b mob xyzmonster', { user: 'test' })
    const missCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('misses'))
    expect(missCall).toBeTruthy()
    expect(missCall![1]).toContain('mob:xyzmonster')
    expect(missCall![1]).toContain('user:test')
  })

  it('does not log on help/usage', () => {
    handleCommand('!b help', { user: 'test' })
    expect(mockAppendFileSync).not.toHaveBeenCalled()
  })

  it('works without context (backwards compat)', () => {
    mockExact.mockImplementation(() => boomerang)
    handleCommand('!b boomerang')
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).not.toContain(' user:')
    expect(hitCall![1]).not.toContain(' ch:')
  })

  it('logs implicit monster match (no mob prefix)', () => {
    const lich: Monster = {
      Id: 'lich-001', Type: 'CombatEncounter', Title: { Text: 'Lich' },
      Description: null, Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [], Uri: '',
      MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [] },
    }
    mockFindMonster.mockImplementation(() => lich)
    handleCommand('!b lich', { user: 'test' })
    const hitCall = mockAppendFileSync.mock.calls.find((c) => c[0].includes('hits'))
    expect(hitCall).toBeTruthy()
    expect(hitCall![1]).toContain('type:mob')
  })
})
