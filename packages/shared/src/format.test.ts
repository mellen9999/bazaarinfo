import { describe, expect, it } from 'bun:test'
import { formatItem, formatEnchantment, formatCompare } from './format'
import type { BazaarCard, TierName } from './types'

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
      { Content: { Text: 'Win vs Monster, get Loot.' }, TooltipType: 'Passive' },
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
          Tooltips: [
            { Content: { Text: 'Burn for {BurnAmount} damage' }, TooltipType: 'Active' },
          ],
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

function t() {
  return { AbilityIds: [], AuraIds: [], OverrideAttributes: {}, ActiveTooltips: [] }
}

// ---------------------------------------------------------------------------
// formatItem
// ---------------------------------------------------------------------------
describe('formatItem', () => {
  it('outputs name and hero', () => {
    const result = formatItem(makeCard())
    expect(result).toStartWith('Boomerang · Pyg')
  })

  it('does not include Buy price', () => {
    const result = formatItem(makeCard({
      BaseAttributes: { DamageAmount: 20, CooldownMax: 4000, BuyPrice: 4 },
    }))
    expect(result).not.toContain('Buy')
    expect(result).not.toContain('4g') // could false-match but BuyPrice shouldn't appear
  })

  it('uses emoji prefixes on stats', () => {
    const result = formatItem(makeCard())
    expect(result).toContain('🗡️20')
    expect(result).toContain('🕐4s')
  })

  it('formats damage with sword emoji', () => {
    const result = formatItem(makeCard({
      BaseAttributes: { DamageAmount: 20 },
    }))
    expect(result).toContain('🗡️20')
  })

  it('formats shield with shield emoji', () => {
    const result = formatItem(makeCard({
      BaseAttributes: { ShieldApplyAmount: 15 },
    }))
    expect(result).toContain('🛡15')
  })

  it('formats heal with heart emoji', () => {
    const result = formatItem(makeCard({
      BaseAttributes: { HealAmount: 30 },
    }))
    expect(result).toContain('💚30')
  })

  it('formats cooldown with timer emoji', () => {
    const result = formatItem(makeCard({
      BaseAttributes: { CooldownMax: 5000 },
    }))
    expect(result).toContain('🕐5s')
  })

  it('shows multiple stats space-separated', () => {
    const result = formatItem(makeCard({
      BaseAttributes: { DamageAmount: 10, ShieldApplyAmount: 5, CooldownMax: 3000 },
    }))
    expect(result).toContain('🗡️10 🛡5 🕐3s')
  })

  it('omits stats segment when no stats', () => {
    const result = formatItem(makeCard({
      BaseAttributes: {},
    }))
    // header | ability (no stats segment with extra |)
    const pipes = result.split(' | ')
    expect(pipes[0]).toStartWith('Boomerang')
    // next segment should be ability text, not empty
    expect(pipes[1]).toContain('Deal')
  })

  it('resolves fixed replacement values in tooltips', () => {
    const result = formatItem(makeCard())
    expect(result).toContain('Deal 60 Damage')
  })

  it('resolves tiered replacement values when tier specified', () => {
    const card = makeCard({
      Tooltips: [
        { Content: { Text: 'Deal {Dmg} Damage' }, TooltipType: 'Active' },
      ],
      TooltipReplacements: {
        '{Dmg}': { Bronze: 10, Silver: 20, Gold: 30, Diamond: 40 },
      },
    })
    const result = formatItem(card, 'Gold')
    expect(result).toContain('Deal 30 Damage')
  })

  it('shows all tier values when no tier specified for tiered replacements', () => {
    const card = makeCard({
      Tooltips: [
        { Content: { Text: 'Deal {Dmg} Damage' }, TooltipType: 'Active' },
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
        { Content: { Text: 'Deal {Unknown} Damage' }, TooltipType: 'Active' },
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
    expect(result).toStartWith('Boomerang |')
  })

  it('handles card with no tooltips', () => {
    const result = formatItem(makeCard({ Tooltips: [] }))
    expect(result).toBeTruthy()
    expect(result).toContain('Boomerang')
  })

  it('truncates output exceeding 480 chars', () => {
    const longName = 'A'.repeat(500)
    const result = formatItem(makeCard({
      Title: { Text: longName },
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
    // "Deal 60 Damage" and "Win vs Monster, get Loot." joined by |
    expect(result).toContain('Deal 60 Damage | Win vs Monster, get Loot.')
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
          Tags: [],
          HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'Freeze target' }, TooltipType: 'Passive' }] },
          TooltipReplacements: {},
          DisplayTags: [],
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
  })

  it('shows all tier values when no tier specified', () => {
    const result = formatEnchantment(makeCard(), 'Fiery')
    expect(result).toContain('🟤5/⚪10/🟡15/💎20')
  })

  it('joins multiple enchantment tooltips with pipe', () => {
    const card = makeCard({
      Enchantments: {
        Multi: {
          Tags: [],
          HiddenTags: [],
          Localization: {
            Tooltips: [
              { Content: { Text: 'Effect one' }, TooltipType: 'Active' },
              { Content: { Text: 'Effect two' }, TooltipType: 'Passive' },
            ],
          },
          TooltipReplacements: {},
          DisplayTags: [],
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
          Tags: [],
          HiddenTags: [],
          Localization: {
            Tooltips: [{ Content: { Text: 'X'.repeat(500) }, TooltipType: 'Active' }],
          },
          TooltipReplacements: {},
          DisplayTags: [],
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
          Tags: ['Burn', 'Slow'],
          HiddenTags: [],
          Localization: { Tooltips: [{ Content: { Text: 'stuff' }, TooltipType: 'Active' }] },
          TooltipReplacements: {},
          DisplayTags: [],
        },
      },
    })
    const result = formatEnchantment(card, 'Tagged')
    expect(result).toContain('[Burn, Slow]')
  })
})

// ---------------------------------------------------------------------------
// formatCompare
// ---------------------------------------------------------------------------
describe('formatCompare', () => {
  it('formats two items separated by vs', () => {
    const a = makeCard({ Title: { Text: 'Sword' }, Size: 'Small', BaseAttributes: { DamageAmount: 30 } })
    const b = makeCard({ Title: { Text: 'Shield' }, Size: 'Large', BaseAttributes: { ShieldApplyAmount: 25 } })
    const result = formatCompare(a, b)
    expect(result).toContain('Sword vs Shield')
  })

  it('shows stats side-by-side with slash', () => {
    const a = makeCard({ BaseAttributes: { DamageAmount: 50 } })
    const b = makeCard({ BaseAttributes: { DamageAmount: 30 } })
    const result = formatCompare(a, b)
    expect(result).toContain('🗡️ 50/30')
  })

  it('shows dash for missing stat on one side', () => {
    const a = makeCard({ Title: { Text: 'Sword' }, BaseAttributes: { DamageAmount: 30 } })
    const b = makeCard({ Title: { Text: 'Shield' }, BaseAttributes: { ShieldApplyAmount: 25 } })
    const result = formatCompare(a, b)
    expect(result).toContain('🗡️ 30/—')
    expect(result).toContain('🛡 —/25')
  })

  it('shows cooldown side-by-side', () => {
    const a = makeCard({ BaseAttributes: { CooldownMax: 6000 } })
    const b = makeCard({ BaseAttributes: { CooldownMax: 3000 } })
    const result = formatCompare(a, b)
    expect(result).toContain('🕐 6s/3s')
  })

  it('handles items with no stats', () => {
    const a = makeCard({ Title: { Text: 'Hat' }, Size: 'Small', BaseAttributes: {} })
    const b = makeCard({ Title: { Text: 'Cap' }, Size: 'Small', BaseAttributes: {} })
    const result = formatCompare(a, b)
    expect(result).toBe('Hat vs Cap')
  })

  it('shows size diff when different', () => {
    const a = makeCard({ Title: { Text: 'X' }, Size: 'Small', BaseAttributes: {} })
    const b = makeCard({ Title: { Text: 'Y' }, Size: 'Large', BaseAttributes: {} })
    const result = formatCompare(a, b)
    expect(result).toContain('Sm/Lg')
  })

  it('omits size when same', () => {
    const a = makeCard({ Title: { Text: 'X' }, Size: 'Medium', BaseAttributes: {} })
    const b = makeCard({ Title: { Text: 'Y' }, Size: 'Medium', BaseAttributes: {} })
    const result = formatCompare(a, b)
    expect(result).not.toContain('Med')
  })

  it('shows all stat categories side-by-side', () => {
    const a = makeCard({
      Title: { Text: 'X' },
      BaseAttributes: { DamageAmount: 10, ShieldApplyAmount: 5, HealAmount: 3, CooldownMax: 2000 },
    })
    const b = makeCard({ Title: { Text: 'Y' }, BaseAttributes: {} })
    const result = formatCompare(a, b)
    expect(result).toContain('🗡️ 10/—')
    expect(result).toContain('🛡 5/—')
    expect(result).toContain('💚 3/—')
    expect(result).toContain('🕐 2s/—')
  })

  it('shows tier in header when specified', () => {
    const a = makeCard({ Title: { Text: 'Sword' }, BaseAttributes: { DamageAmount: 30 } })
    const b = makeCard({ Title: { Text: 'Shield' }, BaseAttributes: { DamageAmount: 20 } })
    const result = formatCompare(a, b, 'Gold', 'Diamond')
    expect(result).toContain('Sword (Gold) vs Shield (Diamond)')
  })

  it('truncates very long compare output', () => {
    const longA = makeCard({ Title: { Text: 'A'.repeat(250) } })
    const longB = makeCard({ Title: { Text: 'B'.repeat(250) } })
    const result = formatCompare(longA, longB)
    expect(result.length).toBeLessThanOrEqual(480)
    expect(result).toEndWith('...')
  })
})
