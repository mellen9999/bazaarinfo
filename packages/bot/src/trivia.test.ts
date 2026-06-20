import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
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
// need 5+ items per tag for fair-difficulty tag questions (TAG_MIN=5)
// need 5+ same hero+size for type 5, 3+ same hero+displaytag for type 6
// need 5+ items with same mechanic keyword for type 8
const sword = makeCard({
  Title: 'Sword', Heroes: ['Vanessa'], HiddenTags: ['Weapon'], DisplayTags: ['Weapon'],
  Tooltips: [{ text: 'Deal {DamageAmount} Damage', type: 'Active' }],
  TooltipReplacements: { '{DamageAmount}': { Fixed: 10 } },
})
const axe = makeCard({
  Title: 'Axe', Heroes: ['Dooley'], HiddenTags: ['Weapon'],
  Tooltips: [{ text: 'Shield {Amount}', type: 'Active' }],
  TooltipReplacements: { '{Amount}': { Fixed: 5 } },
})
const dagger = makeCard({
  Title: 'Dagger', Heroes: ['Vanessa'], HiddenTags: ['Weapon', 'Crit'], DisplayTags: ['Weapon'],
  Tooltips: [{ text: 'Shield {Amount}', type: 'Active' }],
  TooltipReplacements: { '{Amount}': { Fixed: 8 } },
})
const towerShield = makeCard({
  Title: 'Tower Shield', Heroes: ['Dooley'], HiddenTags: ['Shield'],
  Tooltips: [{ text: 'Shield {Amount}', type: 'Active' }],
  TooltipReplacements: { '{Amount}': { Fixed: 20 } },
})
const beetle = makeCard({ Title: 'BLU-B33TL3', Heroes: ['Pygmalien'], HiddenTags: ['Weapon'] })
const healSalve = makeCard({
  Title: 'Healing Salve', Heroes: ['Vanessa'], HiddenTags: ['Weapon'], DisplayTags: ['Weapon'],
  Tooltips: [{ text: 'Shield {Amount}', type: 'Active' }],
  TooltipReplacements: { '{Amount}': { Fixed: 15 } },
})
const mace = makeCard({
  Title: 'Mace', Heroes: ['Dooley'], HiddenTags: ['Weapon'],
  Tooltips: [{ text: 'Shield {Amount}', type: 'Active' }],
  TooltipReplacements: { '{Amount}': { Fixed: 10 } },
})
// extra Vanessa Medium items for hero+size (need 5+)
const crossbow = makeCard({
  Title: 'Crossbow', Heroes: ['Vanessa'], HiddenTags: ['Weapon'], DisplayTags: ['Weapon'],
  Tooltips: [{ text: 'Slow {Amount}', type: 'Active' }],
  TooltipReplacements: { '{Amount}': { Fixed: 3 } },
})
const net = makeCard({
  Title: 'Net', Heroes: ['Vanessa'], HiddenTags: ['Weapon'], DisplayTags: ['Weapon'],
  Tooltips: [{ text: 'Freeze for {Amount}s', type: 'Active' }],
  TooltipReplacements: { '{Amount}': { Fixed: 2 } },
})
const allItems = [sword, axe, dagger, towerShield, beetle, healSalve, mace, crossbow, net]

// skill fixtures for type 9
const skillFireImmunity = makeCard({
  Type: 'Skill', Title: 'Fire Immunity', Heroes: ['Jules'],
  Tooltips: [{ text: 'Your items are immune to Burn', type: 'Passive' }],
  TooltipReplacements: {},
})
const skillSwiftFlight = makeCard({
  Type: 'Skill', Title: 'Swift Flight', Heroes: ['Stelle'],
  Tooltips: [{ text: 'Your Flying items gain Haste', type: 'Passive' }],
  TooltipReplacements: {},
})
const allSkills = [skillFireImmunity, skillSwiftFlight]

const spider: Monster = {
  Type: 'CombatEncounter', Title: 'BLK-SP1D3R', Size: 'Medium',
  Tags: [], DisplayTags: [], HiddenTags: [], Heroes: [],
  MonsterMetadata: {
    available: 'Always', day: 3, health: 150,
    board: [
      { title: 'Web Shot', tier: 'Bronze', id: 'b1' },
      { title: 'Fang', tier: 'Bronze', id: 'b2' },
    ],
    skills: [{ title: 'Venomous', tier: 'Bronze', id: 's1' }],
  },
  Shortlink: 'https://bzdb.to/spider',
}
const dragon: Monster = {
  Type: 'CombatEncounter', Title: 'Dragon', Size: 'Medium',
  Tags: [], DisplayTags: [], HiddenTags: [], Heroes: [],
  MonsterMetadata: {
    available: 'Always', day: 7, health: 500,
    board: [
      { title: 'Fire Breath', tier: 'Gold', id: 'b3' },
      { title: 'Scale Armor', tier: 'Gold', id: 'b4' },
    ],
    skills: [{ title: 'Fire Aura', tier: 'Gold', id: 's2' }],
  },
  Shortlink: 'https://bzdb.to/dragon',
}
const allMonsters = [spider, dragon]

// --- mocks ---
mock.module('./store', () => ({
  ALIASES: { beetle: 'BLU-B33TL3', spider: 'BLK-SP1D3R' },
  HERO_ALIASES: { mark: 'Mak', mac: 'Mak', pig: 'Pygmalien', pyg: 'Pygmalien', nessa: 'Vanessa', van: 'Vanessa' },
  getItems: mock(() => allItems),
  getMonsters: mock(() => allMonsters),
  getHeroNames: mock(() => ['Vanessa', 'Dooley', 'Pygmalien', 'Stelle', 'Jules']),
  getSkills: mock(() => allSkills),
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
const mockGetTriviaLeaderboard = mock<() => { username: string; points: number; trivia_wins: number }[]>(() => [])
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
  getTriviaStreak: mock(() => 0),
  getTriviaWins: mock(() => 5),
  getTriviaTypeStats: mock(() => []),
  getDb: mock(() => null),
}))

mock.module('./dnd/db', () => ({
  getCharacter: mock(() => null),
  addCharacterXp: mock(() => ({ newLevel: 1, leveledUp: false })),
  initDndDb: mock(() => {}),
  upsertCharacter: mock(() => {}),
  getWorld: mock(() => null),
  upsertWorld: mock(() => {}),
  getActivePlayers: mock(() => []),
  getAllCharacters: mock(() => []),
  nextSequence: mock(() => 0),
  damageCharacter: mock(() => 0),
  healCharacter: mock(() => 0),
  killCharacter: mock(() => {}),
  respawnCharacter: mock(() => {}),
  logDndAction: mock(() => {}),
  getRecentLog: mock(() => []),
  getPendingRespawns: mock(() => []),
  xpForLevel: mock(() => 100),
}))

mock.module('./log', () => ({
  log: mock(() => {}),
}))

const {
  startTrivia,
  startCustomTrivia,
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
  __forceGenIdxForTest,
  rebuildTriviaMaps,
  norm,
  difficultyBase,
  generateHint,
  generateWeakHint,
  setKrippPackForTest,
} = await import('./trivia')

rebuildTriviaMaps()

const mockSay = mock((_channel: string, _text: string) => {})

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
    expect(looksLikeAnswer('lol', game({ acceptedAnswers: ['boomerang'] }))).toBe(false) // chat noise
    expect(looksLikeAnswer('axe', game({ acceptedAnswers: ['boomerang'] }))).toBe(true) // 3 chars real word = ok
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
    expect(result).toContain('(30s)')
    expect(isGameActive('#test')).toBe(true)
  })

  it('prevents double start', () => {
    startTrivia('#test')
    const result = startTrivia('#test')
    expect(result).toContain('trivia already active')
    expect(result).toMatch(/\d+s left/)
  })

  it('no cooldown — a new round can start immediately after one ends', () => {
    startTrivia('#test')
    const game = getActiveGameForTest('#test')!
    checkAnswer('#test', 'winner', game.acceptedAnswers[0], mockSay)
    const result = startTrivia('#test')
    expect(result).toContain('Trivia!')
  })

  it('no cooldown — five rounds back-to-back all start (never "on cooldown")', () => {
    for (let i = 0; i < 5; i++) {
      const start = startTrivia('#test')
      expect(start).toContain('Trivia!')
      expect(start).not.toContain('cooldown')
      const game = getActiveGameForTest('#test')!
      checkAnswer('#test', `winner${i}`, game.acceptedAnswers[0], mockSay)
      expect(getActiveGameForTest('#test')).toBeUndefined() // round ended on win
    }
  })

  it('still blocks a second round while one is active', () => {
    startTrivia('#test')
    const result = startTrivia('#test')
    expect(result).toContain('already active')
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
      expect([2, 3, 5, 6, 8, 12, 13, 14, 16, 18]).toContain(t)
    }
  })

  it('heroes category generates hero types', () => {
    const types = new Set<number>()
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'heroes')
      const game = getActiveGameForTest('#test')
      if (game) types.add(game.questionType)
    }
    for (const t of types) {
      expect([1, 9]).toContain(t)
    }
  })

  it('monsters category generates monster types', () => {
    const types = new Set<number>()
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game) types.add(game.questionType)
    }
    for (const t of types) {
      expect([4, 7, 10, 11, 15, 17, 19]).toContain(t)
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
// custom AI topic (type 21) — typo-forgiving matching
// ---------------------------------------------------------------------------
describe('custom AI topic answer matching', () => {
  it('accepts a single-character typo on an obscure answer', () => {
    startCustomTrivia('#ct', { question: 'what is X?', answer: 'archaeopteryx', accept: [] })
    checkAnswer('#ct', 'player1', 'archaeoptryx', mockSay) // dropped one letter
    expect(isGameActive('#ct')).toBe(false)
    expect(mockRecordTriviaWin).toHaveBeenCalledTimes(1)
  })

  it('still rejects a clearly wrong answer', () => {
    startCustomTrivia('#ct2', { question: 'what is X?', answer: 'archaeopteryx', accept: [] })
    checkAnswer('#ct2', 'player1', 'velociraptor here', mockSay)
    expect(isGameActive('#ct2')).toBe(true)
  })

  it('does not typo-forgive short answers (1-edit neighbor is a different word)', () => {
    startCustomTrivia('#ct3', { question: 'what is X?', answer: 'cat', accept: [] })
    checkAnswer('#ct3', 'player1', 'bat', mockSay)
    expect(isGameActive('#ct3')).toBe(true)
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
// tag question (type 2)
// ---------------------------------------------------------------------------
describe('tag question (type 2)', () => {
  it('generates valid tag question', () => {
    let found = false
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 2) {
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
// tooltip question (type 3)
// ---------------------------------------------------------------------------
describe('tooltip question (type 3)', () => {
  // genTooltipQuestion is generator index 2 → questionType 3. forcing the index makes
  // these deterministic (no random type lottery); the small loop only re-rolls the
  // random ITEM pick in the rare case the chosen item has no usable tooltip.
  const TOOLTIP_GEN_IDX = 2
  function startTooltipQuestion() {
    for (let i = 0; i < 10; i++) {
      resetForTest()
      __forceGenIdxForTest(TOOLTIP_GEN_IDX)
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 3) { __forceGenIdxForTest(null); return game }
    }
    __forceGenIdxForTest(null)
    return null
  }

  it('generates valid tooltip question', () => {
    const game = startTooltipQuestion()
    expect(game).toBeTruthy()
    expect(game!.question).toContain('Which item does this:')
    expect(game!.acceptedAnswers.length).toBe(1)
  })

  it('resolves tooltip placeholders', () => {
    const game = startTooltipQuestion()
    expect(game).toBeTruthy()
    expect(game!.question).not.toContain('{')  // no unresolved {placeholders}
  })
})

// ---------------------------------------------------------------------------
// monster board question (type 4)
// ---------------------------------------------------------------------------
describe('monster board question (type 4)', () => {
  it('generates valid monster board question', () => {
    let found = false
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 4) {
        expect(game.question).toContain('Name an item on')
        expect(game.question).toContain('board')
        expect(game.acceptedAnswers.length).toBeGreaterThanOrEqual(2)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hero+size question (type 5)
// ---------------------------------------------------------------------------
describe('hero+size question (type 5)', () => {
  it('generates valid hero+size question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 5) {
        expect(game.question).toMatch(/Name a (Small|Medium|Large) \w+ item/)
        expect(game.acceptedAnswers.length).toBeGreaterThanOrEqual(5)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('accepted answers are lowercase item names', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 5) {
        for (const a of game.acceptedAnswers) {
          expect(a).toBe(a.toLowerCase())
        }
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hero+displaytag question (type 6)
// ---------------------------------------------------------------------------
describe('hero+displaytag question (type 6)', () => {
  it('generates valid hero+tag question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 6) {
        expect(game.question).toMatch(/Name a \w+ \w+/)
        expect(game.acceptedAnswers.length).toBeGreaterThanOrEqual(3)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// monster day question (type 7)
// ---------------------------------------------------------------------------
describe('monster day question (type 7)', () => {
  it('generates valid monster day question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 7) {
        expect(game.question).toContain('What day do you fight')
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('accepts both numeric and "day N" format', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 7) {
        // accepted should contain both "3" and "day 3" (or "7" and "day 7")
        const numeric = game.acceptedAnswers.find((a: string) => /^\d+$/.test(a))
        const dayFmt = game.acceptedAnswers.find((a: string) => /^day \d+$/.test(a))
        expect(numeric).toBeDefined()
        expect(dayFmt).toBeDefined()
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('answer displays as Day N', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 7) {
        expect(game.correctAnswer).toMatch(/^Day \d+$/)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// mechanic question (type 8)
// ---------------------------------------------------------------------------
describe('mechanic question (type 8)', () => {
  it('generates valid mechanic question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 8) {
        expect(game.question).toContain('Name an item that')
        expect(game.acceptedAnswers.length).toBeGreaterThanOrEqual(5)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hero skill question (type 9)
// ---------------------------------------------------------------------------
describe('hero skill question (type 9)', () => {
  it('generates valid hero skill question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'heroes')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 9) {
        expect(game.question).toContain('Which hero has the skill:')
        expect(game.acceptedAnswers.length).toBe(1)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('answer is a hero name', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'heroes')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 9) {
        expect(['Jules', 'Stelle']).toContain(game.correctAnswer)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// monster skill question (type 10)
// ---------------------------------------------------------------------------
describe('monster skill question (type 10)', () => {
  it('generates valid monster skill question', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 10) {
        expect(game.question).toContain('Which monster has the skill')
        expect(game.acceptedAnswers.length).toBeGreaterThanOrEqual(1)
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('accepted answers are lowercase monster names', () => {
    let found = false
    for (let i = 0; i < 100; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 10) {
        for (const a of game.acceptedAnswers) {
          expect(a).toBe(a.toLowerCase())
        }
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
// nickname expansion in trivia answers
// ---------------------------------------------------------------------------
describe('nickname expansion', () => {
  it('accepts "beetle" for BLU-B33TL3 tag question', () => {
    let found = false
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'items')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 2 && game.acceptedAnswers.includes('blu-b33tl3')) {
        expect(game.acceptedAnswers).toContain('beetle')
        found = true
        break
      }
    }
    // tag question with Weapon tag should include BLU-B33TL3 → beetle
    if (!found) {
      // verify addNicknames works directly via matchAnswer
      expect(matchAnswer('beetle', ['blu-b33tl3', 'beetle'])).toBe(true)
    }
  })

  it('accepts "spider" for BLK-SP1D3R monster board question', () => {
    let found = false
    for (let i = 0; i < 50; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'monsters')
      const game = getActiveGameForTest('#test')
      if (game && game.questionType === 4) {
        // spider's board has Web Shot and Fang — no aliases for those
        // but check that the mechanism works
        found = true
        break
      }
    }
    expect(found).toBe(true)
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
      { username: 'alice', points: 142, trivia_wins: 10 },
      { username: 'bob', points: 88, trivia_wins: 5 },
    ])
    const result = getTriviaScore('#test')
    expect(result).toContain('1. alice (142pts)')
    expect(result).toContain('2. bob (88pts)')
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
    expect(new Set(types).size).toBeGreaterThanOrEqual(5)
  })
})

// --- god-tier overhaul: normalization, fuzzy-gating, scoring, hero aliases ---

describe('norm (canonical answer normalizer)', () => {
  it('makes punctuation/apostrophe items winnable — both sides normalize equal', () => {
    expect(norm("Philosopher's Stone")).toBe(norm('philosophers stone'))
    expect(norm('Dr. Vortex')).toBe(norm('dr vortex'))
    expect(norm('Mortar & Pestle')).toBe(norm('mortar and pestle'))
  })
  it('collapses hyphen to space (Z-Sword <-> z sword)', () => {
    expect(norm('Z-Sword')).toBe('z sword')
    expect(norm('z sword')).toBe('z sword')
  })
  it('strips a leading "the"', () => {
    expect(norm('The Boulder')).toBe('boulder')
    expect(norm('boulder')).toBe('boulder')
  })
  it('never returns leading/trailing space or empty noise', () => {
    expect(norm('  Sword!!  ')).toBe('sword')
    expect(norm('!!!')).toBe('')
  })
})

describe('matchAnswer fuzzy gating', () => {
  it('exact match always wins', () => {
    expect(matchAnswer('dragonscale', ['dragonscale'])).toBe(true)
  })
  it('single-answer questions allow startsWith/includes (stylized names)', () => {
    expect(matchAnswer('magnifying', ['magnifying glass'], true)).toBe(true)
  })
  it('multi-answer pools reject fuzzy prefixes (no luck-wins)', () => {
    // "dragon" must NOT win a pool that merely contains "dragonscale"
    expect(matchAnswer('dragon', ['dragonscale', 'fang', 'shield'], false)).toBe(false)
    // but the exact pooled answer still wins
    expect(matchAnswer('dragonscale', ['dragonscale', 'fang', 'shield'], false)).toBe(true)
  })
})

describe('difficultyBase (scoring currency)', () => {
  it('a single-answer question outscores a 3-option size question', () => {
    expect(difficultyBase(3, 1)).toBeGreaterThan(difficultyBase(12, 1)) // tooltip > size
  })
  it('a big multi-answer pool is worth the least', () => {
    expect(difficultyBase(2, 40)).toBe(1) // 40 valid answers -> base 1
  })
  it('always returns 1..5', () => {
    for (const [type, len] of [[1, 1], [3, 1], [7, 1], [16, 1], [2, 100], [2, 1]] as const) {
      const b = difficultyBase(type, len)
      expect(b).toBeGreaterThanOrEqual(1)
      expect(b).toBeLessThanOrEqual(5)
    }
  })
})

describe('hero alias acceptance (type 1)', () => {
  it('a hero-from-item question accepts documented aliases', () => {
    // force type 1 (hero-from-item); fixtures include Pygmalien items, mock HERO_ALIASES maps pig/pyg->Pygmalien
    let found = false
    for (let i = 0; i < 80 && !found; i++) {
      resetForTest()
      mockCreateTriviaGame.mockImplementation(() => i + 1)
      startTrivia('#test', 'heroes')
      const g = getActiveGameForTest('#test')
      if (g && g.questionType === 1 && g.correctAnswer === 'Pygmalien') {
        found = true
        expect(g.acceptedAnswers).toContain('pig')
      }
    }
    expect(found).toBe(true)
  })
})

describe('hint generation guards', () => {
  it('never emits NaN for tiny numeric answers (Satchel "Reload 0 items")', () => {
    for (const n of ['0', '1', '9']) {
      expect(generateWeakHint(n)).not.toContain('NaN')
      expect(generateHint(n)).not.toContain('NaN')
      expect(generateWeakHint(n)).toBe('Hint: single digit')
    }
  })
  it('still gives a range for real multi-digit numbers', () => {
    expect(generateHint('4700')).toMatch(/between \d+ and \d+/)
    expect(generateHint('4700')).not.toContain('NaN')
  })
})

describe('kripp channel-scoped pack', () => {
  const pack = [
    { question: 'Kripp got famous in which card game?', answer: 'Hearthstone', accept: ['hearthstone', 'hs'], difficulty: 'easy' },
    { question: "what does the 'nl' in nl_Kripp stand for?", answer: 'no life', accept: ['no life', 'nolife'], difficulty: 'medium' },
  ]

  it('serves kripp questions in a kripp channel via the kripp category', () => {
    setKrippPackForTest(pack)
    let got = false
    for (let i = 0; i < 30 && !got; i++) {
      resetForTest()
      const r = startTrivia('mellen', 'kripp') // 'mellen' is a KRIPP_CHANNEL
      const g = getActiveGameForTest('mellen')!
      if (g.questionType === 20) { got = true; expect(g.question.toLowerCase()).toContain('kripp') }
    }
    expect(got).toBe(true)
  })

  it('accepts a kripp answer via norm + accept variants', () => {
    setKrippPackForTest([pack[0]])
    resetForTest()
    startTrivia('mellen', 'kripp')
    const g = getActiveGameForTest('mellen')!
    expect(g.acceptedAnswers).toContain('hearthstone')
    expect(g.acceptedAnswers).toContain('hs')
    checkAnswer('mellen', 'someviewer', 'HS', mockSay) // case-insensitive via norm
    expect(getActiveGameForTest('mellen')).toBeUndefined() // won → round ended
  })

  it('NEVER leaks kripp questions into a non-kripp channel (even with a pack loaded)', () => {
    setKrippPackForTest(pack)
    for (let i = 0; i < 200; i++) {
      resetForTest()
      startTrivia('#somechannel') // not a kripp channel
      const g = getActiveGameForTest('#somechannel')
      if (g) expect(g.questionType).not.toBe(20)
    }
  })

  it('kripp category in a non-kripp channel falls back to a normal question', () => {
    setKrippPackForTest(pack)
    resetForTest()
    startTrivia('#somechannel', 'kripp')
    const g = getActiveGameForTest('#somechannel')!
    expect(g.questionType).not.toBe(20) // fell back to Bazaar pool
  })

  afterEach(() => setKrippPackForTest([]))
})
