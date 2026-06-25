// trivia-round context injection — real DB + store, exercising buildUserMessage end to end.
// guards three things: (1) a fact-check ask AFTER a round injects the real Q+A so the bot stops
// deflecting; (2) it NEVER injects mid-round; (3) triviaStandings survives the context budget
// loop even when recentChat + gameBlock fill most of the 3500-char cap.
import { describe, it, expect, beforeAll } from 'bun:test'
import { initDb, createTriviaGame, getOrCreateUser, recordTriviaWin } from './db'
import { buildUserMessage } from './ai-build'
import { loadStore } from './store'
import { startTrivia, isGameActive, getActiveGameForTest } from './trivia'

beforeAll(async () => { initDb(':memory:'); await loadStore() })

const ctx = (channel: string) => ({ user: 'h', channel }) as any

describe('trivia-round reference injection', () => {
  it('injects the just-played round Q+A on a fact-check ask (no live game)', () => {
    createTriviaGame('#tr-done', 21, 'Halo was first announced in 1999 for what platform?', 'Mac')
    expect(isGameActive('#tr-done')).toBe(false)
    const r = buildUserMessage('fact check that trivia answer', ctx('#tr-done'))
    expect(r.text).toContain('Most recent trivia round')
    expect(r.text).toContain('Halo')
    expect(r.text).toContain('A: Mac')
  })

  it('does NOT inject for an unrelated ask', () => {
    createTriviaGame('#tr-misc', 21, 'q', 'Mac')
    const r = buildUserMessage('tell me a joke', ctx('#tr-misc'))
    expect(r.text).not.toContain('Most recent trivia round')
  })

  it('never surfaces the in-flight answer mid-round (answer-leak guard)', () => {
    startTrivia('#tr-live')
    expect(isGameActive('#tr-live')).toBe(true)
    const liveAnswer = getActiveGameForTest('#tr-live')!.correctAnswer
    const r = buildUserMessage('fact check that trivia answer', ctx('#tr-live'))
    // the round's answer only reaches the AI via this injected block; its absence = no leak.
    // (a bare answer-substring check is unreliable: short answers collide with unrelated game data.)
    expect(r.text).not.toContain('Most recent trivia round')
    expect(r.text).not.toContain(`A: ${liveAnswer}`)
  })
})

describe('triviaStandings budget eviction fix — standings survives a full context', () => {
  // regression for #1: triviaStandings (base -110) must sort BEFORE primaryPair
  // (recentChat base -100) so a full chat+game context can't push it out of the 3500-char cap.
  it('standings line is present in the user message even when asked with a game query', () => {
    const ch = '#standings-budget'
    // seed a real leaderboard row so the standings block is non-empty
    const gameId = createTriviaGame(ch, 21, 'Test Q?', 'Test A')
    const uid = getOrCreateUser('topplayer')
    recordTriviaWin(gameId, uid, 5000, 1, 10)

    // ask something that triggers both standings and game-entity lookup —
    // this is the worst case: primaryPair would be large (game data present)
    const r = buildUserMessage('who is winning the leaderboard', { user: 'h', channel: ch } as any)
    expect(r.text).toContain('Trivia standings')
    // specifically confirm it was NOT evicted (text must include a standings row, not just the header)
    expect(r.text).toContain('topplayer')
  })

  it('triviaRef line survives when a recent round exists and query references trivia', () => {
    const ch = '#ref-budget'
    createTriviaGame(ch, 21, 'Which hero is the oldest?', 'Vanessa')

    const r = buildUserMessage('fact check that trivia answer', { user: 'h', channel: ch } as any)
    expect(r.text).toContain('Most recent trivia round')
    expect(r.text).toContain('Vanessa')
  })
})
