import { describe, expect, it } from 'bun:test'
import { formatItem, formatEnchantment, formatMonster, formatTagResults, formatDayResults } from './format'
import type { BazaarCard, TierName, Monster } from './types'
import type { SkillDetail } from './format'

function makeCard(overrides: Partial<BazaarCard> = {}): BazaarCard {
  return {
    Type: 'Item',
    Title: 'Boomerang',
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'],
    Tooltips: [
      { text: 'Deal {DamageAmount} Damage', type: 'Active' },
      { text: 'Win vs Monster, get Loot.', type: 'Passive' },
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
        tags: ['Burn'],
        tooltips: [
          { text: 'Burn for {BurnAmount} damage', type: 'Active' },
        ],
        tooltipReplacements: {
          '{BurnAmount}': { Bronze: 5, Silver: 10, Gold: 15, Diamond: 20 },
        },
      },
    },
    Shortlink: 'https://bzdb.to/boomerang',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// formatItem
// ---------------------------------------------------------------------------
describe('formatItem', () => {
  it('outputs name, size, and hero', () => {
    const result = formatItem(makeCard())
    expect(result).toContain('Boomerang [M] · Pyg')
  })

  it('resolves fixed replacement values in tooltips', () => {
    const result = formatItem(makeCard())
    expect(result).toContain('Deal 60 Damage')
  })

  it('resolves tiered replacement values when tier specified', () => {
    const card = makeCard({
      Tooltips: [
        { text: 'Deal {Dmg} Damage', type: 'Active' },
      ],
      TooltipReplacements: {
        '{Dmg}': { Bronze: 10, Silver: 20, Gold: 30, Diamond: 40 },
      },
    })
    const result = formatItem(card, 'Gold')
    expect(result).toContain('Deal 30 Damage')
    expect(result).toStartWith('🟡 ')
  })

  it('prefixes tier emoji when tier specified', () => {
    expect(formatItem(makeCard(), 'Bronze')).toStartWith('🟤 Boomerang')
    expect(formatItem(makeCard(), 'Diamond')).toStartWith('💎 Boomerang')
    expect(formatItem(makeCard(), 'Legendary')).toStartWith('🟣 Boomerang')
  })

  it('no tier prefix when no tier specified', () => {
    const result = formatItem(makeCard())
    expect(result).toStartWith('Boomerang')
  })

  it('shows all tier values when no tier specified for tiered replacements', () => {
    const card = makeCard({
      Tooltips: [
        { text: 'Deal {Dmg} Damage', type: 'Active' },
      ],
      TooltipReplacements: {
        '{Dmg}': { Bronze: 10, Silver: 20, Gold: 30, Diamond: 40 },
      },
    })
    const result = formatItem(card)
    expect(result).toContain('🟤10/⚪20/🟡30/💎40')
  })

  it('leaves unresolved placeholders as-is', () => {
    const card = makeCard({
      Tooltips: [
        { text: 'Deal {Unknown} Damage', type: 'Active' },
      ],
      TooltipReplacements: {},
    })
    const result = formatItem(card)
    expect(result).toContain('{Unknown}')
  })

  it('joins multiple heroes with comma', () => {
    const result = formatItem(makeCard({
      Heroes: ['Pygmalien', 'Vanessa'],
    }))
    expect(result).toContain('Pyg, Vanessa')
  })

  it('handles card with no heroes', () => {
    const result = formatItem(makeCard({ Heroes: [] }))
    expect(result).toStartWith('Boomerang [M] |')
  })

  it('handles card with no tooltips', () => {
    const result = formatItem(makeCard({ Tooltips: [] }))
    expect(result).toBeTruthy()
    expect(result).toContain('Boomerang')
  })

  it('truncates output exceeding 480 chars', () => {
    const longName = 'A'.repeat(500)
    const result = formatItem(makeCard({
      Title: longName,
    }))
    expect(result.length).toBeLessThanOrEqual(480)
    expect(result).toEndWith('...')
  })

  it('does not truncate output at exactly 480 chars', () => {
    const result = formatItem(makeCard())
    expect(result.length).toBeLessThanOrEqual(480)
    if (result.length < 480) {
      expect(result).not.toEndWith('...')
    }
  })

  it('handles multiple abilities separated by pipes', () => {
    const result = formatItem(makeCard())
    expect(result).toContain('Deal 60 Damage | Win vs Monster, get Loot.')
  })

  it('appends shortlink when it fits', () => {
    const result = formatItem(makeCard())
    expect(result).toContain('bzdb.to/boomerang')
  })
})

// ---------------------------------------------------------------------------
// formatEnchantment
// ---------------------------------------------------------------------------
describe('formatEnchantment', () => {
  it('formats enchantment with card name and enchant name', () => {
    const result = formatEnchantment(makeCard(), 'Fiery')
    expect(result).toStartWith('[Boomerang - Fiery]')
  })

  it('includes tags in brackets', () => {
    const result = formatEnchantment(makeCard(), 'Fiery')
    expect(result).toContain('[Burn]')
  })

  it('omits tags section when no tags', () => {
    const card = makeCard({
      Enchantments: {
        Icy: {
          tags: [],
          tooltips: [{ text: 'Freeze target', type: 'Passive' }],
        },
      },
    })
    const result = formatEnchantment(card, 'Icy')
    expect(result).not.toContain('[]')
    expect(result).toContain('[Boomerang - Icy] Freeze target')
  })

  it('returns error message for missing enchantment', () => {
    const result = formatEnchantment(makeCard(), 'Nonexistent')
    expect(result).toBe('No "Nonexistent" enchantment for Boomerang')
  })

  it('resolves tiered values in enchantment tooltips with specific tier', () => {
    const result = formatEnchantment(makeCard(), 'Fiery', 'Gold')
    expect(result).toContain('Burn for 15 damage')
    expect(result).toStartWith('🟡 ')
  })

  it('prefixes tier emoji on enchantment when tier specified', () => {
    expect(formatEnchantment(makeCard(), 'Fiery', 'Diamond')).toStartWith('💎 [Boomerang')
  })

  it('no tier prefix on enchantment when no tier specified', () => {
    expect(formatEnchantment(makeCard(), 'Fiery')).toStartWith('[Boomerang')
  })

  it('shows all tier values when no tier specified', () => {
    const result = formatEnchantment(makeCard(), 'Fiery')
    expect(result).toContain('🟤5/⚪10/🟡15/💎20')
  })

  it('joins multiple enchantment tooltips with pipe', () => {
    const card = makeCard({
      Enchantments: {
        Multi: {
          tags: [],
          tooltips: [
            { text: 'Effect one', type: 'Active' },
            { text: 'Effect two', type: 'Passive' },
          ],
        },
      },
    })
    const result = formatEnchantment(card, 'Multi')
    expect(result).toContain('Effect one | Effect two')
  })

  it('truncates long enchantment output', () => {
    const card = makeCard({
      Enchantments: {
        Long: {
          tags: [],
          tooltips: [{ text: 'X'.repeat(500), type: 'Active' }],
        },
      },
    })
    const result = formatEnchantment(card, 'Long')
    expect(result.length).toBeLessThanOrEqual(480)
    expect(result).toEndWith('...')
  })

  it('includes multiple tags comma-separated', () => {
    const card = makeCard({
      Enchantments: {
        Tagged: {
          tags: ['Burn', 'Slow'],
          tooltips: [{ text: 'stuff', type: 'Active' }],
        },
      },
    })
    const result = formatEnchantment(card, 'Tagged')
    expect(result).toContain('[Burn, Slow]')
  })

  it('appends shortlink when it fits', () => {
    const result = formatEnchantment(makeCard(), 'Fiery')
    expect(result).toContain('bzdb.to/boomerang')
  })
})

// ---------------------------------------------------------------------------
// formatItem — size display
// ---------------------------------------------------------------------------
describe('formatItem size display', () => {
  it('shows [S] for Small items', () => {
    const result = formatItem(makeCard({ Size: 'Small' }))
    expect(result).toContain('Boomerang [S]')
  })

  it('shows [M] for Medium items', () => {
    const result = formatItem(makeCard({ Size: 'Medium' }))
    expect(result).toContain('Boomerang [M]')
  })

  it('shows [L] for Large items', () => {
    const result = formatItem(makeCard({ Size: 'Large' }))
    expect(result).toContain('Boomerang [L]')
  })
})

// ---------------------------------------------------------------------------
// formatTagResults
// ---------------------------------------------------------------------------
describe('formatTagResults', () => {
  it('formats tag results with names', () => {
    const cards = [makeCard({ Title: 'Sword' }), makeCard({ Title: 'Shield' })]
    const result = formatTagResults('Burn', cards)
    expect(result).toBe('[Burn] Sword, Shield')
  })

  it('returns not found for empty results', () => {
    expect(formatTagResults('Nope', [])).toBe('no items found with tag Nope')
  })

  it('truncates long results to 480', () => {
    const cards = Array.from({ length: 100 }, (_, i) =>
      makeCard({ Title: 'Item' + 'X'.repeat(20) + i }),
    )
    const result = formatTagResults('Test', cards)
    expect(result.length).toBeLessThanOrEqual(480)
  })
})

// ---------------------------------------------------------------------------
// formatDayResults
// ---------------------------------------------------------------------------
describe('formatDayResults', () => {
  function makeMonster(name: string, hp: number): Monster {
    return {
      Type: 'CombatEncounter', Title: name,
      Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [],
      MonsterMetadata: { available: 'Always', day: 5, health: hp, board: [], skills: [] },
      Shortlink: 'https://bzdb.to/test',
    }
  }

  it('formats day results with name and HP', () => {
    const result = formatDayResults(5, [makeMonster('Lich', 100), makeMonster('Dragon', 500)])
    expect(result).toBe('[Day 5] Lich (100HP), Dragon (500HP)')
  })

  it('returns not found for empty results', () => {
    expect(formatDayResults(9, [])).toBe('no monsters found for day 9')
  })
})

// ---------------------------------------------------------------------------
// formatMonster
// ---------------------------------------------------------------------------
describe('formatMonster', () => {
  function makeMonster(overrides: Partial<Monster> = {}): Monster {
    return {
      Type: 'CombatEncounter',
      Title: 'BLK-SP1D3R',
      Size: 'Medium',
      Tags: [],
      DisplayTags: [],
      HiddenTags: [],
      Heroes: [],
      MonsterMetadata: {
        available: 'Always',
        day: 3,
        health: 150,
        board: [],
        skills: [],
      },
      Shortlink: 'https://bzdb.to/spider',
      ...overrides,
    }
  }

  it('shows name, day, and HP', () => {
    const result = formatMonster(makeMonster())
    expect(result).toContain('BLK-SP1D3R · Day 3 · 150HP')
  })

  it('shows available string when day is null', () => {
    const m = makeMonster({
      MonsterMetadata: { available: 'Event Only', day: null, health: 200, board: [], skills: [] },
    })
    const result = formatMonster(m)
    expect(result).toContain('Event Only')
    expect(result).not.toContain('Day')
  })

  it('shows items from board', () => {
    const m = makeMonster({
      MonsterMetadata: {
        available: 'Always', day: 5, health: 300,
        board: [
          { title: 'Sword', tier: 'Gold', id: 'i1' },
          { title: 'Shield', tier: 'Silver', id: 'i2' },
        ],
        skills: [],
      },
    })
    const result = formatMonster(m)
    expect(result).toContain('🟡Sword')
    expect(result).toContain('⚪Shield')
  })

  it('deduplicates items with count', () => {
    const entry = { title: 'Sword', tier: 'Gold' as TierName, id: 'i1' }
    const m = makeMonster({
      MonsterMetadata: { available: 'Always', day: 5, health: 300, board: [entry, entry, entry], skills: [] },
    })
    const result = formatMonster(m)
    expect(result).toContain('🟡Sword x3')
  })

  it('shows skills with tooltips', () => {
    const m = makeMonster({
      MonsterMetadata: {
        available: 'Always', day: 2, health: 100,
        board: [],
        skills: [
          { title: 'Web Shot', tier: 'Bronze', id: 's1' },
        ],
      },
    })
    const skills = new Map<string, SkillDetail>([
      ['Web Shot', { name: 'Web Shot', tooltip: 'Slows enemy by 2s' }],
    ])
    const result = formatMonster(m, skills)
    expect(result).toContain('Web Shot: Slows enemy by 2s')
  })

  it('truncates at 480 chars', () => {
    const board = Array.from({ length: 50 }, (_, i) => ({
      title: `VeryLongItemNameThatIsQuiteLong${i}`, tier: 'Gold' as TierName, id: `i${i}`,
    }))
    const m = makeMonster({
      MonsterMetadata: { available: 'Always', day: 1, health: 999, board, skills: [] },
    })
    const result = formatMonster(m)
    expect(result.length).toBeLessThanOrEqual(480)
    // truncated output contains ellipsis (may also have shortlink appended)
    expect(result).toContain('...')
  })

  it('appends shortlink when it fits', () => {
    const result = formatMonster(makeMonster())
    expect(result).toContain('bzdb.to/spider')
  })
})
