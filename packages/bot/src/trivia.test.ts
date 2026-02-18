import { describe, expect, it, mock, beforeEach } from 'bun:test'
import type { BazaarCard, Monster } from '@bazaarinfo/shared'

// --- fixtures ---
function makeCard(overrides: Partial<BazaarCard> = {}): BazaarCard {
  return {
    Type: 'Item',
    Title: 'Boomerang',
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: ['Bronze', 'Silver', 'Gold'],
    Tooltips: [],
    TooltipReplacements: {},
    DisplayTags: [],
    HiddenTags: [],
    Tags: [],
    Heroes: ['Pygmalien'],
    Enchantments: {},
    Shortlink: 'https://bzdb.to/test',
    ...overrides,
  }
}

// --- test data ---
const sword = makeCard({
  Title: 'Sword', Heroes: ['Vanessa'], HiddenTags: ['Weapon'], Size: 'Small',
  Enchantments: { Fiery: { tooltips: [{ text: 'Burn', type: 'Active' }], tags: ['Burn'] } },
})
const axe = makeCard({
  Title: 'Axe', Heroes: ['Dooley'], HiddenTags: ['Weapon'], Size: 'Large',
  Enchantments: { Heavy: { tooltips: [{ text: 'Slow', type: 'Active' }], tags: ['Slow'] } },
})
const dagger = makeCard({ Title: 'Dagger', Heroes: ['Vanessa'], HiddenTags: ['Weapon', 'Crit'], Size: 'Small' })
const towerShield = makeCard({ Title: 'Tower Shield', Heroes: ['Dooley'], HiddenTags: ['Shield'], Size: 'Large' })
const beetle = makeCard({ Title: 'BLU-B33TL3', Heroes: ['Pygmalien'], HiddenTags: ['Tech'] })
const healSalve = makeCard({ Title: 'Healing Salve', Heroes: ['Stelle'], HiddenTags: ['Heal'] })
const allItems = [sword, axe, dagger, towerShield, beetle, healSalve]

const spider: Monster = {
  Type: 'CombatEncounter', Title: 'BLK-SP1D3R', Size: 'Medium',
  Tags: [], DisplayTags: [], HiddenTags: [], Heroes: [],
  MonsterMetadata: { available: 'Always', day: 3, health: 150, board: [], skills: [] },
  Shortlink: 'https://bzdb.to/spider',
}
const dragon: Monster = {
  Type: 'CombatEncounter', Title: 'Dragon', Size: 'Medium',
  Tags: [], DisplayTags: [], HiddenTags: [], Heroes: [],
  MonsterMetadata: { available: 'Always', day: 7, health: 500, board: [], skills: [] },
  Shortlink: 'https://bzdb.to/dragon',
}
const allMonsters = [spider, dragon]

// --- mocks ---
mock.module('./store', () => ({
  getItems: mock(() => allItems),
  getMonsters: mock(() => allMonsters),
  getHeroNames: mock(() => ['Vanessa', 'Dooley', 'Pygmalien', 'Stelle']),
  getSkills: mock(() => []),
  getAllCards: mock(() => allItems),
  exact: mock(() => undefined),
  search: mock(() => []),
  findMonster: mock(() => undefined),
  findCard: mock(() => undefined),
  byHero: mock(() => []),
  byTag: mock(() => []),
  monstersByDay: mock(() => []),
  findSkill: mock(() => undefined),
  getEnchantments: mock(() => []),
  findHeroName: mock(() => undefined),
  findTagName: mock(() => undefined),
  suggest: mock(() => []),
  getTagNames: mock(() => []),
}))

const mockCreateTriviaGame = mock(() => 1)
const mockRecordTriviaAnswer = mock(() => {})
const mockRecordTriviaWin = mock(() => {})
const mockRecordTriviaAttempt = mock(() => {})
const mockResetTriviaStreak = mock(() => {})
const mockGetOrCreateUser = mock(() => 1)
const mockGetTriviaLeaderboard = mock<() => { username: string; trivia_wins: number }[]>(() => [])
const mockGetUserStats = mock<() => any>(() => null)
const mockGetChannelLeaderboard = mock<() => { username: string; total_commands: number }[]>(() => [])

mock.module('./db', () => ({
  createTriviaGame: mockCreateTriviaGame,
  recordTriviaAnswer: mockRecordTriviaAnswer,
  recordTriviaWin: mockRecordTriviaWin,
  recordTriviaAttempt: mockRecordTriviaAttempt,
  resetTriviaStreak: mockResetTriviaStreak,
  getOrCreateUser: mockGetOrCreateUser,
  getTriviaLeaderboard: mockGetTriviaLeaderboard,
  getUserStats: mockGetUserStats,
  getChannelLeaderboard: mockGetChannelLeaderboard,
  logCommand: mock(() => {}),
}))

mock.module('./log', () => ({
  log: mock(() => {}),
}))

const {
  startTrivia,
  checkAnswer,
  isGameActive,
  getTriviaScore,
  formatStats,
  formatTop,
  setSay,
  matchAnswer,
  looksLikeAnswer,
  resetForTest,
  getActiveGameForTest,
} = await import('./trivia')

const mockSay = mock(() => {})

beforeEach(() => {
  resetForTest()
  mockCreateTriviaGame.mockReset()
  mockRecordTriviaAnswer.mockReset()
  mockRecordTriviaWin.mockReset()
  mockRecordTriviaAttempt.mockReset()
  mockResetTriviaStreak.mockReset()
  mockGetOrCreateUser.mockReset()
  mockGetTriviaLeaderboard.mockReset()
  mockGetUserStats.mockReset()
  mockGetChannelLeaderboard.mockReset()
  mockSay.mockReset()
  mockCreateTriviaGame.mockImplementation(() => 1)
  mockGetOrCreateUser.mockImplementation(() => 1)
  mockGetTriviaLeaderboard.mockImplementation(() => [])
  mockGetUserStats.mockImplementation(() => null)
  mockGetChannelLeaderboard.mockImplementation(() => [])
  setSay(mockSay)
})

// ---------------------------------------------------------------------------
// matchAnswer — fuzzy answer matching
// ---------------------------------------------------------------------------
describe('matchAnswer', () => {
  it('exact match', () => {
    expect(matchAnswer('sword', ['sword'])).toBe(true)
  })

  it('no match', () => {
    expect(matchAnswer('shield', ['sword'])).toBe(false)
  })

  it('startsWith for 5+ chars', () => {
    expect(matchAnswer('tower', ['tower shield'])).toBe(true)
  })

  it('startsWith rejected under 5 chars', () => {
    expect(matchAnswer('tow', ['tower shield'])).toBe(false)
  })

  it('includes for 8+ chars', () => {
    expect(matchAnswer('blu-b33t', ['blu-b33tl3'])).toBe(true)
  })

  it('includes rejected under 8 chars', () => {
    expect(matchAnswer('b33tl3', ['blu-b33tl3'])).toBe(false) // 6 chars
  })

  it('includes catches middle of long name', () => {
    expect(matchAnswer('sp1d3r-x', ['mega-sp1d3r-x99'])).toBe(true)
  })

  it('multiple accepted answers', () => {
    expect(matchAnswer('axe', ['sword', 'axe', 'dagger'])).toBe(true)
  })

  it('day number answers', () => {
    expect(matchAnswer('3', ['3', 'day 3'])).toBe(true)
    expect(matchAnswer('day 3', ['3', 'day 3'])).toBe(true)
  })

  it('no partial match under thresholds', () => {
    expect(matchAnswer('sw', ['sword'])).toBe(false)
    expect(matchAnswer('swor', ['sword'])).toBe(false) // 4 chars, needs 5 for startsWith
  })

  it('5 char exact boundary for startsWith', () => {
    expect(matchAnswer('sword', ['swordfish'])).toBe(true) // 5 chars, startsWith works
    expect(matchAnswer('swor', ['swordfish'])).toBe(false) // 4 chars
  })
})

// ---------------------------------------------------------------------------
// looksLikeAnswer — non-answer filtering
// ---------------------------------------------------------------------------
describe('looksLikeAnswer', () => {
  const game = (overrides = {}) => ({
    acceptedAnswers: ['sword'],
    questionType: 1,
    ...overrides,
  }) as any

  it('filters empty strings', () => {
    expect(looksLikeAnswer('', game())).toBe(false)
  })

  it('filters bot commands', () => {
    expect(looksLikeAnswer('!b boomerang', game())).toBe(false)
  })

  it('filters https URLs', () => {
    expect(looksLikeAnswer('https://twitch.tv/stream', game())).toBe(false)
  })

  it('filters http URLs', () => {
    expect(looksLikeAnswer('http://example.com', game())).toBe(false)
  })

  it('allows normal answers', () => {
    expect(looksLikeAnswer('sword', game())).toBe(true)
  })

  it('filters 1-2 char noise when answers are long', () => {
    expect(looksLikeAnswer('hi', game({ acceptedAnswers: ['boomerang'] }))).toBe(false)
    expect(looksLikeAnswer('lol', game({ acceptedAnswers: ['boomerang'] }))).toBe(true) // 3 chars = ok
  })

  it('allows short input when accepted answers are short', () => {
    expect(looksLikeAnswer('3', game({ acceptedAnswers: ['3', 'day 3'] }))).toBe(true)
  })

  it('allows numeric for day/count questions', () => {
    expect(looksLikeAnswer('7', game({ acceptedAnswers: ['7'] }))).toBe(true)
  })

  it('allows multi-word answers', () => {
    expect(looksLikeAnswer('tower shield', game())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// startTrivia — game lifecycle
// ---------------------------------------------------------------------------
describe('startTrivia', () => {
  it('starts and returns question', () => {
    const result = startTrivia('#test')
    expect(result).toStartWith('Trivia!')
    expect(result).toContain('(30s to answer)')
    expect(isGameActive('#test')).toBe(true)
  })

  it('prevents double start', () => {
    startTrivia('#test')
    const result = startTrivia('#test')
    expect(result).toContain('trivia already active')
    expect(result).toMatch(/\d+s left/)
  })

  it('enforces cooldown', () => {
    startTrivia('#test')
    const game = getActiveGameForTest('#test')!
    checkAnswer('#test', 'winner', game.acceptedAnswers[0], mockSay)
    const result = startTrivia('#test')
    expect(result).toContain('trivia on cooldown')
  })

  it('creates db game record', () => {
    startTrivia('#test')
    expect(mockCreateTriviaGame).toHaveBeenCalledTimes(1)
  })

  it('items category generates item types', () => {
    const types = new Set<number>()
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game) types.add(game.questionType)
    }
    for (const t of types) {
      expect([3, 5, 6]).toContain(t) // tag, size, enchantment
    }
  })

  it('heroes category generates hero types', () => {
    const types = new Set<number>()
    for (let i = 0; i < 30; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'heroes')
      const game = getActiveGameForTest('#test')
      if (game) types.add(game.questionType)
    }
    for (const t of types) {
      expect([1, 4]).toContain(t) // type 1 = hero, type 4 = hero count
    }
  })

  it('monsters category generates monster types', () => {
    const types = new Set<number>()
    for (let i = 0; i < 20; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game) types.add(game.questionType)
    }
    for (const t of types) {
      expect([2, 7]).toContain(t) // monster day, monster HP
    }
  })

  it('no category hits multiple different types across 100 rounds', () => {
    const types = new Set<number>()
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test')
      const game = getActiveGameForTest('#test')
      if (game) types.add(game.questionType)
    }
    expect(types.size).toBeGreaterThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// checkAnswer — answer processing
// ---------------------------------------------------------------------------
describe('checkAnswer', () => {
  beforeEach(() => {
    startTrivia('#test')
  })

  it('correct answer ends game', () => {
    const game = getActiveGameForTest('#test')!
    checkAnswer('#test', 'player1', game.acceptedAnswers[0], mockSay)
    expect(isGameActive('#test')).toBe(false)
    expect(mockSay).toHaveBeenCalledTimes(1)
  })

  it('correct answer shows winner and time', () => {
    const game = getActiveGameForTest('#test')!
    checkAnswer('#test', 'player1', game.acceptedAnswers[0], mockSay)
    const msg = mockSay.mock.calls[0][1]
    expect(msg).toContain('player1')
    expect(msg).toContain('got it in')
    expect(msg).toContain(game.correctAnswer)
  })

  it('wrong answer keeps game active', () => {
    checkAnswer('#test', 'player1', 'totally wrong answer here', mockSay)
    expect(isGameActive('#test')).toBe(true)
    expect(mockSay).not.toHaveBeenCalled()
  })

  it('wrong answer resets streak', () => {
    checkAnswer('#test', 'player1', 'totally wrong answer here', mockSay)
    expect(mockResetTriviaStreak).toHaveBeenCalled()
  })

  it('correct answer records win', () => {
    const game = getActiveGameForTest('#test')!
    checkAnswer('#test', 'player1', game.acceptedAnswers[0], mockSay)
    expect(mockRecordTriviaWin).toHaveBeenCalledTimes(1)
  })

  it('records attempt for real answers', () => {
    checkAnswer('#test', 'player1', 'some real answer', mockSay)
    expect(mockRecordTriviaAttempt).toHaveBeenCalledTimes(1)
  })

  it('does NOT record attempt for bot commands', () => {
    checkAnswer('#test', 'player1', '!b boomerang', mockSay)
    expect(mockRecordTriviaAttempt).not.toHaveBeenCalled()
  })

  it('does NOT record attempt for URLs', () => {
    checkAnswer('#test', 'player1', 'https://twitch.tv', mockSay)
    expect(mockRecordTriviaAttempt).not.toHaveBeenCalled()
  })

  it('does NOT reset streak for non-answer noise', () => {
    checkAnswer('#test', 'player1', '!b help', mockSay)
    expect(mockResetTriviaStreak).not.toHaveBeenCalled()
  })

  it('tracks participants', () => {
    checkAnswer('#test', 'player1', 'guess one here', mockSay)
    checkAnswer('#test', 'player2', 'guess two here', mockSay)
    const game = getActiveGameForTest('#test')
    expect(game?.participants.size).toBe(2)
  })

  it('ignores messages with no active game', () => {
    resetForTest()
    checkAnswer('#test', 'player1', 'random message', mockSay)
    expect(mockRecordTriviaAttempt).not.toHaveBeenCalled()
  })

  it('case insensitive', () => {
    const game = getActiveGameForTest('#test')!
    checkAnswer('#test', 'player1', game.acceptedAnswers[0].toUpperCase(), mockSay)
    expect(isGameActive('#test')).toBe(false)
  })

  it('strips punctuation', () => {
    const game = getActiveGameForTest('#test')!
    checkAnswer('#test', 'player1', `${game.acceptedAnswers[0]}!!!`, mockSay)
    expect(isGameActive('#test')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hero question (type 1)
// ---------------------------------------------------------------------------
describe('hero question (type 1)', () => {
  it('generates valid hero question', () => {
    let found = false
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'heroes')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 1) {
        expect(game.question).toContain('What hero uses')
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// monster day question (type 2)
// ---------------------------------------------------------------------------
describe('monster day question (type 2)', () => {
  it('generates valid monster day question', () => {
    let found = false
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 2) {
        expect(game.question).toContain('What day does')
        expect(game.question).toContain('appear')
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// tag question (type 3)
// ---------------------------------------------------------------------------
describe('tag question (type 3)', () => {
  it('generates valid tag question', () => {
    let found = false
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 3) {
        expect(game.question).toContain('Name an item with the')
        expect(game.question).toContain('tag')
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hero count question (type 4)
// ---------------------------------------------------------------------------
describe('hero count question (type 4)', () => {
  it('generates valid question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'heroes')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 4) {
        expect(game.question).toContain('How many items does')
        expect(game.correctAnswer).toMatch(/^\d+$/)
        expect(matchAnswer(game.correctAnswer, game.acceptedAnswers)).toBe(true)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// size question (type 5)
// ---------------------------------------------------------------------------
describe('size question (type 5)', () => {
  it('generates valid size question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 5) {
        expect(game.question).toContain('What size is')
        expect(['small', 'medium', 'large']).toContain(game.acceptedAnswers[0])
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('accepts abbreviations', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 5) {
        const abbrev: Record<string, string> = { small: 's', medium: 'm', large: 'l' }
        expect(matchAnswer(abbrev[game.acceptedAnswers[0]], game.acceptedAnswers)).toBe(true)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// enchantment question (type 6)
// ---------------------------------------------------------------------------
describe('enchantment question (type 6)', () => {
  it('generates valid enchantment question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 6) {
        expect(game.question).toContain('Name an enchantment for')
        expect(game.acceptedAnswers.length).toBeGreaterThan(0)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// monster HP question (type 7)
// ---------------------------------------------------------------------------
describe('monster HP question (type 7)', () => {
  it('generates valid HP question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 7) {
        expect(game.question).toContain('How much HP does')
        expect(game.correctAnswer).toMatch(/\d+ HP/)
        expect(matchAnswer(game.acceptedAnswers[0], game.acceptedAnswers)).toBe(true)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stylized names
// ---------------------------------------------------------------------------
describe('stylized name matching', () => {
  it('BLU-B prefix (5 chars)', () => {
    expect(matchAnswer('blu-b', ['blu-b33tl3'])).toBe(true)
  })

  it('BLK-SP1D partial (8 chars)', () => {
    expect(matchAnswer('blk-sp1d', ['blk-sp1d3r'])).toBe(true)
  })

  it('rejects under 5 chars', () => {
    expect(matchAnswer('blu', ['blu-b33tl3'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getTriviaScore
// ---------------------------------------------------------------------------
describe('getTriviaScore', () => {
  it('empty = no scores message', () => {
    expect(getTriviaScore('#test')).toBe('no trivia scores yet')
  })

  it('formats leaderboard', () => {
    mockGetTriviaLeaderboard.mockImplementation(() => [
      { username: 'alice', trivia_wins: 10 },
      { username: 'bob', trivia_wins: 5 },
    ])
    const result = getTriviaScore('#test')
    expect(result).toContain('1. alice (10 wins)')
    expect(result).toContain('2. bob (5 wins)')
  })
})

// ---------------------------------------------------------------------------
// formatStats
// ---------------------------------------------------------------------------
describe('formatStats', () => {
  it('unknown user', () => {
    expect(formatStats('nobody')).toBe('no stats for nobody')
  })

  it('full stats', () => {
    mockGetUserStats.mockImplementation(() => ({
      username: 'alice', total_commands: 42,
      trivia_wins: 5, trivia_attempts: 10,
      trivia_streak: 2, trivia_best_streak: 3,
      trivia_fastest_ms: 2500,      first_seen: '2025-01-15T00:00:00Z',
      favorite_item: 'Boomerang',
    }))
    const r = formatStats('alice')
    expect(r).toContain('[alice]')
    expect(r).toContain('cmds:42')
    expect(r).toContain('trivia:5W/10A (50%)')
    expect(r).toContain('streak:3')
    expect(r).toContain('fastest:2.5s')
    expect(r).toContain('fav:Boomerang')
    expect(r).toContain('since:2025-01-15')
  })

  it('omits trivia when no wins', () => {
    mockGetUserStats.mockImplementation(() => ({
      username: 'bob', total_commands: 5,
      trivia_wins: 0, trivia_attempts: 0,
      trivia_streak: 0, trivia_best_streak: 0,
      trivia_fastest_ms: null,      first_seen: '2025-06-01T00:00:00Z',
      favorite_item: null,
    }))
    const r = formatStats('bob')
    expect(r).not.toContain('trivia:')
    expect(r).not.toContain('streak:')
  })
})

// ---------------------------------------------------------------------------
// formatTop
// ---------------------------------------------------------------------------
describe('formatTop', () => {
  it('empty = no activity', () => {
    expect(formatTop('#test')).toBe('no activity yet')
  })

  it('formats channel leaderboard', () => {
    mockGetChannelLeaderboard.mockImplementation(() => [
      { username: 'alice', total_commands: 100 },
      { username: 'bob', total_commands: 50 },
    ])
    const r = formatTop('#test')
    expect(r).toContain('1. alice (100)')
    expect(r).toContain('2. bob (50)')
  })
})

// ---------------------------------------------------------------------------
// question variety
// ---------------------------------------------------------------------------
describe('question variety', () => {
  it('hits multiple types, not stuck on one', () => {
    const types: number[] = []
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test')
      const game = getActiveGameForTest('#test')
      if (game) types.push(game.questionType)
    }
    expect(new Set(types).size).toBeGreaterThan(3)
  })
})
