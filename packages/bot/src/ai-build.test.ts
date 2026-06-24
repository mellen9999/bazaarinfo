import { describe, it, expect } from 'bun:test'
import { fitToBudget, TRIVIA_REF_RE } from './ai-build'

describe('fitToBudget — graceful section truncation', () => {
  it('returns text unchanged when it fits', () => {
    expect(fitToBudget('abc', 10)).toBe('abc')
    expect(fitToBudget('abc', 3)).toBe('abc')
  })

  it('truncates at the last newline within budget', () => {
    const t = 'line1\nline2\nline3' // \n at idx 5 and 11
    // budget 10 lands mid "line2" -> cut back to the \n at idx 5
    expect(fitToBudget(t, 10)).toBe('line1')
    // budget 14 lands mid "line3" -> cut back to the \n at idx 11
    expect(fitToBudget(t, 14)).toBe('line1\nline2')
  })

  it('drops single-line sections that overflow (no newline to cut at)', () => {
    expect(fitToBudget('one long single line', 5)).toBeNull()
  })

  it('drops leading-newline sections too small for even their first line', () => {
    // many sections start with "\n"; budget too small to reach the second newline
    expect(fitToBudget('\nActivity: something long here', 5)).toBeNull()
  })

  it('keeps the head of a leading-newline list when budget allows', () => {
    const t = '\nemotes: a b c\nmore: d e f'
    expect(fitToBudget(t, 20)).toBe('\nemotes: a b c')
  })
})

describe('TRIVIA_REF_RE — references to the just-played round inject the real Q+A', () => {
  it('fires on fact-check / "that answer" asks that the deflection bug missed', () => {
    for (const q of [
      'fact check that trivia answer',
      'factcheck that',
      'fact-check the answer',
      'was that right',
      'is that even correct',
      'was that answer wrong',
      'that trivia answer is cap',
      'the answer was wrong',
      'the trivia question',
      'what was the last trivia question',
      'wait was the previous round legit',
      'the answer is bs',
    ]) expect(TRIVIA_REF_RE.test(q)).toBe(true)
  })

  it('does not over-fire on unrelated chatter (no last-round noise injected)', () => {
    for (const q of [
      "what's kripp's best item",
      'tell me a joke about hamstornado',
      'who is the strongest hero',
      'how many queries do you serve',
      'spam Pog 5 times',
      'is dooley good right now',
    ]) expect(TRIVIA_REF_RE.test(q)).toBe(false)
  })
})
