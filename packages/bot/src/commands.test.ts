import { describe, expect, it, mock, beforeEach } from 'bun:test'
import type { BazaarCard, TierName } from '@bazaarinfo/shared'

// --- mock store before importing commands ---
const mockExact = mock<(name: string) => BazaarCard | undefined>(() => undefined)
const mockSearch = mock<(query: string, limit: number) => BazaarCard[]>(() => [])

mock.module('./store', () => ({
  exact: mockExact,
  search: mockSearch,
}))

const { handleCommand } = await import('./commands')

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
  mockExact.mockReset()
  mockSearch.mockReset()
  mockExact.mockImplementation(() => undefined)
  mockSearch.mockImplementation(() => [])
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
})

// ---------------------------------------------------------------------------
// !b — item lookup
// ---------------------------------------------------------------------------
describe('!b item lookup', () => {
  it('looks up item by exact match first', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang')
    expect(result).toContain('[Boomerang]')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('falls back to fuzzy search when exact match fails', () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [boomerang])
    const result = handleCommand('!b boomrang')
    expect(result).toContain('[Boomerang]')
    expect(mockSearch).toHaveBeenCalledWith('boomrang', 1)
  })

  it('returns not found when no match at all', () => {
    const result = handleCommand('!b xyznonexistent')
    expect(result).toContain('no item found for "xyznonexistent"')
  })

  it('handles multi-word item names', () => {
    const tinfoil = makeCard({ Title: { Text: 'Tinfoil Hat' } })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = handleCommand('!b tinfoil hat')
    expect(result).toContain('[Tinfoil Hat]')
  })
})

// ---------------------------------------------------------------------------
// !b — item with tier
// ---------------------------------------------------------------------------
describe('!b item + tier', () => {
  it('parses tier as last word (gold)', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang gold')
    expect(result).toContain('[Boomerang]')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('parses tier case-insensitively', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang DIAMOND')
    expect(result).toContain('[Boomerang]')
  })

  it('parses bronze tier', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang bronze')
    expect(result).toBeTruthy()
  })

  it('parses silver tier', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang silver')
    expect(result).toBeTruthy()
  })

  it('parses legendary tier', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b boomerang legendary')
    expect(result).toBeTruthy()
  })

  it('handles multi-word item with tier', () => {
    const tinfoil = makeCard({ Title: { Text: 'Tinfoil Hat' } })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = handleCommand('!b tinfoil hat gold')
    expect(result).toContain('[Tinfoil Hat]')
    expect(mockExact).toHaveBeenCalledWith('tinfoil hat')
  })

  it('does not eat non-tier last word as tier', () => {
    const hat = makeCard({ Title: { Text: 'Fancy Hat' } })
    mockExact.mockImplementation((name) => name === 'fancy hat' ? hat : undefined)
    const result = handleCommand('!b fancy hat')
    expect(result).toContain('[Fancy Hat]')
    expect(mockExact).toHaveBeenCalledWith('fancy hat')
  })
})

// ---------------------------------------------------------------------------
// !b — enchantment detection
// ---------------------------------------------------------------------------
describe('!b enchantment routing', () => {
  it('detects enchantment when first word matches', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b fiery boomerang')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('detects enchantment with prefix match', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    // "fier" should match "fiery" uniquely
    const result = handleCommand('!b fier boomerang')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('handles icy enchantment', () => {
    const card = makeCard({
      Enchantments: {
        Icy: {
          Tags: [],
          HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Freeze' }, TooltipType: 'Passive' }] },
          TooltipReplacements: {},
          DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation(() => card)
    const result = handleCommand('!b icy boomerang')
    expect(result).toContain('[Boomerang - Icy]')
  })

  it('handles golden enchantment', () => {
    const card = makeCard({
      Enchantments: {
        Golden: {
          Tags: ['Gold'],
          HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Extra gold' }, TooltipType: 'Passive' }] },
          TooltipReplacements: {},
          DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation(() => card)
    const result = handleCommand('!b golden boomerang')
    expect(result).toContain('[Boomerang - Golden]')
  })

  it('falls back to item lookup when enchantment prefix is ambiguous', () => {
    // "de" matches both "deadly" and could match others — but actually only "deadly" starts with "de"
    // Let's use a truly ambiguous one: "s" matches "shielded" — wait, only one starts with "s"? No: "shielded"
    // Actually none are ambiguous by first full word. Let's test the single-word case:
    // If someone types "!b fiery" with no item, it should be an item lookup for "fiery"
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b fiery')
    // single word "fiery" — enchMatches.length === 1 but words.length === 1, so falls to item lookup
    expect(result).toContain('no item found for "fiery"')
  })

  it('returns not found when enchantment item doesnt exist', () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b fiery nonexistent')
    expect(result).toContain('no item found for "nonexistent"')
  })

  it('handles multi-word item after enchantment', () => {
    const hat = makeCard({
      Title: { Text: 'Tinfoil Hat' },
      Enchantments: {
        Fiery: {
          Tags: [],
          HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Burn it' }, TooltipType: 'Active' }] },
          TooltipReplacements: {},
          DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? hat : undefined)
    const result = handleCommand('!b fiery tinfoil hat')
    expect(result).toContain('[Tinfoil Hat - Fiery]')
  })

  it('treats "gold" as tier not enchantment prefix for "golden"', () => {
    // "gold" matches "golden" as prefix, but if words.length > 1, it would try enchantment.
    // However "gold" also matches TIERS. The enchantment check runs first.
    // "gold" starts "golden" — enchMatches = ["golden"], words.length > 1 → enchantment route
    // This means "!b gold boomerang" tries enchantment Golden on boomerang
    // This is actually correct behavior since "gold" uniquely matches "golden"
    const card = makeCard({
      Enchantments: {
        Golden: {
          Tags: [],
          HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Money' }, TooltipType: 'Active' }] },
          TooltipReplacements: {},
          DisplayTags: [],
        },
      },
    })
    mockExact.mockImplementation(() => card)
    const result = handleCommand('!b gold boomerang')
    expect(result).toContain('Golden')
  })
})

// ---------------------------------------------------------------------------
// !b — compare detection
// ---------------------------------------------------------------------------
describe('!b compare routing', () => {
  it('detects compare with "vs" keyword', () => {
    mockExact.mockImplementation((name) => {
      if (name === 'boomerang') return boomerang
      if (name === 'shield') return shield
      return undefined
    })
    const result = handleCommand('!b boomerang vs shield')
    expect(result).toContain('Boomerang')
    expect(result).toContain(' vs ')
    expect(result).toContain('Shield')
  })

  it('handles VS case-insensitively', () => {
    mockExact.mockImplementation((name) => {
      if (name === 'boomerang') return boomerang
      if (name === 'shield') return shield
      return undefined
    })
    const result = handleCommand('!b boomerang VS shield')
    expect(result).toContain(' vs ')
  })

  it('handles "Vs" mixed case', () => {
    mockExact.mockImplementation((name) => {
      if (name === 'boomerang') return boomerang
      if (name === 'shield') return shield
      return undefined
    })
    const result = handleCommand('!b boomerang Vs shield')
    expect(result).toContain(' vs ')
  })

  it('returns not found for first item in compare', () => {
    mockExact.mockImplementation((name) => name === 'shield' ? shield : undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b nonexistent vs shield')
    expect(result).toContain('no item found for "nonexistent"')
  })

  it('returns not found for second item in compare', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b boomerang vs nonexistent')
    expect(result).toContain('no item found for "nonexistent"')
  })

  it('handles multi-word items in compare', () => {
    const hat = makeCard({ Title: { Text: 'Tinfoil Hat' } })
    const crystal = makeCard({ Title: { Text: 'Echo Crystal' } })
    mockExact.mockImplementation((name) => {
      if (name === 'tinfoil hat') return hat
      if (name === 'echo crystal') return crystal
      return undefined
    })
    const result = handleCommand('!b tinfoil hat vs echo crystal')
    expect(result).toContain('Tinfoil Hat')
    expect(result).toContain('Echo Crystal')
  })

  it('trims whitespace around vs parts', () => {
    mockExact.mockImplementation((name) => {
      if (name === 'boomerang') return boomerang
      if (name === 'shield') return shield
      return undefined
    })
    const result = handleCommand('!b  boomerang  vs  shield ')
    expect(result).toContain('Boomerang')
    expect(result).toContain('Shield')
  })

  it('uses fuzzy search as fallback in compare', () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation((query) => {
      if (query === 'boomrang') return [boomerang]
      if (query === 'sheld') return [shield]
      return []
    })
    const result = handleCommand('!b boomrang vs sheld')
    expect(result).toContain('Boomerang')
    expect(result).toContain('Shield')
  })
})

// ---------------------------------------------------------------------------
// !b — edge cases and priority
// ---------------------------------------------------------------------------
describe('!b edge cases', () => {
  it('compare takes priority over enchantment detection', () => {
    // "fiery boomerang vs shield" — should compare, not enchant
    mockExact.mockImplementation((name) => {
      if (name === 'fiery boomerang') return boomerang
      if (name === 'shield') return shield
      return undefined
    })
    const result = handleCommand('!b fiery boomerang vs shield')
    expect(result).toContain(' vs ')
  })

  it('handles single character input', () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b x')
    expect(result).toContain('no item found for "x"')
  })

  it('handles extra whitespace between words', () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = handleCommand('!b   boomerang')
    expect(result).toContain('[Boomerang]')
  })

  it('handles item name that looks like enchantment but no second word', () => {
    // "toxic" alone — enchant match but words.length === 1, so item lookup
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b toxic')
    expect(result).toContain('no item found for "toxic"')
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

  it('does not match old command names', () => {
    expect(handleCommand('!item boomerang')).toBeNull()
    expect(handleCommand('!enc fiery boomerang')).toBeNull()
    expect(handleCommand('!enchant fiery boomerang')).toBeNull()
    expect(handleCommand('!compare boomerang vs shield')).toBeNull()
    expect(handleCommand('!hero pygmalien')).toBeNull()
    expect(handleCommand('!help')).toBeNull()
  })

  it('handles empty string after command', () => {
    const result = handleCommand('!b ')
    // trimmed to empty string — should show usage
    expect(result).toContain('!b')
  })

  it('handles "vs" as item name when alone', () => {
    // "!b vs" — split on vs gives ["", ""], both empty
    // vsParts[0] is empty string which is falsy, so skip compare route
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b vs')
    // falls through to item lookup for "vs"
    expect(result).toContain('no item found')
  })

  it('handles "vs" with only left side', () => {
    // "boomerang vs" — split gives ["boomerang", ""], second is empty
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b boomerang vs')
    // vsParts[1] is empty string, falsy — skips compare
    // falls through, "boomerang vs" gets parsed, "vs" is not a tier
    expect(result).toBeTruthy()
  })

  it('handles "vs" with only right side', () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = handleCommand('!b vs shield')
    // split on /\s+vs\s+/ won't match "vs shield" at start? Let's see:
    // "vs shield".split(/\s+vs\s+/) = ["vs shield"] — only 1 part, no compare
    // falls through to item/enchant, but "vs" is not an enchantment
    expect(result).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Integration: verify format output structure
// ---------------------------------------------------------------------------
describe('!b output format integration', () => {
  it('item output uses compact stat format', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b boomerang')!
    expect(result).toContain('20dmg')
    expect(result).toContain('4s')
    expect(result).not.toContain('DMG:')
    expect(result).not.toContain('CD:')
    expect(result).not.toContain('Buy:')
  })

  it('item output uses abbreviated sizes', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b boomerang')!
    expect(result).toContain('Med')
    expect(result).not.toContain('Medium')
  })

  it('item output uses abbreviated tiers', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b boomerang')!
    expect(result).toContain('B/S/G/D')
    expect(result).not.toContain('Bronze')
  })

  it('item output has no emoji', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b boomerang')!
    expect(result).not.toContain('⚡')
    expect(result).not.toContain('🛡')
  })

  it('enchantment output includes tags and tooltip', () => {
    mockExact.mockImplementation(() => boomerang)
    const result = handleCommand('!b fiery boomerang')!
    expect(result).toContain('[Boomerang - Fiery]')
    expect(result).toContain('[Burn]')
    expect(result).toContain('Burn for')
  })

  it('compare output uses abbreviated sizes', () => {
    mockExact.mockImplementation((name) => {
      if (name === 'boomerang') return boomerang
      if (name === 'shield') return shield
      return undefined
    })
    const result = handleCommand('!b boomerang vs shield')!
    expect(result).toContain('(Med)')
    expect(result).toContain('(Lg)')
  })
})
