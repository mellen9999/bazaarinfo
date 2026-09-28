import { describe, expect, it } from 'bun:test'
import { isExactEmote } from './emotes'

// "the bazaar" lost "bazaar" to a case-insensitive emote match and trivia was written
// about the word "the" (2026-09-27). emotes are case-sensitive; the word is not the emote.
describe('isExactEmote', () => {
  it('matches the exact case only', () => {
    expect(isExactEmote('Kappa')).toBe(true)
    expect(isExactEmote('kappa')).toBe(false)
    expect(isExactEmote('bazaar')).toBe(false)
  })
})
