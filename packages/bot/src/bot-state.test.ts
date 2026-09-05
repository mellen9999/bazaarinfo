import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'

// db is sqlite-backed at import time via trivia — mock it out (same approach as the
// other suites that pull trivia in).
// shadow only the write paths trivia touches; keep every other db export real so
// transitive imports (ai-cache/ai-http/dungeon) don't hit missing-export errors.
import * as realDb from './db'
mock.module('./db', () => ({
  ...realDb,
  createTriviaGame: mock(() => 1),
  recordTriviaAnswer: mock(() => {}),
  recordTriviaWin: mock(() => {}),
  recordTriviaAttempt: mock(() => {}),
  resetTriviaStreak: mock(() => {}),
  logChat: mock(() => {}),
  logCommand: mock(() => {}),
  getTriviaTypeStats: mock(() => []),
  getOrCreateUser: mock(() => 1),
}))

mock.module('./log', () => ({ log: mock(() => {}) }))

const { SELF_STATE_RE, botStateReport, registerStateProvider, resetProvidersForTest } = await import('./bot-state')
const { addDirective, resetForTest: resetDirectives } = await import('./directives')
const { suppress, resetForTest: resetSuppress } = await import('./suppress')
const { startTrivia, rebuildTriviaMaps, resetForTest: resetTrivia, getActiveGameForTest } = await import('./trivia')

rebuildTriviaMaps()

describe('SELF_STATE_RE', () => {
  const hits = [
    'what are you doing',
    'whats going on',
    'why are you talking like a pirate',
    "why aren't you answering",
    'why did you stop doing trivia',
    'why so quiet',
    'why no trivia',
    'are you ok',
    'are you muted',
    'r u broken',
    "who's muted",
    'who muted bob',
    'any vibes active',
    'current vibes',
    'bot status',
    'still paused?',
    'when are you back',
    'what vibes are there',
  ]
  const misses = [
    'what does fiery do',
    'best build for vanessa',
    'trivia about frogs',
    'who is kripp',
    'why is burn good',
    'what are the best items',
  ]
  for (const q of hits) it(`matches: "${q}"`, () => expect(SELF_STATE_RE.test(q)).toBe(true))
  for (const q of misses) it(`ignores: "${q}"`, () => expect(SELF_STATE_RE.test(q)).toBe(false))
})

describe('botStateReport', () => {
  beforeEach(() => {
    resetDirectives()
    resetSuppress()
    resetTrivia()
    resetProvidersForTest()
  })
  afterEach(() => resetProvidersForTest())

  it('reports the quiet state honestly when nothing is active', () => {
    const r = botStateReport('ch')
    expect(r).toContain('[BOT STATE]')
    expect(r).toContain('nothing special active')
  })

  it('lists vibes, mutes, and mod pauses with owners and minutes', () => {
    addDirective('ch', 'planter1', { instruction: 'answer in spanish' })
    addDirective('ch', 'planter2', { mute: true, targetUser: 'bob' })
    suppress('ch', 'trivia', 'modguy', 20)
    const r = botStateReport('ch')
    expect(r).toContain('"answer in spanish"')
    expect(r).toContain('by planter1')
    expect(r).toContain('mute @bob')
    expect(r).toContain('trivia (20m left, by modguy)')
  })

  it('NEVER leaks a live round answer — question and clock only', () => {
    // no store fixtures loaded here, so some generators bail — retry until one lands
    // (any round works; the assertion is about the report, not the question)
    let game: ReturnType<typeof getActiveGameForTest> | undefined
    for (let i = 0; i < 25 && !game; i++) {
      startTrivia('#leak')
      game = getActiveGameForTest('#leak')
    }
    if (!game) throw new Error('no generator produced a round in 25 tries')
    const r = botStateReport('#leak')
    expect(r).toContain('round LIVE')
    expect(r).toContain('s left')
    // the radioactive fields must not appear OUTSIDE the question text itself (a short
    // accepted answer can legitimately be a substring of its own question — that's the
    // question leaking nothing; anything beyond it would be)
    const outsideQ = r.toLowerCase().replace(game.question.slice(0, 90).toLowerCase(), '')
    expect(outsideQ).not.toContain(game.correctAnswer.toLowerCase())
    for (const a of game.acceptedAnswers) {
      if (a.length >= 3) expect(outsideQ).not.toContain(a.toLowerCase())
    }
  })

  it('includes registered provider lines and survives a throwing provider', () => {
    registerStateProvider(() => 'trivia queue: "wow" (by bob)')
    registerStateProvider(() => { throw new Error('boom') })
    registerStateProvider(() => '')
    const r = botStateReport('ch')
    expect(r).toContain('trivia queue: "wow" (by bob)')
  })

  it('caps the block size', () => {
    for (let i = 0; i < 4; i++) addDirective('ch', `p${i}`, { instruction: `long vibe instruction number ${i} `.repeat(4) })
    registerStateProvider(() => 'x'.repeat(400))
    expect(botStateReport('ch').length).toBeLessThan(1000)
  })
})
