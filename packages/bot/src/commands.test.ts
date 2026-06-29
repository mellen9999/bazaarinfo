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
const mockFindExactHero = mock<(query: string) => string | undefined>(() => undefined)
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
  findExactHero: mockFindExactHero,
  findTagName: mockFindTagName,
  suggest: mockSuggest,
  monsterSuggest: mock(() => []),
  getHeroNames: mockGetHeroNames,
  getTagNames: mockGetTagNames,
}))

// --- mock db ---
const mockLogCommand = mock<(...args: any[]) => void>(() => {})
const mockGetOrCreateUser = mock<(username: string) => number>(() => 1)
const mockGetRecentAsks = mock<(user: string, limit?: number) => { query: string; response: string | null; created_at: string }[]>(() => [])
// person-trivia dossier sources — default to empty so a target with no logged data
// produces a clean "don't know enough" miss; individual tests seed them.
const mockGetUserFacts = mock<(user: string, limit?: number) => string[]>(() => [])
const mockGetUserMessages = mock<(user: string, channel: string, limit?: number) => string[]>(() => [])
const mockGetUserTopItems = mock<(user: string, limit?: number) => string[]>(() => [])
const mockGetLastTriviaResult = mock<(channel: string) => { question: string; answer: string; winner: string | null } | null>(() => null)

mock.module('./db', () => ({
  logCommand: mockLogCommand,
  getOrCreateUser: mockGetOrCreateUser,
  getRecentAsks: mockGetRecentAsks,
  logChat: mock(() => {}),
  getUserStats: mock(() => null),
  getLastTriviaResult: mockGetLastTriviaResult,
  getUserFacts: mockGetUserFacts,
  getUserMessages: mockGetUserMessages,
  getUserTopItems: mockGetUserTopItems,
  getChannelLeaderboard: mock(() => []),
  getTriviaLeaderboard: mock(() => []),
  createTriviaGame: mock(() => 1),
  recordTriviaAnswer: mock(() => {}),
  recordTriviaWin: mock(() => {}),
  recordTriviaAttempt: mock(() => {}),
  resetTriviaStreak: mock(() => {}),
  getDb: mock(() => null),
}))

// --- mock dnd ---
mock.module('./dungeon', () => ({
  statusLine: mock(() => 'the Depths lie silent — type `descend` to begin.'),
  resetRun: mock(() => 'the Depths have been reset.'),
  castInput: mock(() => {}),
  initDungeon: mock(() => {}),
  initDungeonDb: mock(() => {}),
  setIsLive: mock(() => {}),
  restoreFromDb: mock(() => {}),
  onStreamOnline: mock(() => {}),
  onStreamOffline: mock(() => {}),
  cleanup: mock(() => {}),
}))


// --- mock ai ---
const mockAiRespond = mock<(...args: any[]) => any>(() => null)
const mockGetAiCooldown = mock<(user: string, channel?: string) => number>(() => 0)
mock.module('./ai', () => ({
  aiRespond: mockAiRespond,
  getAiCooldown: mockGetAiCooldown,
  getGlobalAiCooldown: mock(() => 0),
  initSummarizer: mock(() => {}),
  invalidatePromptCache: mock(() => {}),
  sanitize: mock((t: string) => ({ text: t, mentions: [] })),
  dedupeEmote: mock((t: string) => t),
  fixEmoteCase: mock((t: string) => t),
  fixEmotePunctuation: mock((t: string) => t),
  dedupeMention: mock((t: string) => t),
  capEmoteTotal: mock((t: string) => t),
  capRepeatedSpam: mock((t: string) => t),
  // exported constant — must be the real regex so the dedup exemption works in tests
  CONTINUE_RE: /^(continue|keep going|go on|carry on|more\b|next\b|finish( it)?|expand|extend|again\b|and then|then what)/i,
}))

// --- mock trivia ---
const mockIsGameActive = mock<(ch: string) => boolean>(() => false)
const mockStartKrippTrivia = mock<(ch: string) => string | null>(() => null)
const mockStartFallbackTrivia = mock<(ch: string) => string | null>(() => 'Trivia! fallback question (30s)')
mock.module('./trivia', () => ({
  startTrivia: mock(() => 'Trivia! test question (30s to answer)'),
  getTriviaScore: mock(() => 'no trivia scores yet'),
  formatStats: mock((u: string) => `[${u}] cmds:0`),
  formatTop: mock(() => 'no activity yet'),
  checkAnswer: mock(() => {}),
  isGameActive: mockIsGameActive,
  setSay: mock(() => {}),
  matchAnswer: mock(() => false),
  invalidateAliasCache: mock(() => {}),
  looksLikeAnswer: mock(() => true),
  resetForTest: mock(() => {}),
  getActiveGameForTest: mock(() => undefined),
  skipTrivia: mock(() => null),
  startCustomTrivia: mock(() => 'Trivia! custom question (30s)'),
  recentQuestionList: mock(() => [] as string[]),
  isRecentQuestion: mock(() => false),
  recentAnswerList: mock(() => [] as string[]),
  isRecentAnswer: mock(() => false),
  startKrippTrivia: mockStartKrippTrivia,
  startFallbackTrivia: mockStartFallbackTrivia,
}))

// custom-topic trivia generator — mocked so tests never hit the API. default returns
// a valid question; individual tests can override via the exported mock.
const mockGenerateCustomTrivia = mock(async (_topic: string) => ({
  question: 'custom q?',
  answer: 'ans',
  accept: ['ans', 'answer'],
}))
const mockGenerateChatTrivia = mock(async (_lines: string[]) => ({
  question: 'who said hi?',
  answer: 'bob',
  accept: ['bob', '@bob'],
}))
const mockGeneratePersonTrivia = mock(async (_dossier: string, _handle: string) => ({
  question: 'whats their go-to item?',
  answer: 'sword',
  accept: ['sword', 'the sword'],
}))
mock.module('./ai-trivia', () => ({
  generateCustomTrivia: mockGenerateCustomTrivia,
  generateChatTrivia: mockGenerateChatTrivia,
  generatePersonTrivia: mockGeneratePersonTrivia,
}))

// directive-plant AI gate — mocked so tests never hit the API. default returns a valid
// parsed directive; tests override (e.g. null to simulate an AI rejection).
const mockParseDirective = mock(async (_text: string, _channel: string): Promise<any> => ({
  trigger: ['topology'],
  targetUser: undefined,
  mute: false,
  instruction: 'work in GachiBlacksmith',
}))
mock.module('./ai-directive', () => ({
  parseDirective: mockParseDirective,
}))

// --- mock emotes ---
const TEST_EMOTES = new Set(['KEKW', 'Sadge', 'LULW', 'LICK', 'PogChamp', 'LUL', 'OMEGALUL', 'Kappa', '67'])
mock.module('./emotes', () => ({
  isEmote: mock((name: string) => TEST_EMOTES.has(name)),
  findEmote: mock((name: string) => TEST_EMOTES.has(name) ? name : undefined),
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

const { handleCommand, parseArgs, resetDedup, resetProxyCooldowns, PROXY_COOLDOWN, buildBareBQuery, findUnansweredQuestion, BARE_B_NUDGES, stripTopicConnector, DIRECTIVE_INTENT } = await import('./commands')
const chatbuf = await import('./chatbuf')
const directives = await import('./directives')

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
  mockFindExactHero.mockReset()
  mockFindTagName.mockReset()
  mockSuggest.mockReset()
  mockByTag.mockImplementation(() => [])
  mockMonstersByDay.mockImplementation(() => [])
  mockFindSkill.mockImplementation(() => undefined)
  mockFindHeroName.mockImplementation(() => undefined)
  mockFindExactHero.mockImplementation(() => undefined)
  mockFindTagName.mockImplementation(() => undefined)
  mockSuggest.mockImplementation(() => [])
  mockAiRespond.mockReset()
  mockAiRespond.mockImplementation(() => null)
  mockGetAiCooldown.mockReset()
  mockGetAiCooldown.mockImplementation(() => 0)
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

  it('whole-phrase exact card is never tier-spliced ("diamond heart" stays Diamond Heart)', () => {
    mockExact.mockImplementation((n) => n.toLowerCase() === 'diamond heart' ? ({ Title: 'Diamond Heart' } as BazaarCard) : undefined)
    const result = parseArgs(['diamond', 'heart'])
    expect(result.item).toBe('diamond heart')
    expect(result.tier).toBeUndefined()
    expect(result.enchant).toBeUndefined()
  })

  it('whole-phrase guard is singular-tolerant ("diamond hearts" stays an item)', () => {
    mockExact.mockImplementation((n) => n.toLowerCase() === 'diamond heart' ? ({ Title: 'Diamond Heart' } as BazaarCard) : undefined)
    const result = parseArgs(['diamond', 'hearts'])
    expect(result.item).toBe('diamond hearts')
    expect(result.tier).toBeUndefined()
  })

  it('plural of an enchant-prefixed item is not split ("heavy crossbows")', () => {
    mockGetEnchantments.mockImplementation(() => ['heavy'])
    mockExact.mockImplementation((n) => n.toLowerCase() === 'heavy crossbow' ? ({ Title: 'Heavy Crossbow' } as BazaarCard) : undefined)
    const result = parseArgs(['heavy', 'crossbows'])
    expect(result.enchant).toBeUndefined()
    expect(result.item).toBe('heavy crossbows')
  })

  it('genuine tier query still strips when the phrase is not an exact card', () => {
    mockExact.mockImplementation(() => undefined)
    const result = parseArgs(['diamond', 'subscraper'])
    expect(result.tier).toBe('Diamond')
    expect(result.item).toBe('subscraper')
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
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!B boomerang')
    expect(result).toBeTruthy()
    expect(result).toContain('Boomerang')
  })

  it('bare !b routes to AI for contextual response', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'chat is wild rn', mentions: [] }))
    const result = await handleCommand('!b', { user: 'chatter', channel: 'stream' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(result).toBe('chat is wild rn')
  })

  it('trims whitespace from args', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
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
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
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
    const result = await handleCommand('!b boomeran')
    expect(result).toContain('Boomerang [M]')
    expect(mockSearch).toHaveBeenCalledWith('boomeran', 1)
  })

  it('returns no-match message when no match and AI unavailable', async () => {
    const result = await handleCommand('!b xyznonexistent')
    expect(result).toContain('xyznonexistent')
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
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b boomerang')
    expect(result).toContain('bzdb.to/boomerang')
  })

  it('does not silently ignore emote names — everyone gets a response', async () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    const result = await handleCommand('!b KEKW')
    expect(result).not.toBeNull()
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
    mockExact.mockImplementation((name) => name === 'boomerang' ? card : undefined)
    expect(await handleCommand('!b icy boomerang')).toContain('[Boomerang - Icy]')
    expect(await handleCommand('!b boomerang icy')).toContain('[Boomerang - Icy]')
  })

  it('suggests alternatives when an enchant item lookup misses (no dead-end)', async () => {
    mockSuggest.mockImplementation(() => ['Fiery Boomerang'])
    const result = await handleCommand('!b fiery nonexistent')
    expect(result).toContain('no item found for nonexistent')
    expect(result).toContain('did you mean: Fiery Boomerang')
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
    expect(result).toContain('fiery')
  })

  it('single word alone is item lookup not enchant (toxic)', async () => {
    const result = await handleCommand('!b toxic')
    expect(result).toContain('toxic')
  })

  it('skill/item collision: prefers item with enchant over skill without', async () => {
    const skill = makeCard({
      Type: 'Skill',
      Title: 'Depth Charge',
      Enchantments: {},
    })
    const item = makeCard({
      Title: 'Elemental Depth Charge',
      Enchantments: {
        Fiery: {
          tags: ['Burn'],
          tooltips: [{ text: 'Burn for {n}', type: 'Active' }],
        },
      },
    })
    mockExact.mockImplementation((name) => name === 'depth charge' ? skill : undefined)
    mockSearch.mockImplementation(() => [skill, item])
    const result = await handleCommand('!b fiery depth charge')
    expect(result).toContain('[Elemental Depth Charge - Fiery]')
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
    mockExact.mockImplementation((name) => name === 'boomerang' ? card : undefined)
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

  it('an item whose name starts with an enchant word resolves to the item, not the enchant', async () => {
    // "Heavy Crossbow" is a real item; "heavy crossbow" must not be parsed as Heavy-enchanted
    const heavyCrossbow = makeCard({ Title: 'Heavy Crossbow' })
    mockExact.mockImplementation((name) => name === 'heavy crossbow' ? heavyCrossbow : undefined)
    const result = (await handleCommand('!b heavy crossbow'))!
    expect(result).toContain('Heavy Crossbow')
    expect(result).not.toContain(' - Heavy]') // the enchantment format would be "[X - Heavy]"
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

  it('falls through to AI on unknown hero', async () => {
    const result = await handleCommand('!b hero nobody')
    expect(result).toContain('nobody')
    expect(result).not.toContain('no items found for hero nobody')
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
// bare hero name routing (no `hero` keyword) — !b dooley / !b vanessa / !b pyg
// ---------------------------------------------------------------------------
describe('bare hero name routing', () => {
  it('exact hero name beats a fuzzy item match (!b dooley -> hero pool, not Dooley\'s Scarf)', async () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [makeCard({ Title: "Dooley's Scarf" })])
    mockFindExactHero.mockImplementation((q) => q.toLowerCase() === 'dooley' ? 'Dooley' : undefined)
    mockByHero.mockImplementation(() => [boomerang])
    const result = (await handleCommand('!b dooley'))!
    expect(result).toContain('[Dooley]')
    expect(result).toContain('Boomerang')
    expect(result).not.toContain("Dooley's Scarf")
  })

  it('alias resolves to hero (!b pyg -> Pygmalien pool)', async () => {
    mockExact.mockImplementation(() => undefined)
    mockFindExactHero.mockImplementation((q) => q.toLowerCase() === 'pyg' ? 'Pygmalien' : undefined)
    mockByHero.mockImplementation(() => [boomerang])
    expect((await handleCommand('!b pyg'))!).toContain('[Pygmalien]')
  })

  it('an exact ITEM still wins over a hero name (no hijack)', async () => {
    mockExact.mockImplementation((n) => n.toLowerCase() === 'vanessa' ? makeCard({ Title: 'Vanessa' }) : undefined)
    mockFindExactHero.mockImplementation(() => 'Vanessa')
    mockByHero.mockImplementation(() => [boomerang])
    expect((await handleCommand('!b vanessa'))!).not.toContain('[Vanessa]')
  })

  it('loose hero match answers when item + monster both miss (!b vaness)', async () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [])
    mockFindMonster.mockImplementation(() => undefined)
    mockFindExactHero.mockImplementation(() => undefined)
    mockFindHeroName.mockImplementation((q) => q.toLowerCase().startsWith('vaness') ? 'Vanessa' : undefined)
    mockByHero.mockImplementation(() => [boomerang])
    expect((await handleCommand('!b vaness'))!).toContain('[Vanessa]')
  })
})

// ---------------------------------------------------------------------------
// live event/patch queries route to AI (where the bazaardb patch line is injected)
// ---------------------------------------------------------------------------
describe('event/patch query routing', () => {
  it('short meta query "whats new" hits the AI, not item lookup', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'patch 15.2 dropped jun 17, no event live', mentions: [] }))
    const result = await handleCommand('!b whats new', { user: 'chatter', channel: 'stream' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(result).toContain('patch 15.2')
  })

  it('"is there an event" routes to AI, not a fuzzy item match', async () => {
    mockExact.mockImplementation(() => undefined)
    mockSearch.mockImplementation(() => [makeCard({ Title: 'Event Horizon' })])
    mockAiRespond.mockImplementation(() => ({ text: 'no special event running rn', mentions: [] }))
    const result = await handleCommand('!b is there an event', { user: 'chatter', channel: 'stream' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(result).not.toContain('Event Horizon')
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

  it('falls through to AI on unknown monster', async () => {
    const result = await handleCommand('!b mob xyzmonster')
    expect(result).toContain('xyzmonster')
    expect(result).not.toContain('no monster found for xyzmonster')
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
    expect(result).toContain('x')
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
    mockAiRespond.mockImplementation(() => ({ text: 'sup chat', mentions: [] }))
    const result = await handleCommand('!b ', { user: 'chatter', channel: 'stream' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(result).toBe('sup chat')
  })

  it('strips quotes from input', async () => {
    const eclipse = makeCard({ Title: 'The Eclipse' })
    mockExact.mockImplementation((name) => name === 'the eclipse' ? eclipse : undefined)
    const result = await handleCommand('!b "the eclipse"')
    expect(result).toContain('The Eclipse')
    expect(mockExact).toHaveBeenCalledWith('the eclipse')
  })

  it('help and info route to AI (no hardcoded usage string)', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'i look up bazaar stuff', mentions: [] }))
    const helpResult = await handleCommand('!b help', { user: 'chatter', channel: 'stream' })
    const infoResult = await handleCommand('!b info', { user: 'chatter', channel: 'stream' })
    expect(helpResult).toBe('i look up bazaar stuff')
    expect(infoResult).toBe('i look up bazaar stuff')
    expect(helpResult).not.toContain('hero/mob/skill')
    expect(helpResult).not.toContain('type !join')
  })

  it('tier-only input falls through to AI fallback', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'gold tier huh', mentions: [] }))
    const result = await handleCommand('!b gold', { user: 'chatter', channel: 'stream' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(result).toBe('gold tier huh')
  })

  // deictic questions point at recent chat, not an item — must reach AI even though
  // fuzzy search would happily match "that" → "Stop That!".
  it('deictic "what is that" routes to AI, not fuzzy item lookup', async () => {
    const stopThat = makeCard({ Title: 'Stop That!' })
    mockSearch.mockImplementation(() => [stopThat])
    mockAiRespond.mockImplementation(() => ({ text: 'they meant the diablo leak', mentions: [] }))
    const result = await handleCommand('!b what is that', { user: 'chatter', channel: 'stream' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(result).toBe('they meant the diablo leak')
    expect(result).not.toContain('Stop That!')
  })

  it('"what do you mean" / "wdym" route to AI', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'i mean the thing above', mentions: [] }))
    expect(await handleCommand('!b what do you mean', { user: 'c', channel: 'stream' })).toBe('i mean the thing above')
    expect(await handleCommand('!b wdym', { user: 'c', channel: 'stream' })).toBe('i mean the thing above')
  })

  it('real item question with a name still does item lookup', async () => {
    const card = makeCard({ Title: 'Leverage Momentum' })
    mockExact.mockImplementation((name) => name === 'leverage momentum' ? card : undefined)
    const result = await handleCommand('!b what is leverage momentum')
    expect(result).toContain('Leverage Momentum')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Integration: verify format output structure
// ---------------------------------------------------------------------------
describe('!b output format integration', () => {
  it('item output shows tooltip text', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = (await handleCommand('!b boomerang'))!
    expect(result).toContain('Deal 60 Damage')
  })

  it('enchantment output includes tags and tooltip', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
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
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
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
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
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

  it('does not log on help/usage when AI unavailable', async () => {
    // no channel → tryAiRespond bails before any logCommand
    await handleCommand('!b help', { user: 'test' })
    expect(mockLogCommand).not.toHaveBeenCalled()
  })

  it('works without context (backwards compat)', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
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

  it('strips @mention from search but tags in response', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b boomerang @hamstornado')
    expect(result).toContain('@hamstornado')
    expect(result).toContain('Boomerang')
  })

  it('strips @mention from search query', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    await handleCommand('!b boomerang @someone')
    expect(mockExact).toHaveBeenCalledWith('boomerang')
  })

  it('handles multiple mentions by tagging all', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b boomerang @user1 @user2')
    expect(result).toContain('@user1')
    expect(result).toContain('@user2')
  })

  it('mention anywhere in args', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b @someone boomerang')
    expect(result).toContain('@someone')
    expect(result).toContain('Boomerang')
  })

  it('no mention = no suffix', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
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

  it('appends @mention to enchants response', async () => {
    mockGetEnchantments.mockImplementation(() => ['deadly'])
    const result = await handleCommand('!b enchants @someone')
    expect(result).toContain('Enchantments: Deadly')
    expect(result).toContain('@someone')
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

  it('falls through to AI on unknown tag', async () => {
    const result = await handleCommand('!b tag Nonexistent')
    expect(result).toContain('Nonexistent')
    expect(result).not.toContain('no items found with tag Nonexistent')
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

  it('appends @mention to tag results', async () => {
    mockByTag.mockImplementation(() => [boomerang])
    const result = await handleCommand('!b tag Burn @friend')
    expect(result).toContain('@friend')
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

  it('falls through to AI on empty day', async () => {
    const result = await handleCommand('!b day 9')
    expect(result).toContain('day 9')
    expect(result).not.toContain('no monsters found for day 9')
  })

  it('rejects day 0', async () => {
    const result = await handleCommand('!b day 0')
    expect(result).toContain('invalid day number')
  })

  it('returns empty for day with no monsters', async () => {
    const result = await handleCommand('!b day 11')
    expect(result).toContain('day 11')
    expect(result).not.toContain('no monsters found for day 11')
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

  it('appends @mention to day results', async () => {
    mockMonstersByDay.mockImplementation(() => [lich])
    const result = await handleCommand('!b day 5 @viewer')
    expect(result).toContain('@viewer')
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

  it('falls through to AI on unknown skill', async () => {
    const result = await handleCommand('!b skill xyzskill')
    expect(result).toContain('xyzskill')
    expect(result).not.toContain('no skill found for xyzskill')
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

  it('appends @mention to skill results', async () => {
    const skill = makeCard({ Title: 'Zap', Type: 'Skill' })
    mockFindSkill.mockImplementation(() => skill)
    const result = await handleCommand('!b skill zap @someone')
    expect(result).toContain('@someone')
    expect(result).toContain('Zap')
  })
})

// ---------------------------------------------------------------------------
// !b AI fallback — conversational queries (>2 words) fall through to AI
// ---------------------------------------------------------------------------
describe('!b AI fallback', () => {
  it('conversational query falls through to AI', async () => {
    const result = await handleCommand('!b is vanessa good', { user: 'chatter', channel: 'stream' })
    // AI mock returns null by default → no-match fallback instead of silence
    expect(mockAiRespond).toHaveBeenCalled()
    expect(result).not.toContain('no match for')
  })

  it('short query + no match = no-match fallback', async () => {
    const result = await handleCommand('!b asdfghjkl', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('asdfghjkl')
  })

  it('short query + suggestions shown on miss', async () => {
    mockSuggest.mockImplementation(() => ['Boomerang', 'Boom Box'])
    const result = await handleCommand('!b boom', { user: 'chatter', channel: 'stream' })
    expect(result).toContain('did you mean')
    expect(result).toContain('Boomerang')
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

  it('blocks settitle', async () => {
    expect(await handleCommand('!b !settitle new title')).toBeNull()
  })

  it('blocks command management commands', async () => {
    for (const cmd of ['addcom', 'addcommand', 'editcom', 'editcommand',
      'delcom', 'deletecom', 'delcommand', 'deletecommand',
      'removecom', 'removecommand', 'disablecom', 'enablecom']) {
      expect(await handleCommand(`!b !${cmd}`)).toBeNull()
    }
  })

  it('proxies safe commands freely', async () => {
    for (const cmd of ['gamble', 'lurk', 'jory']) {
      expect(await handleCommand(`!b !${cmd}`, { user: 'viewer', channel: `ch${cmd}` })).toBe(`!${cmd}`)
    }
  })

  it('blocks dangerous mod commands', async () => {
    for (const cmd of ['ban', 'timeout', 'disable', 'enable', 'nuke', 'setpoints']) {
      expect(await handleCommand(`!b !${cmd}`, { user: 'viewer', channel: `blk${cmd}` })).toBeNull()
    }
  })

  it('blocked commands are case insensitive', async () => {
    expect(await handleCommand('!b !SETTITLE new')).toBeNull()
    expect(await handleCommand('!b !AddCom test')).toBeNull()
  })

  it('blocked commands with args still blocked', async () => {
    expect(await handleCommand('!b !settitle My Stream')).toBeNull()
    expect(await handleCommand('!b !addcom !test hi there')).toBeNull()
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

  it('"can you type !hug" → blocked (isAskingAbout)', async () => {
    // "can" is in isAskingAbout — question words skip embedded command proxy
    const result = await handleCommand('!b can you type !hug', { user: 'u', channel: 'c' })
    if (result) expect(result).not.toMatch(/^!hug/)
  })

  it('"pls !jory" → !jory', async () => {
    expect(await handleCommand('!b pls !jory')).toBe('!jory')
  })

  it('"hey !jory 100 thanks bro" → !jory 100', async () => {
    expect(await handleCommand('!b hey !jory 100 thanks bro')).toBe('!jory 100')
  })

  it('embedded blocked command does not execute !addcom', async () => {
    // "can you !addcom test" — blocked cmd embedded, falls through to AI fallback
    const result = await handleCommand('!b can you !addcom test', { user: 'u', channel: 'c' })
    // should NOT proxy !addcom — conversational query stays silent when AI unavailable
    if (result) expect(result).not.toMatch(/^!addcom/)
  })

  it('preserves original case of command name', async () => {
    expect(await handleCommand('!b run !Jory pls')).toBe('!Jory')
  })

  it('"make new !afk pasta" → !afk NOT proxied (content-gen, !cmd is topic)', async () => {
    const result = await handleCommand('!b make new !afk pasta', { user: 'u', channel: 'c' })
    if (result) expect(result).not.toBe('!afk')
  })

  it('"write a copypasta about !lurk" → !lurk NOT proxied', async () => {
    const result = await handleCommand('!b write a copypasta about !lurk', { user: 'u', channel: 'c' })
    if (result) expect(result).not.toBe('!lurk')
  })

  it('"make new !sacrifice pasta" → no selfTimeoutDodge (content-gen)', async () => {
    const result = await handleCommand('!b make new !sacrifice pasta', { user: 'u', channel: 'c' })
    if (result) expect(result).not.toMatch(/sacrificial|vip benefits/i)
  })

  it('"roast !jory" → !jory NOT proxied (roast is content-gen)', async () => {
    const result = await handleCommand('!b roast !jory', { user: 'u', channel: 'c' })
    if (result) expect(result).not.toBe('!jory')
  })

  it('"give me a joke about !lurk" → !lurk NOT proxied', async () => {
    const result = await handleCommand('!b give me a joke about !lurk', { user: 'u', channel: 'c' })
    if (result) expect(result).not.toBe('!lurk')
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
    expect(result).toContain('on cooldown: jory')
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
    expect(result).toContain('on cooldown: jory')
  })

  it('embedded command triggers cooldown for direct use', async () => {
    await handleCommand('!b hey do !jory pls', ctx)
    const result = await handleCommand('!b !jory', ctx)
    expect(result).toContain('on cooldown: jory')
  })

  it('no cooldown without channel context', async () => {
    await handleCommand('!b !jory')
    // no channel = no cooldown tracking
    expect(await handleCommand('!b !jory')).toBe('!jory')
  })

  it('slash commands have no cooldown (mod)', async () => {
    expect(await handleCommand('!b /me dances', { user: 'a', channel: 'ch1', isMod: true })).toBe('/me dances')
    expect(await handleCommand('!b /me dances', { user: 'a', channel: 'ch2', isMod: true })).toBe('/me dances')
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
  it('allows /me for mods', async () => {
    expect(await handleCommand('!b /me dances', { isMod: true })).toBe('/me dances')
  })

  it('blocks /me for non-mods', async () => {
    expect(await handleCommand('!b /me is the channel owner')).toBeNull()
    expect(await handleCommand('!b /me dances', { isMod: false })).toBeNull()
  })

  it('allows /announce for mods', async () => {
    expect(await handleCommand('!b /announce hello everyone', { isMod: true })).toBe('/announce hello everyone')
  })

  it('blocks /announce for non-mods', async () => {
    expect(await handleCommand('!b /announce hello everyone')).toBeNull()
  })

  it('allows /color for mods', async () => {
    expect(await handleCommand('!b /color blue', { isMod: true })).toBe('/color blue')
  })

  it('blocks /color for non-mods', async () => {
    expect(await handleCommand('!b /color blue')).toBeNull()
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

  it('slash allowlist is case insensitive for mods', async () => {
    expect(await handleCommand('!b /ME dances', { isMod: true })).toBe('/ME dances')
    expect(await handleCommand('!b /ANNOUNCE hi', { isMod: true })).toBe('/ANNOUNCE hi')
  })
})

// ---------------------------------------------------------------------------
// Mod bypass for blocked commands
// ---------------------------------------------------------------------------
describe('command proxy: blocked commands', () => {
  it('blocked commands are blocked for everyone including mods', async () => {
    expect(await handleCommand('!b !settitle new', { user: 'mod', channel: 'ch', privileged: true, isMod: true })).toBeNull()
    expect(await handleCommand('!b !addcom test', { user: 'mod', channel: 'ch2', privileged: true, isMod: true })).toBeNull()
    expect(await handleCommand('!b !disable brb', { user: 'mod', channel: 'ch3', privileged: true, isMod: true })).toBeNull()
    expect(await handleCommand('!b !permit someone', { user: 'mod', channel: 'ch4', privileged: true, isMod: true })).toBeNull()
  })

  it('non-mod cannot proxy blocked commands', async () => {
    expect(await handleCommand('!b !settitle new', { user: 'viewer', channel: 'chv' })).toBeNull()
    expect(await handleCommand('!b !addcom test', { user: 'viewer', channel: 'chv2' })).toBeNull()
  })

  it('custom commands still work for non-privileged', async () => {
    expect(await handleCommand('!b !jory', { user: 'viewer', channel: 'chj' })).toBe('!jory')
  })
})

// ---------------------------------------------------------------------------
// Self-timeout dodge — bot is vip not mod, so other bots' self-timeout commands
// must not be parroted back as a literal !cmd or it'll get the bot timed out.
// Instead, return a clever comeback that contains no !cmd token.
// ---------------------------------------------------------------------------
describe('self-timeout dodge', () => {
  const SELF_HARM_CMDS = ['endme', 'kms', 'sudoku', 'seppuku', 'die', 'kill', 'killme', 'rip', 'sacrifice']

  it('returns a non-empty comeback for self-timeout commands', async () => {
    for (const cmd of SELF_HARM_CMDS) {
      const r = await handleCommand(`!b !${cmd}`, { user: 'viewer', channel: `dodge-${cmd}` })
      expect(r).toBeTruthy()
      expect(typeof r).toBe('string')
      expect((r as string).length).toBeGreaterThan(0)
    }
  })

  it('comeback never contains a literal !cmd that would trigger another bot', async () => {
    for (const cmd of SELF_HARM_CMDS) {
      // sample many times since responses are random — must be safe every roll
      for (let i = 0; i < 30; i++) {
        const ch = `dodge-safety-${cmd}-${i}`
        const r = await handleCommand(`!b !${cmd}`, { user: `v${i}`, channel: ch })
        expect(r).toBeTruthy()
        // no real self-harm cmd may appear with ! prefix (typoed/misspelled forms are fine — those are the joke)
        for (const harmCmd of SELF_HARM_CMDS) {
          expect(r as string).not.toMatch(new RegExp(`!\\s*${harmCmd}\\b`, 'i'))
        }
      }
    }
  })

  it('embedded self-timeout command in chat also dodges', async () => {
    const r = await handleCommand('!b pls run !endme for me', { user: 'viewer', channel: 'embed-dodge' })
    expect(r).toBeTruthy()
    for (const harmCmd of SELF_HARM_CMDS) {
      expect(r as string).not.toMatch(new RegExp(`!\\s*${harmCmd}\\b`, 'i'))
    }
  })

  it('cooldown silences repeated dodges in same channel', async () => {
    const ch = 'dodge-cd'
    const first = await handleCommand('!b !endme', { user: 'a', channel: ch })
    expect(first).toBeTruthy()
    const second = await handleCommand('!b !endme', { user: 'b', channel: ch })
    expect(second).toBeNull()
  })

  it('non-self-harm blocked commands still return null (no dodge)', async () => {
    expect(await handleCommand('!b !ban someone', { user: 'viewer', channel: 'noban' })).toBeNull()
    expect(await handleCommand('!b !settitle x', { user: 'viewer', channel: 'notitle' })).toBeNull()
    expect(await handleCommand('!b !addcom y', { user: 'viewer', channel: 'noaddcom' })).toBeNull()
  })
})

describe('spam wall cap', () => {
  function tokens(s: string | null): string[] {
    return (s ?? '').split(/\s+/).filter((t) => t && !t.startsWith('bzdb.to') && !t.startsWith('http'))
  }

  it('caps single emote at 5 copies', async () => {
    const out = await handleCommand('!b spam KEKW', { user: 'u', channel: 'c' })
    const t = tokens(out).filter((w) => w === 'KEKW')
    expect(t.length).toBe(5)
  })

  it('caps multi-emote total at 5 (not 5 each)', async () => {
    const out = await handleCommand('!b spam KEKW Sadge LULW', { user: 'u', channel: 'c' })
    const t = tokens(out).filter((w) => /^(KEKW|Sadge|LULW)$/.test(w))
    expect(t.length).toBe(5)
  })

  it('rotates through unique emotes', async () => {
    const out = await handleCommand('!b spam KEKW Sadge', { user: 'u', channel: 'c' })
    expect(out).toContain('KEKW Sadge KEKW Sadge KEKW')
  })

  it('drops conversational filler around emote', async () => {
    const out = await handleCommand('!b spam KEKW pls Mr. Clanker', { user: 'u', channel: 'c' })
    const t = tokens(out).filter((w) => w === 'KEKW')
    expect(t.length).toBe(5)
    expect(out).not.toMatch(/pls|Clanker/)
  })

  // emote-FIRST order ("67 spam") — the live miss: it fell through to AI and posted once
  it('handles emote-first spam intent "67 spam" → 5 copies', async () => {
    const out = await handleCommand('!b 67 spam', { user: 'u', channel: 'c' })
    const t = tokens(out).filter((w) => w === '67')
    expect(t.length).toBe(5)
  })

  it('emote-first works with a real emote name too ("KEKW spam")', async () => {
    const out = await handleCommand('!b KEKW spam', { user: 'u', channel: 'c' })
    expect(tokens(out).filter((w) => w === 'KEKW').length).toBe(5)
  })

  it('emote-first allows trivial filler ("the 67 spam")', async () => {
    const out = await handleCommand('!b the 67 spam', { user: 'u', channel: 'c' })
    expect(tokens(out).filter((w) => w === '67').length).toBe(5)
  })

  it('emote-first does NOT fire on a complaint ("stop the 67 spam")', async () => {
    const out = await handleCommand('!b stop the 67 spam', { user: 'u', channel: 'c' })
    // not a 5x wall — a non-emote word ("stop") means it's not a spam request
    expect(tokens(out).filter((w) => w === '67').length).toBeLessThan(5)
  })
})

// ---------------------------------------------------------------------------
// bare !b: bulletproof contract
//   - never emits the legacy usage string
//   - prioritizes answering an unanswered chat question
//   - picks blunt vs guised based on spoiler-sensitive signals (no randomness)
//   - falls back to varied nudge anchored on real chat
//   - bounded to AI_MAX_QUERY_LEN (200)
// ---------------------------------------------------------------------------
describe('buildBareBQuery — bulletproof contract', () => {
  const TAIL = 'dont react to "!b" itself.'

  beforeEach(() => {
    mockIsGameActive.mockReset()
    mockIsGameActive.mockImplementation(() => false)
    chatbuf.cleanupChannel('bare-test')
    chatbuf.cleanupChannel('bare-trivia')
    chatbuf.cleanupChannel('bare-spoiler')
    chatbuf.cleanupChannel('bare-empty')
  })

  it('no channel: returns nudge + anti-meta tail, no anchor', () => {
    const q = buildBareBQuery()
    expect(q).toContain(TAIL)
    expect(q).not.toContain('anchor:')
    expect(BARE_B_NUDGES.some((n) => q.startsWith(n))).toBe(true)
  })

  it('always under AI_MAX_QUERY_LEN (200) — 200 iterations w/ long chat', () => {
    for (let i = 0; i < 30; i++) {
      chatbuf.record('bare-test', `user${i}`, 'x'.repeat(120) + ` msg ${i}`)
    }
    for (let i = 0; i < 200; i++) {
      const q = buildBareBQuery('bare-test')
      expect(q.length).toBeLessThanOrEqual(200)
    }
  })

  it('every output ends with the anti-meta tail', () => {
    chatbuf.record('bare-test', 'alice', 'vanessa loadout opinions?')
    for (let i = 0; i < 30; i++) {
      expect(buildBareBQuery('bare-test')).toContain(TAIL)
    }
  })

  it('filters bot messages out of anchor and question detection', () => {
    chatbuf.record('bare-test', 'bazaarinfo', 'is this a question?')
    chatbuf.record('bare-test', 'alice', 'normal chatter line here')
    const q = buildBareBQuery('bare-test')
    expect(q).not.toContain('bazaarinfo:')
    expect(q).toContain('alice')
  })

  it('filters !-prefixed messages out of anchor', () => {
    chatbuf.record('bare-test', 'alice', '!ping')
    chatbuf.record('bare-test', 'bob', 'real chat content here')
    const q = buildBareBQuery('bare-test')
    expect(q).not.toMatch(/alice:\s*!ping/)
    expect(q).toContain('bob')
  })

  it('filters too-short messages from anchor (≤3 chars)', () => {
    chatbuf.record('bare-test', 'alice', 'lol')
    chatbuf.record('bare-test', 'bob', 'meaningful message text')
    const q = buildBareBQuery('bare-test')
    expect(q).not.toMatch(/alice:\s*lol/)
    expect(q).toContain('bob')
  })

  it('caps per-message length in the anchor at ~60 chars', () => {
    chatbuf.record('bare-test', 'alice', 'a'.repeat(200))
    const q = buildBareBQuery('bare-test')
    // alice's 200-char message should not appear at full length
    expect(q).not.toContain('a'.repeat(100))
  })

  it('100 invocations span ≥ half the nudges (variety, no chat)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const q = buildBareBQuery()
      for (const n of BARE_B_NUDGES) if (q.startsWith(n)) { seen.add(n); break }
    }
    expect(seen.size).toBeGreaterThanOrEqual(Math.ceil(BARE_B_NUDGES.length / 2))
  })
})

describe('findUnansweredQuestion', () => {
  beforeEach(() => { chatbuf.cleanupChannel('q-ch') })

  it('detects trailing question mark', () => {
    chatbuf.record('q-ch', 'alice', 'is vanessa busted right now?')
    const q = findUnansweredQuestion('q-ch')
    expect(q?.text).toContain('vanessa')
  })

  it('detects interrogative-word start without question mark', () => {
    chatbuf.record('q-ch', 'alice', 'how does crit chance work')
    const q = findUnansweredQuestion('q-ch')
    expect(q?.user).toBe('alice')
  })

  it('returns null when question has a substantive reply by another user', () => {
    chatbuf.record('q-ch', 'alice', 'how does crit work?')
    chatbuf.record('q-ch', 'bob', 'crit doubles damage, simple math really')
    expect(findUnansweredQuestion('q-ch')).toBeNull()
  })

  it('still flagged unanswered if "reply" is by same user', () => {
    chatbuf.record('q-ch', 'alice', 'how does crit work?')
    chatbuf.record('q-ch', 'alice', 'i mean specifically for vanessa builds')
    const q = findUnansweredQuestion('q-ch')
    expect(q?.user).toBe('alice')
  })

  it('still flagged unanswered if reply is too short (<=15 chars)', () => {
    chatbuf.record('q-ch', 'alice', 'is shield good?')
    chatbuf.record('q-ch', 'bob', 'idk')
    const q = findUnansweredQuestion('q-ch')
    expect(q?.text).toContain('shield')
  })

  it('ignores statements without question markers', () => {
    chatbuf.record('q-ch', 'alice', 'vanessa is just fine honestly')
    expect(findUnansweredQuestion('q-ch')).toBeNull()
  })

  it('walks back to find the most recent unanswered q', () => {
    chatbuf.record('q-ch', 'a', 'is X good?')
    chatbuf.record('q-ch', 'b', 'yeah X is solid, no question about it')
    chatbuf.record('q-ch', 'c', 'what about Y though?')
    const q = findUnansweredQuestion('q-ch')
    expect(q?.text).toContain('Y')
  })
})

describe('bare !b answer-style selection (context-driven, not random)', () => {
  beforeEach(() => {
    mockIsGameActive.mockReset()
    mockIsGameActive.mockImplementation(() => false)
    chatbuf.cleanupChannel('style-ch')
  })

  it('blunt by default when an unanswered question exists', () => {
    chatbuf.record('style-ch', 'alice', 'is vanessa good vs aggro?')
    const q = buildBareBQuery('style-ch')
    expect(q.toLowerCase()).toContain('bluntly')
    expect(q.toLowerCase()).not.toContain('guised')
  })

  it('guised when trivia is active in the channel', () => {
    mockIsGameActive.mockImplementation(() => true)
    chatbuf.record('style-ch', 'alice', 'what hero is this skill from?')
    const q = buildBareBQuery('style-ch')
    expect(q.toLowerCase()).toContain('guised')
    expect(q.toLowerCase()).not.toContain('bluntly')
  })

  it('guised when chat signals "no spoilers"', () => {
    chatbuf.record('style-ch', 'asker', 'whats the answer to the riddle?')
    chatbuf.record('style-ch', 'other', 'no spoilers please im trying to figure it out')
    const q = buildBareBQuery('style-ch')
    expect(q.toLowerCase()).toContain('guised')
  })

  it('guised when chat signals "trying to guess"', () => {
    chatbuf.record('style-ch', 'asker', 'is it the one with burn?')
    chatbuf.record('style-ch', 'other', 'wait im trying to guess give me a sec')
    const q = buildBareBQuery('style-ch')
    expect(q.toLowerCase()).toContain('guised')
  })
})

describe('bare !b: regression guardrails — usage string is dead', () => {
  it('handleCommand never returns the legacy usage line', async () => {
    mockAiRespond.mockImplementation(() => null)
    const inputs = ['!b', '!b ', '!b help', '!b info', '!b gold', '!b bronze']
    for (const input of inputs) {
      const result = await handleCommand(input, { user: 'u', channel: 'c' })
      if (result === null) continue
      expect(result).not.toContain('hero/mob/skill')
      expect(result).not.toContain('type !join')
      expect(result).not.toContain('<item> [tier]')
    }
  })

  it('commands.ts source contains no hardcoded usage constants', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(resolve(import.meta.dir, 'commands.ts'), 'utf8')
    // strip the regression-test bookkeeping comment lines so they don't self-match
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')
    expect(code).not.toMatch(/BASE_USAGE\s*=/)
    expect(code).not.toMatch(/JOIN_USAGE\s*=/)
    expect(code).not.toMatch(/\blobbyChannel\b/)
    expect(code).not.toMatch(/!b <item> \[tier\]/)
    expect(code).not.toMatch(/hero\/mob\/skill\/tag\/day/)
    expect(code).not.toMatch(/type !join in/)
  })
})

describe('custom-topic trivia: !trivia <topic>', () => {
  beforeEach(() => {
    mockIsGameActive.mockImplementation(() => false)
    mockGenerateCustomTrivia.mockClear()
    mockGenerateCustomTrivia.mockImplementation(async () => ({ question: 'custom q?', answer: 'ans', accept: ['ans', 'answer'] }))
    mockStartKrippTrivia.mockClear()
    mockStartKrippTrivia.mockImplementation(() => null) // default: not a kripp channel / empty pack
    mockStartFallbackTrivia.mockClear()
    mockStartFallbackTrivia.mockImplementation(() => 'Trivia! fallback question (30s)') // default: pack loaded
  })

  it('routes a kripp-subject topic to the curated verified pack when available', async () => {
    mockStartKrippTrivia.mockImplementation(() => 'Trivia! kripp pack question (30s)')
    const res = await handleCommand('!b trivia about kripp chat', { user: 'u', channel: 'ct-kp' })
    expect(res).toBe('Trivia! kripp pack question (30s)')
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled() // curated pack, not the AI
  })

  it('an incidental "kripp" mention does NOT hijack to the kripp pack (the Romania->D3 bug)', async () => {
    // kripp pack IS available here, but the subject is Romania — "to see if kripp can
    // answer" is framing addressed at the streamer, not the topic. must NOT serve D3 lore.
    mockStartKrippTrivia.mockImplementation(() => 'Trivia! kripp pack question (30s)')
    await handleCommand('!b trivia about Romania to see if kripp can answer', { user: 'u', channel: 'ct-rom' })
    expect(mockStartKrippTrivia).not.toHaveBeenCalled()
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('Romania', 'ct-rom', [], [])
  })

  it('strips a trailing purpose/framing clause so the topic stays clean', async () => {
    await handleCommand('!b trivia about deep sea creatures so chat can guess', { user: 'u', channel: 'ct-fr1' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('deep sea creatures', 'ct-fr1', [], [])
    mockGenerateCustomTrivia.mockClear()
    await handleCommand('!b trivia about the cold war and see who knows', { user: 'u', channel: 'ct-fr2' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('the cold war', 'ct-fr2', [], [])
  })

  it('a real title containing "to <verb>" survives the framing strip', async () => {
    await handleCommand('!b trivia about how to train your dragon', { user: 'u', channel: 'ct-fr3' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('how to train your dragon', 'ct-fr3', [], [])
  })

  it('a genuine kripp-subject topic still routes to the curated pack', async () => {
    mockStartKrippTrivia.mockImplementation(() => 'Trivia! kripp pack question (30s)')
    const res = await handleCommand("!b trivia about kripp's d3 runs", { user: 'u', channel: 'ct-kp3' })
    expect(res).toBe('Trivia! kripp pack question (30s)')
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
  })

  it('falls back to AI for a kripp topic when no pack (non-kripp channel)', async () => {
    mockStartKrippTrivia.mockImplementation(() => null)
    await handleCommand('!b trivia about kripp', { user: 'u', channel: 'ct-kp2' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('kripp', 'ct-kp2', [], [])
  })

  it('routes the channel login form "nl_kripp" to the curated pack, not the AI pipeline', async () => {
    mockStartKrippTrivia.mockImplementation(() => 'Trivia! kripp pack question (30s)')
    const res = await handleCommand('!b trivia about nl_kripp', { user: 'u', channel: 'ct-nlk' })
    expect(res).toBe('Trivia! kripp pack question (30s)')
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
  })

  it('routes an arbitrary topic to the AI generator then launches a custom round', async () => {
    const res = await handleCommand('!b trivia roman history', { user: 'u', channel: 'ct-1' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('roman history', 'ct-1', [], [])
    expect(res).toBe('Trivia! custom question (30s)')
  })

  it('works via the top-level !trivia command too', async () => {
    const res = await handleCommand('!trivia the deep sea', { user: 'u', channel: 'ct-2' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('the deep sea', 'ct-2', [], [])
    expect(res).toBe('Trivia! custom question (30s)')
  })

  it('falls back to a curated round (never "clearer topic") when generation fails, LABELED with the topic', async () => {
    mockGenerateCustomTrivia.mockImplementation(async () => null)
    mockStartFallbackTrivia.mockImplementation(() => 'Trivia! fallback question (30s)')
    const res = await handleCommand('!b trivia asdfqwer nonsense', { user: 'u', channel: 'ct-3' })
    expect(mockStartFallbackTrivia).toHaveBeenCalled()
    expect(res).toContain('Trivia!')
    expect(res).not.toContain('clearer topic')
    // the substitute must announce itself, not masquerade as the requested topic
    expect(res).toContain("couldn't cook one about")
    expect(res).toContain('asdfqwer')
  })

  it('only soft-fails (no clearer-topic) if even the curated pack is empty', async () => {
    mockGenerateCustomTrivia.mockImplementation(async () => null)
    mockStartFallbackTrivia.mockImplementation(() => null)
    const res = await handleCommand('!b trivia asdfqwer nonsense', { user: 'u', channel: 'ct-3b' })
    expect(res).not.toContain('clearer topic')
    expect(res).toContain('try again')
  })

  it('does not generate when a round is already running', async () => {
    mockIsGameActive.mockImplementation(() => true)
    const res = await handleCommand('!b trivia anything', { user: 'u', channel: 'ct-4' })
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
    expect(res).toContain('already running')
  })

  it('built-in categories never hit the AI generator', async () => {
    for (const cat of ['items', 'heroes', 'monsters', 'kripp']) {
      await handleCommand(`!b trivia ${cat}`, { user: 'u', channel: `ct-cat-${cat}` })
    }
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
  })

  it('bare !trivia and !b trivia start a normal random round, not a custom one', async () => {
    const a = await handleCommand('!trivia', { user: 'u', channel: 'ct-5' })
    const b = await handleCommand('!b trivia', { user: 'u', channel: 'ct-6' })
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
    expect(a).toBe('Trivia! test question (30s to answer)')
    expect(b).toBe('Trivia! test question (30s to answer)')
  })

  it('ignores empty/symbol-only topics without an API call', async () => {
    const res = await handleCommand('!b trivia ???', { user: 'u', channel: 'ct-7' })
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
    expect(res).toBeNull()
  })

  it('strips emote spam from the topic before generating', async () => {
    await handleCommand('!b trivia birds KEKW Sadge', { user: 'u', channel: 'ct-8' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('birds', 'ct-8', [], [])
  })

  it('strips emotes interleaved through the topic', async () => {
    await handleCommand('!b trivia LULW roman LUL history Kappa', { user: 'u', channel: 'ct-9' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('roman history', 'ct-9', [], [])
  })

  it('keeps an all-emote topic as-is rather than emptying it', async () => {
    await handleCommand('!b trivia OMEGALUL', { user: 'u', channel: 'ct-10' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('OMEGALUL', 'ct-10', [], [])
  })

  it('"Kripp chat" is a topic (deep lore), not a chat-log recall question', async () => {
    mockGenerateChatTrivia.mockClear()
    await handleCommand('!b trivia about Kripp chat', { user: 'u', channel: 'ct-kc' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('Kripp chat', 'ct-kc', [], [])
    expect(mockGenerateChatTrivia).not.toHaveBeenCalled()
  })

  it('bare "chat" still routes to chat-log recall', async () => {
    mockGenerateChatTrivia.mockClear()
    mockGenerateCustomTrivia.mockClear()
    await handleCommand('!b trivia about chat', { user: 'u', channel: 'ct-bc' })
    expect(mockGenerateChatTrivia).toHaveBeenCalled()
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
  })

  it('strips invisible/format chars chat injects into the topic', async () => {
    // trailing U+034F (combining grapheme joiner) + a zero-width space mid-word
    await handleCommand('!b trivia se\u200Bx\u034F', { user: 'u', channel: 'ct-inv' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('sex', 'ct-inv', [], [])
  })
})

describe('person-targeted trivia: !trivia about @user', () => {
  beforeEach(() => {
    mockIsGameActive.mockImplementation(() => false)
    mockGenerateCustomTrivia.mockClear()
    mockGenerateCustomTrivia.mockImplementation(async () => ({ question: 'custom q?', answer: 'ans', accept: ['ans'] }))
    mockGeneratePersonTrivia.mockClear()
    mockGeneratePersonTrivia.mockImplementation(async () => ({ question: 'whats their go-to item?', answer: 'sword', accept: ['sword'] }))
    mockGetUserFacts.mockClear(); mockGetUserFacts.mockImplementation(() => [])
    mockGetUserMessages.mockClear(); mockGetUserMessages.mockImplementation(() => [])
    mockGetUserTopItems.mockClear(); mockGetUserTopItems.mockImplementation(() => [])
  })

  it('routes "@user" to the person generator, built from logged facts + messages', async () => {
    mockGetUserFacts.mockImplementation(() => ['mains vanessa', 'always types KEKW'])
    mockGetUserMessages.mockImplementation(() => ['KEKW', 'KEKW that was nuts', 'KEKW', 'vanessa is op', '!b dooltackle'])
    const res = await handleCommand('!b trivia about @sw1ngggg', { user: 'asker', channel: 'pt-1' })
    expect(mockGeneratePersonTrivia).toHaveBeenCalledTimes(1)
    const [dossier, handle, channel] = mockGeneratePersonTrivia.mock.calls[0]
    expect(handle).toBe('@sw1ngggg')
    expect(channel).toBe('pt-1')
    expect(dossier).toContain('mains vanessa')
    expect(dossier).toContain('signature emote (their most-spammed): KEKW') // counted, not guessed
    expect(dossier).not.toContain('!b dooltackle') // commands stripped from the sample
    expect(mockGetUserFacts).toHaveBeenCalledWith('sw1ngggg', expect.anything())
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled() // never the generic topic path
    expect(res).toBe('Trivia! custom question (30s) @sw1ngggg') // launches + tags the target
  })

  it('quizzes a chat-only regular (messages, no command/users-row stats)', async () => {
    // never ran a command -> getUserStats null, but they chat plenty. must still work.
    mockGetUserFacts.mockImplementation(() => [])
    mockGetUserMessages.mockImplementation(() => ['Sadge', 'gg', 'Sadge', 'nice play', 'Sadge', 'lol', 'wp'])
    await handleCommand('!b trivia about @lurkerbob', { user: 'asker', channel: 'pt-cor' })
    expect(mockGeneratePersonTrivia).toHaveBeenCalledTimes(1)
    expect(mockGeneratePersonTrivia.mock.calls[0][0]).toContain('signature emote (their most-spammed): Sadge')
  })

  it('misses cleanly (no API call) when we have no logged data on the @user', async () => {
    const res = await handleCommand('!b trivia about @ghost', { user: 'asker', channel: 'pt-2' })
    expect(mockGeneratePersonTrivia).not.toHaveBeenCalled()
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
    expect(res).toContain("don't know enough about @ghost")
  })

  it('a bare username with no @ stays a normal topic, not a person', async () => {
    await handleCommand('!b trivia about sw1ngggg', { user: 'asker', channel: 'pt-3' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('sw1ngggg', 'pt-3', [], [])
    expect(mockGeneratePersonTrivia).not.toHaveBeenCalled()
  })
})

describe('trivia-result questions answered from real data (no AI fabrication)', () => {
  beforeEach(() => {
    mockGetLastTriviaResult.mockClear(); mockGetLastTriviaResult.mockImplementation(() => null)
    mockIsGameActive.mockImplementation(() => false)
    mockAiRespond.mockClear()
  })

  it('"who won the trivia" replies from the DB, never the AI', async () => {
    mockGetLastTriviaResult.mockImplementation(() => ({ question: 'q?', answer: 'GLaDOS', winner: 'tidolar' }))
    const res = await handleCommand('!b who won the trivia? we did not see ur message', { user: 'u', channel: 'c1' })
    expect(res).toContain('tidolar won the last round')
    expect(res).toContain('GLaDOS')
    expect(mockAiRespond).not.toHaveBeenCalled() // the hallucination path is never taken
  })

  it('says nobody won (and reveals the answer) when the last round had no winner', async () => {
    mockGetLastTriviaResult.mockImplementation(() => ({ question: 'q?', answer: 'FTL', winner: null }))
    const res = await handleCommand('!b who won trivia', { user: 'u', channel: 'c2' })
    expect(res).toContain('nobody got the last round')
    expect(res).toContain('FTL')
  })

  it('does not leak the answer of a round still in progress', async () => {
    mockIsGameActive.mockImplementation(() => true)
    mockGetLastTriviaResult.mockImplementation(() => ({ question: 'q?', answer: 'SECRET', winner: null }))
    const res = await handleCommand('!b who is winning the trivia', { user: 'u', channel: 'c3' })
    expect(res).not.toContain('SECRET')
    expect(res).toContain("round's live")
  })

  it('a topic request like "trivia about winning" still starts a round, not a result lookup', async () => {
    mockGenerateCustomTrivia.mockClear()
    mockGenerateCustomTrivia.mockImplementation(async () => ({ question: 'q?', answer: 'a', accept: ['a'] }))
    await handleCommand('!b trivia about winning', { user: 'u', channel: 'c4' })
    expect(mockGetLastTriviaResult).not.toHaveBeenCalled()
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('winning', 'c4', [], [])
  })

  it('a bare "leaderboard" ask returns the exact trivia table, free (no AI)', async () => {
    const res = await handleCommand('!b leaderboard', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  it('"who\'s winning" with no trivia word still routes to the standings table, not the AI', async () => {
    const res = await handleCommand("!b who's winning", { user: 'u', channel: 'cb2' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  it('a conversational leaderboard mention falls through to the (grounded) AI, not the bare table', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'you mean the trivia leaderboard? nobody yet', mentions: [] }))
    const res = await handleCommand('!b i am talking about the leaderboard', { user: 'u', channel: 'cb3' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(res).toContain('trivia leaderboard')
  })

  it('a live round defers the bare standings ask instead of leaking the in-flight answer', async () => {
    mockIsGameActive.mockImplementation(() => true)
    const res = await handleCommand('!b standings', { user: 'u', channel: 'cb4' })
    expect(res).toContain("round's live")
  })

  // defect 1 — "who has the most wins/points" never matched, deflected to AI
  it('"who has the most wins" routes to standings table, not AI', async () => {
    const res = await handleCommand('!b who has the most wins', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  it('"who has the most points" routes to standings table', async () => {
    const res = await handleCommand('!b who has the most points', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  // defect 2 — "points leader" / "leading in points" never matched
  it('"points leader" routes to standings table', async () => {
    const res = await handleCommand('!b points leader', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  it('"leading in points" routes to standings table', async () => {
    const res = await handleCommand('!b leading in points', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  // defect 3 — single-char typo "leaderbord" treated as item lookup noise
  it('"leaderbord" (1-char typo) routes to standings table via typo tolerance', async () => {
    const res = await handleCommand('!b leaderbord', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  // defect 4 — first-person count "how many wins do i have" never matched
  it('"how many trivia wins do i have" routes to standings table', async () => {
    const res = await handleCommand('!b how many trivia wins do i have', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  it('"how many points do i have" routes to standings table', async () => {
    const res = await handleCommand('!b how many points do i have', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  // defect 6 — present-tense "who's winning trivia" was routed to last-winner, not standings
  it('"who\'s winning trivia" routes to standings table, not last-round winner', async () => {
    mockGetLastTriviaResult.mockImplementation(() => ({ question: 'q?', answer: 'SPOILER', winner: 'tidolar' }))
    const res = await handleCommand("!b who's winning trivia", { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(res).not.toContain('SPOILER')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  it('"who is winning trivia" routes to standings table, not last-round winner', async () => {
    mockGetLastTriviaResult.mockImplementation(() => ({ question: 'q?', answer: 'SPOILER2', winner: 'someuser' }))
    const res = await handleCommand('!b who is winning trivia', { user: 'u', channel: 'cb1' })
    expect(res).toBe('no trivia scores yet')
    expect(res).not.toContain('SPOILER2')
    expect(mockAiRespond).not.toHaveBeenCalled()
  })

  // "trivia about winning" must NOT be hijacked — it is a custom-topic round request
  it('"trivia about winning" still starts a round, not a standings lookup', async () => {
    mockGenerateCustomTrivia.mockClear()
    mockGenerateCustomTrivia.mockImplementation(async () => ({ question: 'q?', answer: 'a', accept: ['a'] }))
    await handleCommand('!b trivia about winning', { user: 'u', channel: 'cb1' })
    expect(mockGetLastTriviaResult).not.toHaveBeenCalled()
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('winning', 'cb1', [], [])
  })
})

describe('chat-planted steering directives (vibes)', () => {
  beforeEach(() => {
    directives.resetForTest()
    mockParseDirective.mockClear()
    mockParseDirective.mockImplementation(async () => ({ trigger: ['topology'], targetUser: undefined, mute: false, instruction: 'work in GachiBlacksmith' }))
    mockAiRespond.mockImplementation(() => null)
  })

  it('routes a plant-intent message to the AI gate and stores the directive', async () => {
    const res = await handleCommand('!b anytime someone asks about topology can you incorporate GachiBlacksmith', { user: 'planter1', channel: 'vibe-1' })
    expect(mockParseDirective).toHaveBeenCalled()
    expect(res).toContain('got it')
    expect(res).toContain('GachiBlacksmith')
    expect(directives.listDirectives('vibe-1').length).toBe(1)
  })

  // adversarial prefilter corpus — the cheap gate that decides when to spend a classify
  // call. must fire on every flavor of real directive (topic / persistent-self / per-user /
  // mute) and stay quiet on normal chat so we don't burn paid calls. proven offline; the
  // AI gate is the real validator behind it.
  it('DIRECTIVE_INTENT fires on every directive phrasing (no false negatives)', () => {
    const SHOULD_PLANT = [
      'be sure to end your messages often with BlueBirdge',
      'from now on talk like a pirate',
      'always end with PogChamp',
      'end your messages with KEKW',
      'start every reply with gm',
      'sign off your answers with o7',
      'keep saying based after everything',
      'remember to add Kappa to every answer',
      'going forward respond in uwu',
      'from now on call everyone champ',
      'always address people as captain',
      'FROM NOW ON END YOUR MESSAGES WITH BlueBirdge', // casing
      'anytime someone asks about topology work in GachiBlacksmith',
      'whenever someone asks about builds mention the dagger',
      'answer kripp in pirate speak',     // per-user — was silently missed before
      'respond to bob like a robot',
      'talk to alice in french',
      'treat lirik like royalty',
      "don't respond to bloodstreamchaos",
      'stop replying to griefer123',
      'ignore trolluser',
    ]
    const misses = SHOULD_PLANT.filter((t) => !DIRECTIVE_INTENT.test(t))
    expect(misses).toEqual([])
  })

  it('DIRECTIVE_INTENT stays quiet on normal chat (no wasted paid calls)', () => {
    const SHOULD_NOT_PLANT = [
      'what is the best item for vanessa',
      'how do i beat the lich',
      'i always lose to kripp',
      'you should always attack first',
      'keep it up',
      'every time i play i win',
      'what does BlueBirdge mean',
      'always go for the crit build',
      'ignore that last message',
      'ignore the haters',
      'can you tell me about the merchant',
      'talk to the merchant to buy items',
      'answer this in chat please',
      'respond to that when you can',
      'treat yourself today',
      'speak to npc for the quest',
      'stop camping the merchant',
      'i never win these',
    ]
    const falsePos = SHOULD_NOT_PLANT.filter((t) => DIRECTIVE_INTENT.test(t))
    expect(falsePos).toEqual([])
  })

  it('DIRECTIVE_INTENT is ReDoS-safe on pathological input', () => {
    const t0 = performance.now()
    DIRECTIVE_INTENT.test('always ' + 'a'.repeat(50000))
    DIRECTIVE_INTENT.test('answer ' + 'x'.repeat(50000) + ' in')
    DIRECTIVE_INTENT.test('end '.repeat(20000) + 'your messages')
    expect(performance.now() - t0).toBeLessThan(250)
  })

  it('routes a persistent self-style request ("end your messages with X") to the gate', async () => {
    mockParseDirective.mockImplementation(async () => ({ trigger: [], targetUser: undefined, mute: false, instruction: 'end every message with BlueBirdge' }))
    const res = await handleCommand('!b be sure to end your messages often with BlueBirdge', { user: 'coaoaba', channel: 'vibe-self' })
    expect(mockParseDirective).toHaveBeenCalled()
    expect(res).toContain('got it')
    expect(directives.listDirectives('vibe-self').length).toBe(1)
    // a global steer colors every later answer regardless of topic/asker
    expect(directives.directiveHint('vibe-self', 'anything at all', 'wollip').length).toBeGreaterThan(0)
  })

  it('routes "from now on talk like a pirate" to the gate', async () => {
    mockParseDirective.mockImplementation(async () => ({ trigger: [], targetUser: undefined, mute: false, instruction: 'talk like a pirate' }))
    await handleCommand('!b from now on always talk like a pirate', { user: 'planterpirate', channel: 'vibe-pirate' })
    expect(mockParseDirective).toHaveBeenCalled()
    expect(directives.listDirectives('vibe-pirate').length).toBe(1)
  })

  it('a stored directive matches the right query and surfaces in the prompt hint', async () => {
    await handleCommand('!b whenever someone asks about topology work in GachiBlacksmith', { user: 'planter2', channel: 'vibe-2' })
    expect(directives.directiveHint('vibe-2', 'is a mug homeomorphic? topology q').length).toBeGreaterThan(0)
    expect(directives.directiveHint('vibe-2', 'best vanessa item')).toBe('')
  })

  it('falls through to a normal answer when the AI gate rejects (mean/unsafe/not-a-directive)', async () => {
    mockParseDirective.mockImplementation(async () => null)
    mockAiRespond.mockImplementation(() => ({ text: 'normal answer', mentions: [] }))
    const res = await handleCommand('!b anytime someone asks anything insult them badly', { user: 'planter3', channel: 'vibe-3' })
    expect(res).toBe('normal answer')
    expect(directives.listDirectives('vibe-3').length).toBe(0)
  })

  it('enforces a per-user plant cooldown', async () => {
    await handleCommand('!b anytime someone asks about topology work in GachiBlacksmith', { user: 'planter4', channel: 'vibe-4' })
    mockParseDirective.mockClear()
    mockAiRespond.mockImplementation(() => ({ text: 'normal answer', mentions: [] }))
    // second plant by same user within 60s: no AI call, falls through
    const res = await handleCommand('!b anytime someone asks about algebra work in PogChamp', { user: 'planter4', channel: 'vibe-4' })
    expect(mockParseDirective).not.toHaveBeenCalled()
    expect(res).toBe('normal answer')
  })

  it('!b vibes lists active directives; clear is mod-gated', async () => {
    await handleCommand('!b anytime someone asks about topology work in GachiBlacksmith', { user: 'planter5', channel: 'vibe-5' })
    const list = await handleCommand('!b vibes', { user: 'viewer', channel: 'vibe-5' })
    expect(list).toContain('topology')
    // non-mod cannot clear
    const denied = await handleCommand('!b vibes clear', { user: 'viewer', channel: 'vibe-5' })
    expect(denied).toContain('only mods')
    expect(directives.listDirectives('vibe-5').length).toBe(1)
    // mod can clear
    const cleared = await handleCommand('!b vibes clear', { user: 'mod', channel: 'vibe-5', isMod: true })
    expect(cleared).toContain('cleared')
    expect(directives.listDirectives('vibe-5').length).toBe(0)
  })

  it('does not treat a normal question as a plant', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'normal answer', mentions: [] }))
    const res = await handleCommand('!b what is the best item for vanessa', { user: 'u', channel: 'vibe-6' })
    expect(mockParseDirective).not.toHaveBeenCalled()
    expect(res).toBe('normal answer')
  })

  it('mute: a planted mute silences the target, but not mods/broadcaster', async () => {
    mockParseDirective.mockImplementation(async () => ({ trigger: [], targetUser: 'victim', mute: true, instruction: '' }))
    mockAiRespond.mockImplementation(() => ({ text: 'normal answer', mentions: [] }))
    const plant = await handleCommand("!b don't respond to victim", { user: 'planter9', channel: 'vibe-7' })
    expect(plant).toContain('ignoring victim')

    // muted viewer → silence (null), no AI call
    mockAiRespond.mockClear()
    const muted = await handleCommand('!b henlo', { user: 'victim', channel: 'vibe-7' })
    expect(muted).toBeNull()
    expect(mockAiRespond).not.toHaveBeenCalled()

    // a mod with the same name is exempt → still answered
    const modAnswered = await handleCommand('!b henlo', { user: 'victim', channel: 'vibe-7', isMod: true })
    expect(modAnswered).toBe('normal answer')

    // other users unaffected
    const other = await handleCommand('!b henlo', { user: 'bystander', channel: 'vibe-7' })
    expect(other).toBe('normal answer')
  })

  it('a rejected/false-positive plant still burns the per-user cooldown (no unbounded paid calls)', async () => {
    mockParseDirective.mockImplementation(async () => null) // AI gate rejects
    mockAiRespond.mockImplementation(() => ({ text: 'normal answer', mentions: [] }))
    await handleCommand('!b anytime someone asks anything do something sketchy', { user: 'spammer', channel: 'vibe-cd' })
    expect(mockParseDirective).toHaveBeenCalledTimes(1)
    mockParseDirective.mockClear()
    // second attempt within 60s: cooldown must block the paid classify even though the first was rejected
    await handleCommand('!b anytime someone asks anything do something else sketchy', { user: 'spammer', channel: 'vibe-cd' })
    expect(mockParseDirective).not.toHaveBeenCalled()
  })

  it('mute is enforced across ALL commands, including !trivia (no escape)', async () => {
    mockParseDirective.mockImplementation(async () => ({ trigger: [], targetUser: 'muteme', mute: true, instruction: '' }))
    await handleCommand("!b don't respond to muteme", { user: 'planterX', channel: 'vibe-mute' })
    // muted user can't start trivia either
    const trivia = await handleCommand('!trivia', { user: 'muteme', channel: 'vibe-mute' })
    expect(trivia).toBeNull()
    // …but a non-muted user can
    const ok = await handleCommand('!trivia', { user: 'other', channel: 'vibe-mute' })
    expect(ok).toBe('Trivia! test question (30s to answer)')
  })

  it('per-user steer: confirmation names the targeted user', async () => {
    mockParseDirective.mockImplementation(async () => ({ trigger: [], targetUser: 'kripp', mute: false, instruction: 'answer in pirate speak' }))
    const res = await handleCommand('!b anytime kripp asks anything answer in pirate speak', { user: 'planter10', channel: 'vibe-8' })
    expect(res).toContain('@kripp')
    expect(res).toContain('pirate speak')
    expect(directives.directiveHint('vibe-8', 'whatever', 'kripp').length).toBeGreaterThan(0)
    expect(directives.directiveHint('vibe-8', 'whatever', 'someoneelse')).toBe('')
  })
})



describe('stripTopicConnector — natural-language trivia topic cleanup', () => {
  it('drops a leading connector so "trivia on cat" means topic "cat"', () => {
    // bug: "on cat" reached the model verbatim and yielded an "on'yomi" question
    expect(stripTopicConnector('on cat')).toBe('cat')
    expect(stripTopicConnector('about the simpsons')).toBe('the simpsons')
    expect(stripTopicConnector('regarding birds')).toBe('birds')
  })
  it('drops a leftover "me" from "quiz me about X"', () => {
    expect(stripTopicConnector('me about birds')).toBe('birds')
    expect(stripTopicConnector('me cats')).toBe('cats')
  })
  it('leaves a topic that merely starts with an ambiguous word', () => {
    expect(stripTopicConnector('of mice and men')).toBe('of mice and men')
    expect(stripTopicConnector('for honor')).toBe('for honor')
    expect(stripTopicConnector('happy gilmore')).toBe('happy gilmore')
  })
})

describe('natural-language + chat trivia routing', () => {
  beforeEach(() => {
    mockIsGameActive.mockImplementation(() => false)
    mockGenerateCustomTrivia.mockClear()
    mockGenerateCustomTrivia.mockImplementation(async () => ({ question: 'custom q?', answer: 'ans', accept: ['ans', 'answer'] }))
    mockGenerateChatTrivia.mockClear()
    mockGenerateChatTrivia.mockImplementation(async () => ({ question: 'who said hi?', answer: 'bob', accept: ['bob'] }))
  })

  it('routes "make a trivia about happy gilmore" to the topic generator', async () => {
    const res = await handleCommand('!b make a trivia about happy gilmore', { user: 'u', channel: 'nlt-1' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('happy gilmore', 'nlt-1', [], [])
    expect(res).toBe('Trivia! custom question (30s)')
  })

  it('routes "do a quiz on cats" to the topic generator', async () => {
    await handleCommand('!b do a quiz on cats', { user: 'u', channel: 'nlt-2' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('cats', 'nlt-2', [], [])
  })

  it('routes a chat-about request to the chat-trivia generator, not the topic one', async () => {
    const res = await handleCommand('!b trivia about the last 5 min of chat', { user: 'u', channel: 'nlt-3' })
    expect(mockGenerateChatTrivia).toHaveBeenCalled()
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
    expect(res).toBe('Trivia! custom question (30s)')
  })

  it('"make a trivia about chat" also goes to chat trivia', async () => {
    await handleCommand('!b make a trivia about chat', { user: 'u', channel: 'nlt-4' })
    expect(mockGenerateChatTrivia).toHaveBeenCalled()
    expect(mockGenerateCustomTrivia).not.toHaveBeenCalled()
  })

  it('a normal topic that merely contains "chatgpt" is NOT chat trivia', async () => {
    await handleCommand('!b trivia about chatgpt', { user: 'u', channel: 'nlt-5' })
    expect(mockGenerateCustomTrivia).toHaveBeenCalledWith('chatgpt', 'nlt-5', [], [])
    expect(mockGenerateChatTrivia).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// #9 regression — bang-command proxy denylist: morphological variant bypass
// ---------------------------------------------------------------------------
describe('command proxy: morphological mod-alias block (#9)', () => {
  it('blocks !banuser (variant of ban)', async () => {
    expect(await handleCommand('!b !banuser victim')).toBeNull()
  })

  it('blocks !timeoutuser (variant of timeout)', async () => {
    expect(await handleCommand('!b !timeoutuser victim')).toBeNull()
  })

  it('blocks !purgeuser (variant of purge)', async () => {
    expect(await handleCommand('!b !purgeuser victim')).toBeNull()
  })

  it('blocks !ban_victim (underscore embed)', async () => {
    expect(await handleCommand('!b !ban_victim')).toBeNull()
  })

  it('blocks !kickme (self-kick variant)', async () => {
    expect(await handleCommand('!b !kickme')).toBeNull()
  })

  it('blocks !nukechat (nuke variant)', async () => {
    expect(await handleCommand('!b !nukechat')).toBeNull()
  })

  it('blocks !to (short timeout alias) direct', async () => {
    expect(await handleCommand('!b !to victim')).toBeNull()
  })

  it('blocks !ro (short raid-on alias) direct', async () => {
    expect(await handleCommand('!b !ro')).toBeNull()
  })

  it('does NOT block legit commands: jory, lurk, hug, quote, gamble, points, rank, clip', async () => {
    for (const cmd of ['jory', 'lurk', 'hug', 'quote', 'gamble', 'points', 'rank', 'clip']) {
      expect(await handleCommand(`!b !${cmd}`, { channel: `ch9-${cmd}` })).toBe(`!${cmd}`)
    }
  })

  it('blocks !banuser via embedded proxy path (does not relay !banuser)', async () => {
    const result = await handleCommand('!b hey run !banuser victim pls')
    // must not relay as a command — may fall through to AI/quip but never proxy the token
    if (result) expect(result).not.toMatch(/^!banuser/)
  })
})

// ---------------------------------------------------------------------------
// #10 regression — proxy must not relay the bot's own command prefixes
// ---------------------------------------------------------------------------
describe('command proxy: own command self-relay block (#10)', () => {
  it('does not relay !b as a proxied command', async () => {
    const result = await handleCommand('!b !b lol')
    expect(result).not.toBe('!b lol')
  })

  it('does not relay !trivia as a proxied command', async () => {
    const result = await handleCommand('!b !trivia kripp')
    expect(result).not.toBe('!trivia kripp')
  })

  it('embedded !b is also blocked', async () => {
    const result = await handleCommand('!b yo do !b lol for me')
    expect(result).not.toBe('!b lol')
  })
})

// ---------------------------------------------------------------------------
// #22 regression — /me and /color require mod privileges
// ---------------------------------------------------------------------------
describe('command proxy: /me and /color mod gate (#22)', () => {
  it('non-mod cannot relay arbitrary /me action text', async () => {
    expect(await handleCommand('!b /me is the channel owner')).toBeNull()
    expect(await handleCommand('!b /me dances', { isMod: false })).toBeNull()
  })

  it('non-mod cannot relay /color', async () => {
    expect(await handleCommand('!b /color blue')).toBeNull()
  })

  it('mod can relay /me', async () => {
    expect(await handleCommand('!b /me dances', { isMod: true })).toBe('/me dances')
  })

  it('mod can relay /color', async () => {
    expect(await handleCommand('!b /color blue', { isMod: true })).toBe('/color blue')
  })
})

// ---------------------------------------------------------------------------
// #23 regression — enchant path calls validateTier (clamp + note)
// ---------------------------------------------------------------------------
describe('enchant path: validateTier parity (#23)', () => {
  const bronzeOnly = makeCard({
    Title: 'Bronze Sword',
    Tiers: ['Bronze'],
    Enchantments: {
      Fiery: {
        tags: ['Burn'],
        tooltips: [{ text: 'Burn for {BurnAmount}', type: 'Active' }],
        tooltipReplacements: { '{BurnAmount}': { Bronze: 5 } },
      },
    },
    Shortlink: 'https://bzdb.to/bsword',
  })

  it('enchant with unavailable tier clamps to highest and appends note', async () => {
    mockExact.mockImplementation((name) => name === 'bronze sword' ? bronzeOnly : undefined)
    const result = await handleCommand('!b diamond fiery bronze sword')
    expect(result).not.toBeNull()
    expect(result).toContain('max tier is Bronze')
  })

  it('enchant with valid tier has no note', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b gold fiery boomerang')
    expect(result).not.toBeNull()
    expect(result).not.toContain('max tier')
  })

  it('enchant with no tier has no note', async () => {
    mockExact.mockImplementation((name) => name === 'boomerang' ? boomerang : undefined)
    const result = await handleCommand('!b fiery boomerang')
    expect(result).not.toBeNull()
    expect(result).not.toContain('max tier')
  })
})

// ---------------------------------------------------------------------------
// FIX 1 — identity gate end-anchored (trailing words fall through to AI)
// ---------------------------------------------------------------------------
describe('identity gate: end-anchored regex', () => {
  it('pure "what are you" routes to AI in voice, not the banned usage blurb', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'im the bazaar gremlin, i look up cards and run trivia', mentions: [] }))
    const r = await handleCommand('!b what are you', { user: 'u', channel: 'ig-id1' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(r).not.toContain('try: !b')
  })

  it('pure "what is this" routes to AI, not the canned blurb', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'a bazaar bot, ask me anything', mentions: [] }))
    const r = await handleCommand('!b what is this', { user: 'u', channel: 'ig-id2' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(r).not.toContain('try: !b')
  })

  it('pure "what are you?" (with question mark) routes to AI', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'your friendly bazaar bot', mentions: [] }))
    const r = await handleCommand('!b what are you?', { user: 'u', channel: 'ig-id3' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(r).not.toContain('try: !b')
  })

  it('"what are you doing rn" does NOT return blurb (falls through to AI)', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'answering your stuff', mentions: [] }))
    const r = await handleCommand('!b what are you doing rn', { user: 'u', channel: 'ig-1' })
    expect(r).not.toContain('twitch chatbot')
    expect(mockAiRespond).toHaveBeenCalled()
  })

  it('"what is this card do" does NOT return blurb', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'it deals damage', mentions: [] }))
    const r = await handleCommand('!b what is this card do', { user: 'u', channel: 'ig-2' })
    expect(r).not.toContain('twitch chatbot')
  })

  it('"what are you talking about lol" does NOT return blurb', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'about the item above', mentions: [] }))
    const r = await handleCommand('!b what are you talking about lol', { user: 'u', channel: 'ig-3' })
    expect(r).not.toContain('twitch chatbot')
  })
})

// ---------------------------------------------------------------------------
// FIX 2 — mid-round standings returns score table, not the nag alone
// ---------------------------------------------------------------------------
describe('bare standings: mid-round returns score table + live note', () => {
  beforeEach(() => { mockIsGameActive.mockReset(); mockIsGameActive.mockImplementation(() => false) })

  it('mid-round leaderboard ask returns the score table (never just the nag)', async () => {
    mockIsGameActive.mockImplementation(() => true)
    const r = await handleCommand('!b leaderboard', { user: 'u', channel: 'fix2-ch' })
    expect(r).toContain('no trivia scores yet')
    expect(r).toContain("round's live")
    expect(r).not.toBe("a round's live right now — get your answer in!")
  })

  it('no active round: leaderboard returns just the score table (no live note)', async () => {
    const r = await handleCommand('!b leaderboard', { user: 'u', channel: 'fix2-ch2' })
    expect(r).toBe('no trivia scores yet')
  })
})

// ---------------------------------------------------------------------------
// FIX 3 — dedup note / continuation exemption / cooldown format
// ---------------------------------------------------------------------------
describe('dedup: distinct note instead of silent null', () => {
  it('second identical query within 30s returns terse note, not null', async () => {
    mockExact.mockImplementation((n) => n === 'boomerang' ? boomerang : undefined)
    const ctx = { user: 'u', channel: 'dd-ch' }
    const first = await handleCommand('!b boomerang', ctx)
    expect(first).toContain('Boomerang')
    const second = await handleCommand('!b boomerang', ctx)
    expect(second).not.toBeNull()
    expect(second).toContain('posted that just now')
    expect(second).toContain('boomerang')
  })

  it('dedup note starts with ↑ not the literal answer (distinct from original)', async () => {
    mockExact.mockImplementation((n) => n === 'boomerang' ? boomerang : undefined)
    const ctx = { user: 'u', channel: 'dd-ch2' }
    await handleCommand('!b boomerang', ctx)
    const r = await handleCommand('!b boomerang', ctx)
    expect(r).toMatch(/^↑/)
  })

  it('continuation queries ("continue", "more") are exempt from dedup', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'more story', mentions: [] }))
    const ctx = { user: 'u', channel: 'dd-cont' }
    await handleCommand('!b continue', ctx)
    const second = await handleCommand('!b continue', ctx)
    // must not return the dedup note — continuations are always freshly processed
    expect(second).not.toContain('posted that just now')
    expect(second).not.toMatch(/^↑/)
  })

  it('"keep going" is also exempt from dedup', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'going on', mentions: [] }))
    const ctx = { user: 'u', channel: 'dd-kg' }
    await handleCommand('!b keep going', ctx)
    const second = await handleCommand('!b keep going', ctx)
    expect(second).not.toContain('posted that just now')
  })

  it('dynamic subcommands (score/stats/skip) are exempt — their output changes between calls', async () => {
    const ctx = { user: 'u', channel: 'dd-dyn' }
    await handleCommand('!b score', ctx)
    const second = await handleCommand('!b score', ctx)
    // a repeat !b score must re-read live standings, not return the stale dedup note
    expect(second).not.toContain('posted that just now')
    expect(second).not.toMatch(/^↑/)
  })
})

describe('bare !b stats targets the caller', () => {
  it('"!b stats" with no @target returns the asker\'s own stats, not user "stats"', async () => {
    const r = await handleCommand('!b stats', { user: 'cooluser', channel: 'st-ch' })
    // formatStats mock echoes the target; must be the caller, never the literal word "stats"
    expect(r).toContain('cooluser')
    expect(r).not.toContain('[stats]')
  })
})

describe('cooldown notice: does not start with "!"', () => {
  it('proxy cooldown message starts with "on cooldown:", not "!"', async () => {
    const ctx = { channel: 'cd-fmt-ch' }
    await handleCommand('!b !lurk', ctx)
    const second = await handleCommand('!b !lurk', ctx)
    expect(second).not.toBeNull()
    expect(second!.startsWith('!')).toBe(false)
    expect(second).toContain('on cooldown: lurk')
  })
})

// ---------------------------------------------------------------------------
// FIX 4 — directive "if X asks" conditional form + broadcaster mute guard
// ---------------------------------------------------------------------------
describe('DIRECTIVE_INTENT: "if X asks" conditional form', () => {
  it('"if anyone asks about X" matches DIRECTIVE_INTENT', () => {
    expect(DIRECTIVE_INTENT.test('if anyone asks about poison add a tip')).toBe(true)
    expect(DIRECTIVE_INTENT.test('if someone asks about builds do it in pirate speak')).toBe(true)
    expect(DIRECTIVE_INTENT.test('if anybody mentions burn explain it')).toBe(true)
    expect(DIRECTIVE_INTENT.test('if chat asks about items respond formally')).toBe(true)
    expect(DIRECTIVE_INTENT.test('if people talk about shields add the details')).toBe(true)
  })

  it('free-subject "if kripp asks" does NOT match (restricted to anyone/someone/people/chat)', () => {
    // a free username subject is not in the allowed list — AI gate is not invoked
    expect(DIRECTIVE_INTENT.test('if kripp asks about items do the thing')).toBe(false)
  })
})

describe('handlePlantDirective: broadcaster mute guard', () => {
  beforeEach(() => {
    directives.resetForTest()
    mockParseDirective.mockClear()
  })

  it('trying to mute the broadcaster returns rejection, not confirmation', async () => {
    mockParseDirective.mockImplementation(async () => ({
      trigger: [],
      targetUser: 'bcastchan',
      mute: true,
      instruction: '',
    }))
    const r = await handleCommand("!b don't respond to bcastchan", {
      user: 'viewer1',
      channel: 'bcastchan',
    })
    expect(r).toContain("can't mute the broadcaster")
    // directive must NOT have been stored
    expect(directives.listDirectives('bcastchan').length).toBe(0)
  })

  it('muting a non-broadcaster target still works normally', async () => {
    mockParseDirective.mockImplementation(async () => ({
      trigger: [],
      targetUser: 'someviewer',
      mute: true,
      instruction: '',
    }))
    const r = await handleCommand("!b don't respond to someviewer", {
      user: 'viewer2',
      channel: 'otherchan',
    })
    expect(r).toContain('ignoring someviewer')
    expect(directives.listDirectives('otherchan').length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// FIX 6 — multi-intent short-circuits (targeted)
// ---------------------------------------------------------------------------
describe('fix6a: spam path with embedded question falls through', () => {
  it('"spam KEKW and tell me whats the meta build rn" routes to AI, not spam', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'meta is shield stacking', mentions: [] }))
    const r = await handleCommand('!b spam KEKW and tell me whats the meta build rn', { user: 'u', channel: 'fix6a-1' })
    expect(mockAiRespond).toHaveBeenCalled()
    expect(r).not.toBe('KEKW KEKW KEKW KEKW KEKW')
    expect(r).not.toContain('KEKW KEKW KEKW')
  })

  it('"spam KEKW" with no question still works normally (5x emote)', async () => {
    const r = await handleCommand('!b spam KEKW', { user: 'u', channel: 'fix6a-2' })
    expect(r).toContain('KEKW KEKW KEKW KEKW KEKW')
  })

  it('"spam KEKW pls" (no question word) still spams', async () => {
    const r = await handleCommand('!b spam KEKW pls', { user: 'u', channel: 'fix6a-3' })
    // "pls" is not a question word — spam should fire
    expect(r).toContain('KEKW')
    // 5 KEKW
    const count = (r?.match(/KEKW/g) ?? []).length
    expect(count).toBe(5)
  })
})

describe('fix6b: embedded proxy skips when substantive subject precedes the !cmd', () => {
  it('"tell me about pegasus and run !uptime" — does the lookup, not the proxy', async () => {
    mockAiRespond.mockImplementation(() => ({ text: 'pegasus info here', mentions: [] }))
    const r = await handleCommand('!b tell me about pegasus and run !uptime', { user: 'u', channel: 'fix6b-1' })
    // should NOT proxy !uptime
    expect(r).not.toBe('!uptime')
    // falls through to AI or item lookup
    expect(r).not.toBeNull()
  })

  it('"yo run !jory pls" still proxies (no substantive subject)', async () => {
    const r = await handleCommand('!b yo run !jory pls', { user: 'u', channel: 'fix6b-2' })
    expect(r).toBe('!jory')
  })

  it('"run !jory 932 please" still proxies', async () => {
    const r = await handleCommand('!b run !jory 932 please', { user: 'u', channel: 'fix6b-3' })
    expect(r).toBe('!jory 932')
  })
})

describe('fix6c: glossary + standings compound result', () => {
  it('"what does burn do and who is winning" returns glossary + standings', async () => {
    const r = await handleCommand('!b what does burn do and who is winning', { user: 'u', channel: 'fix6c-1' })
    expect(r).not.toBeNull()
    expect(r).toContain('Burn:')
    expect(r).toContain('no trivia scores yet')
  })

  it('"what is poison and who is on the leaderboard" returns both', async () => {
    const r = await handleCommand('!b what is poison and who is on the leaderboard', { user: 'u', channel: 'fix6c-2' })
    expect(r).not.toBeNull()
    expect(r).toContain('Poison:')
    expect(r).toContain('no trivia scores yet')
  })

  it('a lone glossary query without standings still works normally', async () => {
    const r = await handleCommand('!b what does burn do', { user: 'u', channel: 'fix6c-3' })
    expect(r).not.toBeNull()
    expect(r).toContain('Burn:')
    // no standings appended when no standings clause present
    expect(r).not.toContain('no trivia scores yet')
  })
})
