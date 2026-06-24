// trivia-round context injection — real DB + store, exercising buildUserMessage end to end.
// guards two things: (1) a fact-check ask AFTER a round injects the real Q+A so the bot stops
// deflecting; (2) it NEVER injects mid-round (createTriviaGame writes the answer at round start,
// so getLastTriviaResult would otherwise hand a live chatter the in-flight answer).
import { describe, it, expect, beforeAll } from 'bun:test'
import { initDb, createTriviaGame } from './db'
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
