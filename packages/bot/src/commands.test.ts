import { describe, expect, it, mock, beforeEach } from 'bun:test'
import type { BazaarCard, TierName, Monster } from '@bazaarinfo/shared'

// --- mock store before importing commands ---
const mockExact = mock<(name: string) => BazaarCard | undefined>(() => undefined)
const mockSearch = mock<(query: string, limit: number) => BazaarCard[]>(() => [])
const mockGetEnchantments = mock<() => string[]>(() => [])
const mockByHero = mock<(hero: string) => BazaarCard[]>(() => [])
const mockFindMonster = mock<(query: string) => Monster | undefined>(() => undefined)
const mockFindCard = mock<(name: string) => BazaarCard | undefined>(() => undefined)
const mockByTag = mock<(tag: string) => BazaarCard[]>(() => [])
const mockMonstersByDay = mock<(day: number) => Monster[]>(() => [])
const mockFindSkill = mock<(query: string) => BazaarCard | undefined>(() => undefined)
const mockGetItems = mock<() => BazaarCard[]>(() => [])
const mockGetMonsters = mock<() => Monster[]>(() => [])
const mockGetSkills = mock<() => BazaarCard[]>(() => [])
const mockFindHeroName = mock<(query: string) => string | undefined>(() => undefined)
const mockFindTagName = mock<(query: string) => string | undefined>(() => undefined)
const mockSuggest = mock<(query: string, limit?: number) => string[]>(() => [])
const mockGetHeroNames = mock<() => string[]>(() => [])
const mockGetTagNames = mock<() => string[]>(() => [])

mock.module('./store', () => ({
  exact: mockExact,
  search: mockSearch,
  getEnchantments: mockGetEnchantments,
  byHero: mockByHero,
  findMonster: mockFindMonster,
  findCard: mockFindCard,
  byTag: mockByTag,
  monstersByDay: mockMonstersByDay,
  findSkill: mockFindSkill,
  getItems: mockGetItems,
  getMonsters: mockGetMonsters,
  getSkills: mockGetSkills,
  findHeroName: mockFindHeroName,
  findTagName: mockFindTagName,
  suggest: mockSuggest,
  getHeroNames: mockGetHeroNames,
  getTagNames: mockGetTagNames,
}))

// --- mock db ---
const mockLogCommand = mock<(...args: any[]) => void>(() => {})
const mockGetOrCreateUser = mock<(username: string) => number>(() => 1)

mock.module('./db', () => ({
  logCommand: mockLogCommand,
  getOrCreateUser: mockGetOrCreateUser,
  logChat: mock(() => {}),
  getUserStats: mock(() => null),
  getChannelLeaderboard: mock(() => []),
  getTriviaLeaderboard: mock(() => []),
  createTriviaGame: mock(() => 1),
  recordTriviaAnswer: mock(() => {}),
  recordTriviaWin: mock(() => {}),
  recordTriviaAttempt: mock(() => {}),
  resetTriviaStreak: mock(() => {}),
}))


// --- mock ai ---
const mockAiRespond = mock<(...args: any[]) => any>(() => null)
const mockGetAiCooldown = mock<(user: string, channel?: string) => number>(() => 0)
mock.module('./ai', () => ({
  aiRespond: mockAiRespond,
  getAiCooldown: mockGetAiCooldown,
  initSummarizer: mock(() => {}),
  invalidatePromptCache: mock(() => {}),
  sanitize: mock((t: string) => ({ text: t, mentions: [] })),
  dedupeEmote: mock((t: string) => t),
  fixEmoteCase: mock((t: string) => t),
}))

// --- mock trivia ---
mock.module('./trivia', () => ({
  startTrivia: mock(() => 'Trivia! test question (30s to answer)'),
  getTriviaScore: mock(() => 'no trivia scores yet'),
  formatStats: mock((u: string) => `[${u}] cmds:0`),
  formatTop: mock(() => 'no activity yet'),
  checkAnswer: mock(() => {}),
  isGameActive: mock(() => false),
  setSay: mock(() => {}),
  matchAnswer: mock(() => false),
  invalidateAliasCache: mock(() => {}),
  looksLikeAnswer: mock(() => true),
  resetForTest: mock(() => {}),
  getActiveGameForTest: mock(() => undefined),
}))

// --- mock emotes ---
const mockIsEmote = mock<(name: string) => boolean>(() => false)
mock.module('./emotes', () => ({
  isEmote: mockIsEmote,
  refreshGlobalEmotes: mock(async () => []),
  refreshChannelEmotes: mock(async () => []),
  getEmotesForChannel: mock(() => []),
  formatEmotesForAI: mock(() => ''),
  getEmoteSetId: mock(() => undefined),
  getAllEmoteSetIds: mock(() => new Map()),
  getGlobalEmoteSetId: mock(() => ''),
  addChannelEmote: mock(() => {}),
  removeChannelEmote: mock(() => {}),
  renameChannelEmote: mock(() => {}),
  removeChannelEmotes: mock(() => {}),
}))

const { handleCommand, parseArgs, resetDedup, resetProxyCooldowns, PROXY_COOLDOWN } = await import('./commands')

// --- test fixtures ---
function makeCard(overrides: Partial<BazaarCard> = {}): BazaarCard {
  return {
    Type: 'Item',
    Title: 'Boomerang',
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'],
    Tooltips: [
      { text: 'Deal {DamageAmount} Damage', type: 'Active' },
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
        tooltips: [{ text: 'Burn for {BurnAmount}', type: 'Active' }],
        tooltipReplacements: {
          '{BurnAmount}': { Bronze: 5, Silver: 10, Gold: 15, Diamond: 20 },
        },
      },
    },
    Shortlink: 'https://bzdb.to/boomerang',
    ...overrides,
  }
}

const boomerang = makeCard()
const shield = makeCard({
  Title: 'Shield',
  Size: 'Large',
  Tooltips: [{ text: 'Block damage', type: 'Passive' }],
  TooltipReplacements: {},
  Heroes: ['Vanessa'],
  Enchantments: {},
  Shortlink: 'https://bzdb.to/shield',
})

beforeEach(() => {
  resetDedup()
  resetProxyCooldowns()
  mockLogCommand.mockReset()
  mockExact.mockReset()
  mockSearch.mockReset()
  mockGetEnchantments.mockReset()
  mockByHero.mockReset()
  mockFindMonster.mockReset()
  mockFindCard.mockReset()
  mockExact.mockImplementation(() => undefined)
  mockSearch.mockImplementation(() => [])
  mockGetEnchantments.mockImplementation(() => [
    'golden', 'heavy', 'icy', 'turbo', 'shielded', 'toxic',
    'fiery', 'deadly', 'radiant', 'obsidian', 'restorative', 'aegis',
  ])
  mockByHero.mockImplementation(() => [])
  mockFindMonster.mockImplementation(() => undefined)
  mockFindCard.mockImplementation(() => undefined)
  mockByTag.mockReset()
  mockMonstersByDay.mockReset()
  mockFindSkill.mockReset()
  mockFindHeroName.mockReset()
  mockFindTagName.mockReset()
  mockSuggest.mockReset()
  mockByTag.mockImplementation(() => [])
  mockMonstersByDay.mockImplementation(() => [])
  mockFindSkill.mockImplementation(() => undefined)
  mockFindHeroName.mockImplementation(() => undefined)
  mockFindTagName.mockImplementation(() => undefined)
  mockSuggest.mockImplementation(() => [])
  mockAiRespond.mockReset()
  mockAiRespond.mockImplementation(() => null)
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
    mockGetEnchantments.mockImplementation(() => ['fiery', 'fierce'])
    const result = parseArgs(['fie', 'boomerang'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('fie boomerang')
  })

  it('does not extract 2-char prefix as enchant ("to" should not match "toxic")', () => {
    mockGetEnchantments.mockImplementation(() => ['toxic'])
    const result = parseArgs(['reason', 'to', 'live'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('reason to live')
  })

  it('does not extract 1-char prefix as enchant ("a" should not match "aegis")', () => {
    mockGetEnchantments.mockImplementation(() => ['aegis'])
    const result = parseArgs(['a', 'reason', 'to', 'live'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('a reason to live')
  })

  it('does not extract "re" as enchant for "restorative"', () => {
    mockGetEnchantments.mockImplementation(() => ['restorative'])
    const result = parseArgs(['red', 'rocket'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('red rocket')
  })

  it('rejects short prefix too far from enchant name ("tox" != "toxic")', () => {
    mockGetEnchantments.mockImplementation(() => ['toxic'])
    const result = parseArgs(['tox', 'boomerang'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('tox boomerang')
  })

  it('accepts prefix within 80% of enchant name ("toxi" matches "toxic")', () => {
    mockGetEnchantments.mockImplementation(() => ['toxic'])
    const result = parseArgs(['toxi', 'boomerang'])
    expect(result.enchant).toBe('Toxic')
    expect(result.item).toBe('boomerang')
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
      expect(result.tier).toBe((tier[0].toUpperCase() + tier.slice(1)) as TierName)
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
  it('returns null for non-command text', async () => {
    expect(await handleCommand('hello world')).toBeNull()
  })

  it('returns null for unknown commands', async () => {
    expect(await handleCommand('!unknown test')).toBeNull()
  })

  it('returns null for text without ! prefix', async () => {
    expect(await handleCommand('bazaar boomerang')).toBeNull()
  })

  it('handles !b case-insensitively', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = await handleCommand('!B boomerang')
    expect(result).toBeTruthy()
    expect(result).toContain('Boomerang')
  })

  it('shows usage when no args given', async () => {
    const result = await handleCommand('!b')
    expect(result).toContain('!b')
    expect(result).toContain('<item>')
  })

  it('trims whitespace from args', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = await handleCommand('!b   boomerang   ')
    expect(result).toContain('Boomerang')
  })

  it('removed aliases do not route', async () => {
    expect(await handleCommand('!item boomerang')).toBeNull()
    expect(await handleCommand('!enchant fiery boomerang')).toBeNull()
    expect(await handleCommand('!compare boomerang')).toBeNull()
    expect(await handleCommand('!bazaarinfo boomerang')).toBeNull()
  })

  it('only !b routes to handler', async () => {
    mockExact.mockImplementation(() => boomerang)
    expect(await handleCommand('!b boomerang')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// !b — item lookup
// ---------------------------------------------------------------------------
describe('!b item lookup', () => {
  it('looks up item by exact match first', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b boomerang')
    expect(result).toContain('Boomerang [M]')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('falls back to fuzzy search when exact match fails', async () => {
    mockSearch.mockImplementation(() => [boomerang])
    const result = await handleCommand('!b boomrang')
    expect(result).toContain('Boomerang [M]')
    expect(mockSearch).toHaveBeenCalledWith('boomrang', 1)
  })

  it('returns shrug when no match and AI unavailable', async () => {
    const result = await handleCommand('!b xyznonexistent')
    expect(result).toContain('¯\\_(ツ)_/¯')
  })

  it('handles multi-word item names', async () => {
    const tinfoil = makeCard({ Title: 'Tinfoil Hat' })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = await handleCommand('!b tinfoil hat')
    expect(result).toContain('Tinfoil Hat [M]')
  })

  it('falls back to monster if no item found', async () => {
    const lich: Monster = {
      Type: 'CombatEncounter', Title: 'Lich',
      Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [],
      MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [], skills: [] },
      Shortlink: 'https://bzdb.to/lich',
    }
    mockFindMonster.mockImplementation((q) => q === 'lich' ? lich : undefined)
    const result = await handleCommand('!b lich')
    expect(result).toContain('Lich')
    expect(result).toContain('Day 5')
  })

  it('includes shortlink in item response', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = await handleCommand('!b boomerang')
    expect(result).toContain('bzdb.to/boomerang')
  })

  it('silently ignores known emotes', async () => {
    mockIsEmote.mockImplementation((name) => name === 'KEKW')
    const result = await handleCommand('!b KEKW')
    expect(result).toBeNull()
    mockIsEmote.mockImplementation(() => false)
  })

  it('does not filter emotes when tier is specified', async () => {
    mockIsEmote.mockImplementation((name) => name === 'KEKW')
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = await handleCommand('!b KEKW gold')
    // should not be null — it went through item lookup (even if no match)
    expect(result).not.toBeNull()
    mockIsEmote.mockImplementation(() => false)
  })
})

// ---------------------------------------------------------------------------
// !b — item with tier (any order)
// ---------------------------------------------------------------------------
describe('!b item + tier (any order)', () => {
  beforeEach(() => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
  })

  it('tier at end: !b boomerang gold', async () => {
    const result = await handleCommand('!b boomerang gold')
    expect(result).toContain('Boomerang')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('tier at start: !b gold boomerang', async () => {
    const result = await handleCommand('!b gold boomerang')
    expect(result).toContain('Boomerang')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('tier case-insensitive: !b boomerang DIAMOND', async () => {
    const result = await handleCommand('!b boomerang DIAMOND')
    expect(result).toContain('Boomerang')
  })

  it('all five tiers work at end', async () => {
    for (const tier of ['bronze', 'silver', 'gold', 'diamond', 'legendary']) {
      mockExact.mockClear()
      mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
      const result = await handleCommand(`!b boomerang ${tier}`)
      expect(result).toContain('Boomerang')
    }
  })

  it('all five tiers work at start', async () => {
    for (const tier of ['bronze', 'silver', 'gold', 'diamond', 'legendary']) {
      mockExact.mockClear()
      mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
      const result = await handleCommand(`!b ${tier} boomerang`)
      expect(result).toContain('Boomerang')
    }
  })

  it('multi-word item with tier at end', async () => {
    const tinfoil = makeCard({ Title: 'Tinfoil Hat' })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = await handleCommand('!b tinfoil hat gold')
    expect(result).toContain('Tinfoil Hat')
    expect(mockExact).toHaveBeenCalledWith('tinfoil hat')
  })

  it('multi-word item with tier at start', async () => {
    const tinfoil = makeCard({ Title: 'Tinfoil Hat' })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = await handleCommand('!b gold tinfoil hat')
    expect(result).toContain('Tinfoil Hat')
    expect(mockExact).toHaveBeenCalledWith('tinfoil hat')
  })

  it('multi-word item with tier in middle', async () => {
    const tinfoil = makeCard({ Title: 'Tinfoil Hat' })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? tinfoil : undefined)
    const result = await handleCommand('!b tinfoil gold hat')
    expect(result).toContain('Tinfoil Hat')
  })

  it('does not eat non-tier last word as tier', async () => {
    const hat = makeCard({ Title: 'Fancy Hat' })
    mockExact.mockImplementation((name) => name === 'fancy hat' ? hat : undefined)
    const result = await handleCommand('!b fancy hat')
    expect(result).toContain('Fancy Hat')
    expect(mockExact).toHaveBeenCalledWith('fancy hat')
  })
})

// ---------------------------------------------------------------------------
// !b — enchantment (any order)
// ---------------------------------------------------------------------------
describe('!b enchantment (any order)', () => {
  it('enchant first: !b fiery boomerang', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b fiery boomerang')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('enchant last: !b boomerang fiery', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b boomerang fiery')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('enchant prefix: !b fier boomerang', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b fier boomerang')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('enchant prefix at end: !b boomerang fier', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b boomerang fier')
    expect(result).toContain('[Boomerang - Fiery]')
  })

  it('icy enchantment any order', async () => {
    const card = makeCard({
      Enchantments: {
        Icy: {
          tags: [],
          tooltips: [{ text: 'Freeze', type: 'Passive' }],
        },
      },
    })
    mockExact.mockImplementation(() => card)
    expect(await handleCommand('!b icy boomerang')).toContain('[Boomerang - Icy]')
    expect(await handleCommand('!b boomerang icy')).toContain('[Boomerang - Icy]')
  })

  it('returns not found when enchantment item doesnt exist', async () => {
    const result = await handleCommand('!b fiery nonexistent')
    expect(result).toContain('no item found for "nonexistent"')
  })

  it('multi-word item after enchantment', async () => {
    const hat = makeCard({
      Title: 'Tinfoil Hat',
      Enchantments: {
        Fiery: {
          tags: [],
          tooltips: [{ text: 'Burn it', type: 'Active' }],
        },
      },
    })
    mockExact.mockImplementation((name) => name === 'tinfoil hat' ? hat : undefined)
    expect(await handleCommand('!b fiery tinfoil hat')).toContain('[Tinfoil Hat - Fiery]')
    expect(await handleCommand('!b tinfoil hat fiery')).toContain('[Tinfoil Hat - Fiery]')
    expect(await handleCommand('!b tinfoil fiery hat')).toContain('[Tinfoil Hat - Fiery]')
  })

  it('single word alone is item lookup not enchant', async () => {
    const result = await handleCommand('!b fiery')
    expect(result).toContain('¯\\_(ツ)_/¯')
  })

  it('single word alone is item lookup not enchant (toxic)', async () => {
    const result = await handleCommand('!b toxic')
    expect(result).toContain('¯\\_(ツ)_/¯')
  })
})

// ---------------------------------------------------------------------------
// !b — enchantment + tier (any order, all permutations)
// ---------------------------------------------------------------------------
describe('!b enchant + tier (any order)', () => {
  beforeEach(() => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
  })

  it('enchant item tier', async () => {
    expect(await handleCommand('!b fiery boomerang gold')).toContain('[Boomerang - Fiery]')
  })

  it('enchant tier item', async () => {
    expect(await handleCommand('!b fiery gold boomerang')).toContain('[Boomerang - Fiery]')
  })

  it('item enchant tier', async () => {
    expect(await handleCommand('!b boomerang fiery gold')).toContain('[Boomerang - Fiery]')
  })

  it('item tier enchant', async () => {
    expect(await handleCommand('!b boomerang gold fiery')).toContain('[Boomerang - Fiery]')
  })

  it('tier enchant item', async () => {
    expect(await handleCommand('!b gold fiery boomerang')).toContain('[Boomerang - Fiery]')
  })

  it('tier item enchant', async () => {
    expect(await handleCommand('!b gold boomerang fiery')).toContain('[Boomerang - Fiery]')
  })

  it('all 6 orderings produce same result', async () => {
    const orderings = [
      '!b fiery boomerang gold',
      '!b fiery gold boomerang',
      '!b boomerang fiery gold',
      '!b boomerang gold fiery',
      '!b gold fiery boomerang',
      '!b gold boomerang fiery',
    ]
    for (const cmd of orderings) {
      const r = await handleCommand(cmd)
      expect(r).toContain('[Boomerang - Fiery]')
    }
  })

  it('multi-word item + enchant + tier all orderings', async () => {
    const hat = makeCard({
      Title: 'Tinfoil Hat',
      Enchantments: {
        Fiery: {
          tags: [],
          tooltips: [{ text: 'Burn', type: 'Active' }],
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
      expect(await handleCommand(cmd)).toContain('[Tinfoil Hat - Fiery]')
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
          tags: ['Gold'],
          tooltips: [{ text: 'Extra gold', type: 'Passive' }],
        },
      },
    })
    mockExact.mockImplementation(() => card)
  })

  it('"gold boomerang" → gold tier item lookup', async () => {
    const result = await handleCommand('!b gold boomerang')
    expect(result).toContain('Boomerang [M]')
    expect(result).not.toContain('Golden')
  })

  it('"golden boomerang" → golden enchantment', async () => {
    const result = await handleCommand('!b golden boomerang')
    expect(result).toContain('[Boomerang - Golden]')
  })

  it('"boomerang gold" → gold tier item lookup', async () => {
    const result = await handleCommand('!b boomerang gold')
    expect(result).toContain('Boomerang [M]')
    expect(result).not.toContain('Golden')
  })

  it('"boomerang golden" → golden enchantment', async () => {
    const result = await handleCommand('!b boomerang golden')
    expect(result).toContain('[Boomerang - Golden]')
  })
})

// ---------------------------------------------------------------------------
// !b hero
// ---------------------------------------------------------------------------
describe('!b hero', () => {
  it('lists hero items', async () => {
    mockByHero.mockImplementation(() => [boomerang])
    const result = await handleCommand('!b hero pygmalien')
    expect(result).toContain('[pygmalien]')
    expect(result).toContain('Boomerang')
  })

  it('returns not found for unknown hero', async () => {
    const result = await handleCommand('!b hero nobody')
    expect(result).toContain('no items found for hero "nobody"')
  })

  it('hero keyword is case-insensitive', async () => {
    mockByHero.mockImplementation(() => [boomerang])
    expect(await handleCommand('!b HERO pygmalien')).toContain('Boomerang')
    expect(await handleCommand('!b Hero Pygmalien')).toContain('Boomerang')
  })

  it('truncates long hero output', async () => {
    const cards = Array.from({ length: 100 }, (_, i) =>
      makeCard({ Title: 'Item' + 'X'.repeat(20) + i }),
    )
    mockByHero.mockImplementation(() => cards)
    const result = (await handleCommand('!b hero pyg'))!
    expect(result.length).toBeLessThanOrEqual(480)
    expect(result).toEndWith('...')
  })
})

// ---------------------------------------------------------------------------
// !b mob / monster
// ---------------------------------------------------------------------------
describe('!b mob/monster', () => {
  const lich: Monster = {
    Type: 'CombatEncounter', Title: 'Lich',
    Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
    Heroes: [],
    MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [], skills: [] },
    Shortlink: 'https://bzdb.to/lich',
  }

  it('mob prefix finds monster', async () => {
    mockFindMonster.mockImplementation((q) => q === 'lich' ? lich : undefined)
    const result = await handleCommand('!b mob lich')
    expect(result).toContain('Lich')
    expect(result).toContain('Day 5')
  })

  it('monster prefix finds monster', async () => {
    mockFindMonster.mockImplementation((q) => q === 'lich' ? lich : undefined)
    const result = await handleCommand('!b monster lich')
    expect(result).toContain('Lich')
  })

  it('mob prefix is case-insensitive', async () => {
    mockFindMonster.mockImplementation(() => lich)
    expect(await handleCommand('!b MOB lich')).toContain('Lich')
    expect(await handleCommand('!b Mob lich')).toContain('Lich')
  })

  it('monster prefix is case-insensitive', async () => {
    mockFindMonster.mockImplementation(() => lich)
    expect(await handleCommand('!b MONSTER lich')).toContain('Lich')
  })

  it('returns not found for unknown monster', async () => {
    const result = await handleCommand('!b mob xyzmonster')
    expect(result).toContain('no monster found for xyzmonster')
  })

  it('multi-word monster name', async () => {
    const dragon: Monster = {
      Type: 'CombatEncounter', Title: 'Fire Dragon',
      Size: 'Large', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [],
      MonsterMetadata: { available: 'Rare', day: null, health: 500, board: [], skills: [] },
      Shortlink: 'https://bzdb.to/fire-dragon',
    }
    mockFindMonster.mockImplementation((q) => q === 'fire dragon' ? dragon : undefined)
    expect(await handleCommand('!b mob fire dragon')).toContain('Fire Dragon')
  })

  it('shows skill tooltips from skills array', async () => {
    const skillCard = makeCard({
      Title: 'Ink Blast',
      Type: 'Skill',
      Tooltips: [{ text: 'Deal {Dmg} damage to all', type: 'Active' }],
      TooltipReplacements: { '{Dmg}': { Bronze: 10, Gold: 30 } },
    })
    const boss: Monster = {
      Type: 'CombatEncounter', Title: 'Octoboss',
      Size: 'Large', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [],
      MonsterMetadata: {
        available: 'Always', day: 8, health: 500,
        board: [
          { title: 'Sword', tier: 'Gold', id: 'x' },
        ],
        skills: [
          { title: 'Ink Blast', tier: 'Gold', id: 'y' },
        ],
      },
      Shortlink: 'https://bzdb.to/octoboss',
    }
    mockFindMonster.mockImplementation(() => boss)
    mockFindCard.mockImplementation((name) => name === 'Ink Blast' ? skillCard : undefined)
    const result = (await handleCommand('!b mob octoboss'))!
    expect(result).toContain('Ink Blast: Deal 30 damage to all')
    expect(result).toContain('🟡Sword')
  })

  it('shows skills without card data as plain entries', async () => {
    const boss: Monster = {
      Type: 'CombatEncounter', Title: 'Mystery',
      Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [],
      MonsterMetadata: {
        available: 'Always', day: 1, health: 50,
        board: [],
        skills: [
          { title: 'Unknown Skill', tier: 'Bronze', id: 'z' },
        ],
      },
      Shortlink: 'https://bzdb.to/mystery',
    }
    mockFindMonster.mockImplementation(() => boss)
    const result = (await handleCommand('!b mob mystery'))!
    expect(result).toContain('Unknown Skill')
  })

  it('includes shortlink in monster response', async () => {
    mockFindMonster.mockImplementation(() => lich)
    const result = await handleCommand('!b mob lich')
    expect(result).toContain('bzdb.to/lich')
  })
})

// ---------------------------------------------------------------------------
// !b — edge cases
// ---------------------------------------------------------------------------
describe('!b edge cases', () => {
  it('handles single character input', async () => {
    const result = await handleCommand('!b x')
    expect(result).toContain('¯\\_(ツ)_/¯')
  })

  it('handles extra whitespace between words', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b   boomerang')
    expect(result).toContain('Boomerang [M]')
  })

  it('output never exceeds 480 chars', async () => {
    const longCard = makeCard({
      Title: 'A'.repeat(200),
      Tooltips: [
        { text: 'B'.repeat(200), type: 'Active' },
        { text: 'C'.repeat(200), type: 'Passive' },
      ],
    })
    mockExact.mockImplementation(() => longCard)
    const result = (await handleCommand('!b test'))!
    expect(result.length).toBeLessThanOrEqual(480)
  })

  it('does not match unregistered commands', async () => {
    expect(await handleCommand('!hero pygmalien')).toBeNull()
    expect(await handleCommand('!help')).toBeNull()
    expect(await handleCommand('!enc fiery boomerang')).toBeNull()
    expect(await handleCommand('!item boomerang')).toBeNull()
  })

  it('handles empty string after command', async () => {
    const result = await handleCommand('!b ')
    expect(result).toContain('!b')
  })

  it('strips quotes from input', async () => {
    const eclipse = makeCard({ Title: 'The Eclipse' })
    mockExact.mockImplementation((name) => name === 'the eclipse' ? eclipse : undefined)
    const result = await handleCommand('!b "the eclipse"')
    expect(result).toContain('The Eclipse')
    expect(mockExact).toHaveBeenCalledWith('the eclipse')
  })

  it('help and info show usage', async () => {
    expect(await handleCommand('!b help')).toContain('!b')
    expect(await handleCommand('!b info')).toContain('!b')
  })

  it('tier-only input shows usage', async () => {
    const result = await handleCommand('!b gold')
    expect(result).toContain('!b')
  })
})

// ---------------------------------------------------------------------------
// Integration: verify format output structure
// ---------------------------------------------------------------------------
describe('!b output format integration', () => {
  it('item output shows tooltip text', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = (await handleCommand('!b boomerang'))!
    expect(result).toContain('Deal 60 Damage')
  })

  it('enchantment output includes tags and tooltip', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = (await handleCommand('!b fiery boomerang'))!
    expect(result).toContain('[Boomerang - Fiery]')
    expect(result).toContain('[Burn]')
    expect(result).toContain('Burn for')
  })
})

// ---------------------------------------------------------------------------
// Analytics logging
// ---------------------------------------------------------------------------
describe('analytics logging', () => {
  it('logs hit on exact item match', async () => {
    mockExact.mockImplementation(() => boomerang)
    await handleCommand('!b boomerang', { user: 'tidolar', channel: 'mellen' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'tidolar', channel: 'mellen' },
      'item',
      'boomerang',
      'Boomerang',
      undefined,
    )
  })

  it('logs hit on fuzzy item match', async () => {
    mockSearch.mockImplementation(() => [boomerang])
    await handleCommand('!b boom', { user: 'chatter' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'chatter' },
      'item',
      'boom',
      'Boomerang',
      undefined,
    )
  })

  it('logs hit with tier on tiered item lookup', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    await handleCommand('!b diamond boomerang', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'item',
      'boomerang',
      'Boomerang',
      'Diamond',
    )
  })

  it('logs hit on enchantment lookup', async () => {
    mockExact.mockImplementation(() => boomerang)
    await handleCommand('!b fiery boomerang', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'enchant',
      'boomerang',
      'Boomerang+Fiery',
      undefined,
    )
  })

  it('logs hit on monster lookup via mob prefix', async () => {
    const lich: Monster = {
      Type: 'CombatEncounter', Title: 'Lich',
      Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [],
      MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [], skills: [] },
      Shortlink: 'https://bzdb.to/lich',
    }
    mockFindMonster.mockImplementation(() => lich)
    await handleCommand('!b mob lich', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'mob',
      'lich',
      'Lich',
      undefined,
    )
  })

  it('logs hit on hero lookup', async () => {
    mockByHero.mockImplementation(() => [boomerang])
    await handleCommand('!b hero vanessa', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'hero',
      'vanessa',
      '1 items',
      undefined,
    )
  })

  it('logs miss with user context', async () => {
    await handleCommand('!b xyznothing', { user: 'chatter', channel: 'stream' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'chatter', channel: 'stream' },
      'miss',
      'xyznothing',
    )
  })

  it('logs mob miss with user context', async () => {
    await handleCommand('!b mob xyzmonster', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'miss',
      'xyzmonster',
    )
  })

  it('does not log on help/usage', async () => {
    await handleCommand('!b help', { user: 'test' })
    expect(mockLogCommand).not.toHaveBeenCalled()
  })

  it('works without context (backwards compat)', async () => {
    mockExact.mockImplementation(() => boomerang)
    await handleCommand('!b boomerang')
    expect(mockLogCommand).toHaveBeenCalled()
  })

  it('logs implicit monster match (no mob prefix)', async () => {
    const lich: Monster = {
      Type: 'CombatEncounter', Title: 'Lich',
      Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
      Heroes: [],
      MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [], skills: [] },
      Shortlink: 'https://bzdb.to/lich',
    }
    mockFindMonster.mockImplementation(() => lich)
    await handleCommand('!b lich', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'mob',
      'lich',
      'Lich',
      undefined,
    )
  })
})

describe('@mention passthrough', () => {
  beforeEach(() => {
    mockExact.mockReset()
    mockSearch.mockReset()
    mockFindMonster.mockReset()
    mockLogCommand.mockReset()
  })

  it('strips @mention from search query but does not tag in response', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = await handleCommand('!b boomerang @hamstornado')
    expect(result).not.toContain('@hamstornado')
    expect(result).toContain('Boomerang')
  })

  it('strips @mention from search query', async () => {
    mockExact.mockImplementation(() => boomerang)
    await handleCommand('!b boomerang @someone')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('handles multiple mentions without tagging', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = await handleCommand('!b boomerang @user1 @user2')
    expect(result).not.toContain('@user1')
    expect(result).not.toContain('@user2')
  })

  it('mention anywhere in args', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = await handleCommand('!b @someone boomerang')
    expect(result).not.toContain('@someone')
    expect(result).toContain('Boomerang')
  })

  it('no mention = no suffix', async () => {
    mockExact.mockImplementation(() => boomerang)
    const result = await handleCommand('!b boomerang')
    expect(result).not.toContain('@')
  })
})

// ---------------------------------------------------------------------------
// !b enchants
// ---------------------------------------------------------------------------
describe('!b enchants', () => {
  it('lists all enchantments', async () => {
    mockGetEnchantments.mockImplementation(() => ['deadly', 'fiery', 'golden'])
    const result = await handleCommand('!b enchants')
    expect(result).toContain('Enchantments: Deadly, Fiery, Golden')
  })

  it('matches "enchantments" keyword', async () => {
    mockGetEnchantments.mockImplementation(() => ['deadly'])
    const result = await handleCommand('!b enchantments')
    expect(result).toContain('Enchantments: Deadly')
  })

  it('matches "enchant" keyword', async () => {
    mockGetEnchantments.mockImplementation(() => ['deadly'])
    const result = await handleCommand('!b enchant')
    expect(result).toContain('Enchantments: Deadly')
  })

  it('is case-insensitive', async () => {
    mockGetEnchantments.mockImplementation(() => ['deadly'])
    expect(await handleCommand('!b ENCHANTS')).toContain('Enchantments:')
    expect(await handleCommand('!b Enchants')).toContain('Enchantments:')
  })

  it('logs hit', async () => {
    mockGetEnchantments.mockImplementation(() => ['deadly', 'fiery'])
    await handleCommand('!b enchants', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalled()
  })

  it('does not append @mention (reply threading only)', async () => {
    mockGetEnchantments.mockImplementation(() => ['deadly'])
    const result = await handleCommand('!b enchants @someone')
    expect(result).toContain('Enchantments: Deadly')
    expect(result).not.toContain('@someone')
  })
})

// ---------------------------------------------------------------------------
// !b tag
// ---------------------------------------------------------------------------
describe('!b tag', () => {
  it('finds items by tag', async () => {
    mockByTag.mockImplementation(() => [boomerang, shield])
    const result = await handleCommand('!b tag Burn')
    expect(result).toContain('[Burn]')
    expect(result).toContain('Boomerang')
    expect(result).toContain('Shield')
  })

  it('returns not found for unknown tag', async () => {
    const result = await handleCommand('!b tag Nonexistent')
    expect(result).toContain('no items found with tag Nonexistent')
  })

  it('is case-insensitive keyword', async () => {
    mockByTag.mockImplementation(() => [boomerang])
    expect(await handleCommand('!b TAG burn')).toContain('Boomerang')
    expect(await handleCommand('!b Tag Burn')).toContain('Boomerang')
  })

  it('logs hit on tag match', async () => {
    mockByTag.mockImplementation(() => [boomerang])
    await handleCommand('!b tag Shield', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalled()
  })

  it('logs miss on tag miss', async () => {
    await handleCommand('!b tag Nothing', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'miss',
      'Nothing',
    )
  })

  it('does not append @mention to tag results', async () => {
    mockByTag.mockImplementation(() => [boomerang])
    const result = await handleCommand('!b tag Burn @friend')
    expect(result).not.toContain('@friend')
    expect(result).toContain('Boomerang')
  })

  it('no keyword returns usage (falls through)', async () => {
    const result = await handleCommand('!b tag')
    expect(result).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// !b day
// ---------------------------------------------------------------------------
describe('!b day', () => {
  const lich: Monster = {
    Type: 'CombatEncounter', Title: 'Lich',
    Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [],
    Heroes: [],
    MonsterMetadata: { available: 'Always', day: 5, health: 100, board: [], skills: [] },
    Shortlink: 'https://bzdb.to/lich',
  }
  const dragon: Monster = {
    Type: 'CombatEncounter', Title: 'Dragon',
    Size: 'Large', Tags: [], DisplayTags: [], HiddenTags: [],
    Heroes: [],
    MonsterMetadata: { available: 'Always', day: 5, health: 500, board: [], skills: [] },
    Shortlink: 'https://bzdb.to/dragon',
  }

  it('lists monsters for a day', async () => {
    mockMonstersByDay.mockImplementation(() => [lich, dragon])
    const result = await handleCommand('!b day 5')
    expect(result).toContain('[Day 5]')
    expect(result).toContain('Lich (100HP)')
    expect(result).toContain('Dragon (500HP)')
  })

  it('returns not found for empty day', async () => {
    const result = await handleCommand('!b day 9')
    expect(result).toContain('no monsters found for day 9')
  })

  it('rejects day 0', async () => {
    const result = await handleCommand('!b day 0')
    expect(result).toContain('invalid day number')
  })

  it('returns empty for day with no monsters', async () => {
    const result = await handleCommand('!b day 11')
    expect(result).toContain('no monsters found for day 11')
  })

  it('is case-insensitive keyword', async () => {
    mockMonstersByDay.mockImplementation(() => [lich])
    expect(await handleCommand('!b DAY 5')).toContain('Lich')
    expect(await handleCommand('!b Day 5')).toContain('Lich')
  })

  it('logs hit on day match', async () => {
    mockMonstersByDay.mockImplementation(() => [lich])
    await handleCommand('!b day 5', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalled()
  })

  it('logs miss on empty day', async () => {
    await handleCommand('!b day 8', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'miss',
      '8',
    )
  })

  it('does not append @mention', async () => {
    mockMonstersByDay.mockImplementation(() => [lich])
    const result = await handleCommand('!b day 5 @viewer')
    expect(result).not.toContain('@viewer')
  })
})

// ---------------------------------------------------------------------------
// !b skill
// ---------------------------------------------------------------------------
describe('!b skill', () => {
  it('finds skill by name', async () => {
    const skill = makeCard({ Title: 'Ink Blast', Type: 'Skill' })
    mockFindSkill.mockImplementation(() => skill)
    const result = await handleCommand('!b skill ink blast')
    expect(result).toContain('Ink Blast')
  })

  it('returns not found for unknown skill', async () => {
    const result = await handleCommand('!b skill xyzskill')
    expect(result).toContain('no skill found for "xyzskill"')
  })

  it('is case-insensitive keyword', async () => {
    const skill = makeCard({ Title: 'Zap', Type: 'Skill' })
    mockFindSkill.mockImplementation(() => skill)
    expect(await handleCommand('!b SKILL zap')).toContain('Zap')
    expect(await handleCommand('!b Skill zap')).toContain('Zap')
  })

  it('logs hit on skill match', async () => {
    const skill = makeCard({ Title: 'Zap', Type: 'Skill' })
    mockFindSkill.mockImplementation(() => skill)
    await handleCommand('!b skill zap', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalled()
  })

  it('logs miss on skill miss', async () => {
    await handleCommand('!b skill nothing', { user: 'test' })
    expect(mockLogCommand).toHaveBeenCalledWith(
      { user: 'test' },
      'miss',
      'nothing',
    )
  })

  it('does not append @mention', async () => {
    const skill = makeCard({ Title: 'Zap', Type: 'Skill' })
    mockFindSkill.mockImplementation(() => skill)
    const result = await handleCommand('!b skill zap @someone')
    expect(result).not.toContain('@someone')
    expect(result).toContain('Zap')
  })
})

// ---------------------------------------------------------------------------
// Updated usage string
// ---------------------------------------------------------------------------
describe('usage string', () => {
  it('includes new route keywords', async () => {
    const result = (await handleCommand('!b help'))!
    expect(result).toContain('hero')
    expect(result).toContain('mob')
    expect(result).toContain('skill')
    expect(result).toContain('tag')
    expect(result).toContain('day')
    expect(result).toContain('enchants')
    expect(result).toContain('trivia')
    expect(result).toContain('score')
    expect(result).toContain('stats')
  })
})

// ---------------------------------------------------------------------------
// AI fallback path
// ---------------------------------------------------------------------------
describe('AI fallback path', () => {
  it('conversational query + AI success = AI response (no @tag)', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'vanessa is solid', mentions: [] }))
    const result = await handleCommand('!b is vanessa good', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('vanessa is solid')
    expect(result).not.toContain('@chatter')
  })

  it('conversational query + AI failure = shrug fallback', async () => {
    mockAiRespond.mockImplementation(() => null)
    const result = await handleCommand('!b is vanessa good', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('¯\\_(ツ)_/¯')
  })

  it('short query + no match + AI fail = shrug fallback', async () => {
    const result = await handleCommand('!b asdfghjkl', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('¯\\_(ツ)_/¯')
  })

  it('short query + AI success = AI response (not boring error)', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'buh right back at you', mentions: [] }))
    const result = await handleCommand('!b buh', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('buh right back at you')
  })

  it('short query + suggestions shown only when AI fails', async () => {
    mockSuggest.mockImplementation(() => ['Boomerang', 'Boom Box'])
    mockAiRespond.mockImplementation(() => null)
    const result = await handleCommand('!b boom', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('did you mean')
    expect(result).toContain('Boomerang')
  })

  it('AI response has no @mentions appended', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'yeah for sure', mentions: ['@viewer'] }))
    const result = await handleCommand('!b is vanessa good @viewer', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('yeah for sure')
    expect(result).not.toContain('@viewer')
  })
})

// ---------------------------------------------------------------------------
// Command proxy — direct ! commands
// ---------------------------------------------------------------------------
describe('command proxy: direct !cmd', () => {
  it('proxies custom commands as-is', async () => {
    expect(await handleCommand('!b !jory')).toBe('!jory')
    expect(await handleCommand('!b !lurk')).toBe('!lurk')
    expect(await handleCommand('!b !hug')).toBe('!hug')
  })

  it('proxies with numeric args', async () => {
    expect(await handleCommand('!b !jory 932')).toBe('!jory 932')
  })

  it('proxies with text args', async () => {
    expect(await handleCommand('!b !quote add this is funny')).toBe('!quote add this is funny')
  })

  it('blocks every streamlabs system command', async () => {
    for (const cmd of ['so', 'shoutout', 'commands', 'addcom', 'editcom', 'delcom',
      'deletecom', 'disablecom', 'enablecom', 'permit', 'sr', 'songrequest',
      'songs', 'skip', 'wrongsong', 'volume', 'queue', 'playlist']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('blocks every streamelements system command', async () => {
    for (const cmd of ['points', 'loyalty', 'givepoints', 'removepoints', 'top',
      'leaderboard', 'roulette', 'gamble', 'slots', 'duel']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('blocks every moderation command', async () => {
    for (const cmd of ['ban', 'unban', 'timeout', 'untimeout', 'permit',
      'nuke', 'unnuke', 'mod', 'unmod', 'vip', 'unvip', 'block', 'unblock']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('blocks every stream control command', async () => {
    for (const cmd of ['title', 'game', 'commercial', 'raid', 'unraid',
      'host', 'unhost', 'marker', 'so', 'shoutout']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('blocks every chat mode command', async () => {
    for (const cmd of ['slow', 'slowoff', 'followers', 'followersoff',
      'subscribers', 'subscribersoff', 'emoteonly', 'emoteonlyoff',
      'uniquechat', 'uniquechatoff', 'clear']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('blocks every giveaway/poll command', async () => {
    for (const cmd of ['giveaway', 'raffle', 'enter', 'poll', 'vote', 'winner']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('blocks every nightbot command', async () => {
    for (const cmd of ['regulars', 'filters', 'timers']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('blocked commands are case insensitive', async () => {
    expect(await handleCommand('!b !SO')).toBeNull()
    expect(await handleCommand('!b !Ban')).toBeNull()
    expect(await handleCommand('!b !ROULETTE')).toBeNull()
    expect(await handleCommand('!b !TimeOut')).toBeNull()
    expect(await handleCommand('!b !NUKE')).toBeNull()
  })

  it('blocked commands with args still blocked', async () => {
    expect(await handleCommand('!b !ban someone')).toBeNull()
    expect(await handleCommand('!b !timeout user 300')).toBeNull()
    expect(await handleCommand('!b !so streamer123')).toBeNull()
    expect(await handleCommand('!b !raid coolchannel')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Command proxy — embedded !cmd in conversational text
// ---------------------------------------------------------------------------
describe('command proxy: embedded in chat', () => {
  it('"so can u run !jory pls brotherman" → !jory', async () => {
    expect(await handleCommand('!b so can u run !jory pls brotherman')).toBe('!jory')
  })

  it('"run !jory 932 please" → !jory 932', async () => {
    expect(await handleCommand('!b run !jory 932 please')).toBe('!jory 932')
  })

  it('"yo do !lurk for me" → !lurk', async () => {
    expect(await handleCommand('!b yo do !lurk for me')).toBe('!lurk')
  })

  it('"can you type !hug" → !hug', async () => {
    expect(await handleCommand('!b can you type !hug')).toBe('!hug')
  })

  it('"pls !jory" → !jory', async () => {
    expect(await handleCommand('!b pls !jory')).toBe('!jory')
  })

  it('"hey !jory 100 thanks bro" → !jory 100', async () => {
    expect(await handleCommand('!b hey !jory 100 thanks bro')).toBe('!jory 100')
  })

  it('embedded blocked command is silently dropped', async () => {
    // "can you !ban this guy" — blocked cmd, falls through to item lookup / AI
    const result = await handleCommand('!b can you !ban this guy', { user: 'u', channel: 'c' })
    // should NOT return "!ban" — should fall through
    expect(result).not.toContain('!ban')
  })

  it('embedded blocked command falls through to AI', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'nah i cant ban people', mentions: [] }))
    const result = await handleCommand('!b can you !ban this guy', { user: 'u', channel: 'c' })
    expect(result).toContain('nah i cant ban people')
  })

  it('preserves original case of command name', async () => {
    expect(await handleCommand('!b run !Jory pls')).toBe('!Jory')
  })
})

// ---------------------------------------------------------------------------
// Command proxy — cooldowns
// ---------------------------------------------------------------------------
describe('command proxy: cooldowns', () => {
  const ctx = { user: 'tidolar', channel: 'mellen' }

  it('first use succeeds', async () => {
    expect(await handleCommand('!b !jory', ctx)).toBe('!jory')
  })

  it('second use within window shows cooldown', async () => {
    await handleCommand('!b !jory', ctx)
    const result = await handleCommand('!b !jory', ctx)
    expect(result).toContain('!jory is on cooldown')
    expect(result).toMatch(/\d+s/)
  })

  it('cooldown message shows remaining seconds', async () => {
    await handleCommand('!b !jory', ctx)
    const result = (await handleCommand('!b !jory', ctx))!
    // should be close to 30s
    const match = result.match(/(\d+)s/)
    expect(match).toBeTruthy()
    const secs = parseInt(match![1])
    expect(secs).toBeGreaterThan(0)
    expect(secs).toBeLessThanOrEqual(30)
  })

  it('different commands have independent cooldowns', async () => {
    await handleCommand('!b !jory', ctx)
    // !lurk should work even though !jory just fired
    expect(await handleCommand('!b !lurk', ctx)).toBe('!lurk')
  })

  it('different channels have independent cooldowns', async () => {
    await handleCommand('!b !jory', { user: 'a', channel: 'ch1' })
    // same command, different channel — should work
    expect(await handleCommand('!b !jory', { user: 'b', channel: 'ch2' })).toBe('!jory')
  })

  it('cooldown applies to embedded commands too', async () => {
    await handleCommand('!b !jory', ctx)
    const result = await handleCommand('!b yo run !jory pls', ctx)
    expect(result).toContain('!jory is on cooldown')
  })

  it('embedded command triggers cooldown for direct use', async () => {
    await handleCommand('!b hey do !jory pls', ctx)
    const result = await handleCommand('!b !jory', ctx)
    expect(result).toContain('!jory is on cooldown')
  })

  it('no cooldown without channel context', async () => {
    await handleCommand('!b !jory')
    // no channel = no cooldown tracking
    expect(await handleCommand('!b !jory')).toBe('!jory')
  })

  it('slash commands have no cooldown', async () => {
    expect(await handleCommand('!b /me dances', { user: 'a', channel: 'ch1' })).toBe('/me dances')
    expect(await handleCommand('!b /me dances', { user: 'a', channel: 'ch2' })).toBe('/me dances')
  })

  it('cooldown is case insensitive', async () => {
    await handleCommand('!b !Jory', { user: 'a', channel: 'cd1' })
    resetDedup()
    const result = await handleCommand('!b !jory', { user: 'b', channel: 'cd1' })
    expect(result).toContain('on cooldown')
  })
})

// ---------------------------------------------------------------------------
// Command proxy — slash commands (allowlist)
// ---------------------------------------------------------------------------
describe('command proxy: slash commands', () => {
  it('allows /me', async () => {
    expect(await handleCommand('!b /me dances')).toBe('/me dances')
  })

  it('allows /announce', async () => {
    expect(await handleCommand('!b /announce hello everyone')).toBe('/announce hello everyone')
  })

  it('allows /color', async () => {
    expect(await handleCommand('!b /color blue')).toBe('/color blue')
  })

  it('blocks every dangerous / command', async () => {
    for (const cmd of ['ban', 'unban', 'timeout', 'untimeout', 'mod', 'unmod',
      'vip', 'unvip', 'clear', 'slow', 'slowoff', 'followers', 'followersoff',
      'subscribers', 'subscribersoff', 'emoteonly', 'emoteonlyoff',
      'uniquechat', 'uniquechatoff', 'raid', 'unraid', 'host', 'unhost',
      'delete', 'commercial', 'marker', 'w', 'whisper', 'block', 'unblock',
      'disconnect']) {
      expect(await handleCommand(`!b /${cmd} arg`)).toBeNull()
    }
  })

  it('blocks unknown / commands (allowlist enforced)', async () => {
    expect(await handleCommand('!b /whatever')).toBeNull()
    expect(await handleCommand('!b /hack')).toBeNull()
    expect(await handleCommand('!b /exec')).toBeNull()
    expect(await handleCommand('!b /sudo')).toBeNull()
  })

  it('slash allowlist is case insensitive', async () => {
    expect(await handleCommand('!b /ME dances')).toBe('/ME dances')
    expect(await handleCommand('!b /ANNOUNCE hi')).toBe('/ANNOUNCE hi')
  })
})

// ---------------------------------------------------------------------------
// Mod bypass for blocked commands
// ---------------------------------------------------------------------------
describe('command proxy: mod bypass', () => {
  it('mod can proxy blocked commands', async () => {
    expect(await handleCommand('!b !so streamer', { user: 'mod', channel: 'ch', privileged: true, isMod: true })).toBe('!so streamer')
    expect(await handleCommand('!b !addcom', { user: 'mod', channel: 'ch2', privileged: true, isMod: true })).toBe('!addcom')
  })

  it('non-mod cannot proxy blocked commands', async () => {
    expect(await handleCommand('!b !so streamer', { user: 'viewer', channel: 'ch' })).toBeNull()
    expect(await handleCommand('!b !ban user', { user: 'viewer', channel: 'ch' })).toBeNull()
  })

  it('subscriber cannot proxy blocked commands', async () => {
    expect(await handleCommand('!b !so streamer', { user: 'sub', channel: 'chsub', privileged: true })).toBeNull()
    expect(await handleCommand('!b !addcom !test hi', { user: 'sub', channel: 'chsub2', privileged: true })).toBeNull()
  })

  it('mod can use moderation commands', async () => {
    for (const cmd of ['ban', 'timeout', 'mod', 'vip', 'clear', 'nuke']) {
      expect(await handleCommand(`!b !${cmd} target`, { user: 'mod', channel: `ch${cmd}`, privileged: true, isMod: true })).toBe(`!${cmd} target`)
    }
  })

  it('mod can use stream control commands', async () => {
    for (const cmd of ['so', 'shoutout', 'raid', 'title', 'game']) {
      expect(await handleCommand(`!b !${cmd} val`, { user: 'mod', channel: `ch${cmd}`, privileged: true, isMod: true })).toBe(`!${cmd} val`)
    }
  })

  it('mod still gets cooldown on blocked commands', async () => {
    const ctx = { user: 'mod', channel: 'cdmod', privileged: true, isMod: true }
    expect(await handleCommand('!b !so streamer', ctx)).toBe('!so streamer')
    resetDedup()
    const result = await handleCommand('!b !so streamer', ctx)
    expect(result).toContain('on cooldown')
  })

  it('custom commands still work for non-privileged', async () => {
    expect(await handleCommand('!b !jory', { user: 'viewer', channel: 'ch' })).toBe('!jory')
  })
})

// ---------------------------------------------------------------------------
// AI command management (mod asks AI to add/edit/delete streamlabs commands)
// ---------------------------------------------------------------------------
describe('AI command management', () => {
  it('mod AI response with !addcom gets sent to chat', async () => {
    mockAiRespond.mockImplementation(() => ({ text: '!addcom !harem 42 cuties in the harem Kreygasm', mentions: [] }))
    const result = await handleCommand('!b hey add a command called harem', { user: 'mod', channel: 'stream', privileged: true, isMod: true })
    expect(result).toBe('!addcom !harem 42 cuties in the harem Kreygasm')
  })

  it('mod AI response with !editcom gets sent to chat', async () => {
    mockAiRespond.mockImplementation(() => ({ text: '!editcom !harem 99 cuties in the harem', mentions: [] }))
    const result = await handleCommand('!b edit the harem command to say 99', { user: 'mod', channel: 'stream', privileged: true, isMod: true })
    expect(result).toBe('!editcom !harem 99 cuties in the harem')
  })

  it('mod AI response with !delcom gets sent to chat', async () => {
    mockAiRespond.mockImplementation(() => ({ text: '!delcom !harem', mentions: [] }))
    const result = await handleCommand('!b delete the harem command', { user: 'mod', channel: 'stream', privileged: true, isMod: true })
    expect(result).toBe('!delcom !harem')
  })

  it('non-mod cannot get AI to output commands', async () => {
    // real sanitize strips command prefix for non-privileged, so aiRespond returns empty
    // here we simulate what happens: AI tried to output !addcom but sanitizer killed it
    mockAiRespond.mockImplementation(() => null)
    const result = await handleCommand('!b add a command called harem', { user: 'viewer', channel: 'stream' })
    // no AI result → falls through to shrug
    expect(result).toContain('¯\\_(ツ)_/¯')
  })
})

// ---------------------------------------------------------------------------
// Copypasta via AI
// ---------------------------------------------------------------------------
describe('copypasta via AI', () => {
  it('returns copypasta from AI', async () => {
    const pasta = 'listen here chat, i have been PERSONALLY victimized by boomerang players who think they are hot stuff just because they deal 60 damage'
    mockAiRespond.mockImplementation(() => ({ text: pasta, mentions: [] }))
    const result = await handleCommand('!b give me a copypasta about boomerang', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('boomerang')
  })

  it('copypasta works for non-mods', async () => {
    const pasta = 'we are ALL vanessa mains on this blessed day'
    mockAiRespond.mockImplementation(() => ({ text: pasta, mentions: [] }))
    const result = await handleCommand('!b write a copypasta about vanessa', { user: 'viewer', channel: 'stream' })
    expect(result).toBe(pasta)
  })

  it('copypasta can use full message length', async () => {
    const longPasta = 'a'.repeat(400)
    mockAiRespond.mockImplementation(() => ({ text: longPasta, mentions: [] }))
    const result = await handleCommand('!b copypasta about gaming', { user: 'chatter', channel: 'stream' })
    expect(result).toBeTruthy()
  })
})

