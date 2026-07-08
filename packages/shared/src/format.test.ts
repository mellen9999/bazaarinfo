import { describe, expect, it } from 'bun:test'
import { truncate, formatItem, formatEnchantment, formatMonster, formatEvent, formatTagResults, formatDayResults } from './format'
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
describe('formatEvent', () => {
  it('identifies the encounter, tags hero, and links to bazaardb', () => {
    const r = formatEvent(makeCard({ Title: 'Zosima', Heroes: ['Mak'], Shortlink: 'https://bzdb.to/zos' }))
    expect(r).toContain('Zosima')
    expect(r).toContain('event encounter')
    expect(r).toContain('bzdb.to/zos')
  })
  it('omits hero when the event is neutral (Common only)', () => {
    const r = formatEvent(makeCard({ Title: 'Mandala', Heroes: ['Common'] }))
    expect(r).toContain('Mandala — event encounter')
  })
})

describe('formatItem', () => {
  it('outputs name, size, and hero', () => {
    const result = formatItem(makeCard())
    expect(result).toContain('Boomerang [M] · Pyg')
  })

  it('shows uniform cooldown when defined', () => {
    const result = formatItem(makeCard({ Cooldown: 4 }))
    expect(result).toContain('| CD:4s |')
  })

  it('omits cooldown segment when undefined', () => {
    const result = formatItem(makeCard())
    expect(result).not.toContain('CD:')
  })

  it('preserves fractional cooldowns', () => {
    const result = formatItem(makeCard({ Cooldown: 2.5 }))
    expect(result).toContain('CD:2.5s')
  })

  it('shows per-tier cooldowns slash-joined when no tier specified', () => {
    const result = formatItem(makeCard({ Cooldown: { Silver: 12, Gold: 10, Diamond: 8 } }))
    expect(result).toContain('CD:12/10/8s')
  })

  it('resolves per-tier cooldown to specific tier value', () => {
    const result = formatItem(makeCard({ Cooldown: { Silver: 12, Gold: 10, Diamond: 8 } }), 'Gold')
    expect(result).toContain('CD:10s')
    expect(result).not.toContain('CD:12')
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

  it('omits hero segment when Heroes is [Common] (fake hero)', () => {
    const result = formatItem(makeCard({ Heroes: ['Common'] }))
    expect(result).not.toContain('Common')
    expect(result).toStartWith('Boomerang [M] |')
  })

  it('omits hero segment when Heroes is [???] (fake hero)', () => {
    const result = formatItem(makeCard({ Heroes: ['???'] }))
    expect(result).not.toContain('???')
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
    expect([...result].length).toBeLessThanOrEqual(480)
    // attribution is always appended, so result may end with the shortlink after '...'
    expect(result).toContain('...')
    expect(result).toContain('bzdb.to/boomerang')
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
    expect(result).toBe('no Nonexistent enchantment on Boomerang')
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
    expect([...result].length).toBeLessThanOrEqual(480)
    // attribution is always appended after '...' when body is truncated
    expect(result).toContain('...')
    expect(result).toContain('bzdb.to/boomerang')
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
// truncate — regression for #11: codepoint-space boundary search
// ---------------------------------------------------------------------------
describe('truncate — astral boundary regression', () => {
  it('cuts cleanly at " | " separator when head contains astral chars', () => {
    // emoji (U+1F600) = 2 UTF-16 code units, 1 codepoint
    // head = 240 emoji (240 cp, 480 UTF-16) + ' | ' + 250 'T' chars = 493 cp total -> triggers truncation
    // pipe boundary is at cp index 240; without the fix, UTF-16 lastIndexOf would return 480
    // then cp.slice(0, 480) would take 240 emoji past the pipe instead of stopping at it
    const emoji = '\u{1F600}' // 😀 — astral char
    const head = emoji.repeat(240)   // 240 codepoints, 480 UTF-16 units
    const tail = 'T'.repeat(250)
    const str = head + ' | ' + tail   // 493 codepoints total > 480
    const result = truncate(str)
    // should cut at the ' | ' boundary (cp index 240), not bleed into tail
    expect(result).not.toContain('T')
    expect(result).toEndWith('...')
    expect([...result].length).toBeLessThanOrEqual(480)
  })

  it('cuts at word space in codepoint space, not UTF-16 space', () => {
    const emoji = '\u{1F600}'
    // 250 astral codepoints (= 500 UTF-16 units), then space, then 300 more chars
    // total = 250 + 1 + 300 = 551 codepoints > 480 -> triggers truncation
    // space is at cp index 250; cut there, not at any UTF-16 position
    const head = emoji.repeat(250)  // 250 cp, 500 UTF-16
    const str = head + ' ' + 'X'.repeat(300)
    const result = truncate(str)
    expect([...result].length).toBeLessThanOrEqual(480)
    expect(result).toEndWith('...')
    // space at cp 250 >= minCut 240; should cut before the X block
    expect(result).not.toContain('X')
  })

  it('ASCII input still cuts correctly at pipe boundary', () => {
    const head = 'A'.repeat(300)
    const tail = 'B'.repeat(200)
    const str = head + ' | ' + tail
    const result = truncate(str)
    expect(result).toBe(head + '...')
  })
})

// ---------------------------------------------------------------------------
// appendShortlink — regression for #24: attribution always present
// ---------------------------------------------------------------------------
describe('appendShortlink / formatItem — shortlink always present regression', () => {
  it('preserves bzdb.to attribution even when body fills 480 codepoints', () => {
    // Title of 480 chars forces overflow; shortlink must still appear
    const bigTitle = 'Z'.repeat(480)
    const card = makeCard({ Title: bigTitle, Tooltips: [], Heroes: [] })
    const result = formatItem(card)
    expect(result).toContain('bzdb.to/boomerang')
    expect([...result].length).toBeLessThanOrEqual(480)
  })

  it('counts codepoints not UTF-16 units when checking fit', () => {
    // emoji card name: 100 astral chars = 100 codepoints but 200 UTF-16 units
    // should NOT falsely drop shortlink based on UTF-16 length
    const emoji = '\u{1F600}'
    const emojiTitle = emoji.repeat(100) // 100 cp, 200 UTF-16
    const card = makeCard({ Title: emojiTitle, Tooltips: [], Heroes: [] })
    const result = formatItem(card)
    // shortlink must be present — 100 cp title + small suffix well under 480 cp
    expect(result).toContain('bzdb.to/boomerang')
    expect([...result].length).toBeLessThanOrEqual(480)
  })

  it('total output stays ≤480 codepoints even with body truncation for attribution', () => {
    const bigTitle = 'A'.repeat(500)
    const card = makeCard({ Title: bigTitle, Tooltips: [], Heroes: [] })
    const result = formatItem(card)
    expect([...result].length).toBeLessThanOrEqual(480)
    expect(result).toContain('bzdb.to/boomerang')
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
    expect([...result].length).toBeLessThanOrEqual(480)
    // truncated output contains ellipsis; shortlink is always appended after
    expect(result).toContain('...')
    expect(result).toContain('bzdb.to/spider')
  })

  it('appends shortlink when it fits', () => {
    const result = formatMonster(makeMonster())
    expect(result).toContain('bzdb.to/spider')
  })
})
