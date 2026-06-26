import { describe, it, expect } from 'bun:test'
import { fitToBudget, TRIVIA_REF_RE, STANDINGS_RE, COMPARISON_RE } from './ai-build'

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
  // every match requires an explicit trivia/round anchor so generic doubt phrases
  // ("is that real", "that question about builds") don't inject stale context.
  it('fires on explicit trivia/round-anchored references', () => {
    for (const q of [
      'fact check that trivia answer',
      'fact-check the answer',        // "answer" alone counts as anchor in fact-check path
      'fact check the question',
      'fact check that round',
      'that trivia answer is cap',
      'the trivia question',
      'what was the last trivia question',
      'the answer was wrong',         // "answer was wrong" — trivia-answer result phrasing
      'the answer is correct',
      'wait was the previous round legit',
      'previous trivia round',
      'trivia answer was right',
    ]) expect(TRIVIA_REF_RE.test(q)).toBe(true)
  })

  it('does not fire on generic doubt/reaction phrases without a trivia/round anchor', () => {
    for (const q of [
      // previously false-positives that injected stale trivia context:
      'is that real',
      'that question about builds',
      'was that right',               // no trivia anchor
      'is that even correct',         // no trivia anchor
      'was that answer wrong',        // "that answer wrong" — word order doesn't match "answer was wrong"
      'factcheck that',               // no answer/question/round specified
      'the answer is bs',             // "bs" not in legit/right/wrong list
      // unrelated chatter:
      "what's kripp's best item",
      'tell me a joke about hamstornado',
      'who is the strongest hero',
      'how many queries do you serve',
      'spam Pog 5 times',
      'is dooley good right now',
    ]) expect(TRIVIA_REF_RE.test(q)).toBe(false)
  })
})

describe('STANDINGS_RE — new intent phrasings ground AI with real leaderboard data', () => {
  it('matches new phrasings that previously deflected or fabricated', () => {
    for (const q of [
      // defect 1 — "who has the most" family
      'who has the most wins',
      'who has the most points',
      "who's got the highest score",
      'who got the top wins',
      // defect 2 — leader/leading phrasing
      'points leader',
      'score leader',
      'wins leader',
      'leading in points',
      'leader in wins',
      // defect 4 — first-person count
      'how many trivia wins do i have',
      'how many points do i have',
      'how many wins have i got',
      // defect 5 — @-mention comparison
      'do i have more wins than @bob',
      'more points than @alice',
      'fewer wins than @charlie',
    ]) expect(STANDINGS_RE.test(q)).toBe(true)
  })

  it('does not hijack "trivia about winning" (topic round request)', () => {
    // "trivia about X" routes to custom round generation — must NOT be grounded as standings
    expect(STANDINGS_RE.test('trivia about winning')).toBe(false)
  })

  it('preserves existing phrasings', () => {
    for (const q of [
      'leaderboard',
      'standings',
      'scoreboard',
      "who's winning",
      'who is leading',
      'my trivia stats',
      'where do i rank',
      'am i winning',
      'top players',
    ]) expect(STANDINGS_RE.test(q)).toBe(true)
  })
})

describe('COMPARISON_RE — detects @-mention win/point comparison for dual-user injection', () => {
  it('fires on comparison phrasings', () => {
    for (const q of [
      'do i have more wins than @bob',
      'more points than @alice',
      'fewer wins than @charlie',
      'higher score than @dave',
      'better points than @eve',
    ]) expect(COMPARISON_RE.test(q)).toBe(true)
  })

  it('does not fire on non-comparison standings questions', () => {
    expect(COMPARISON_RE.test('who has the most wins')).toBe(false)
    expect(COMPARISON_RE.test('leaderboard')).toBe(false)
    expect(COMPARISON_RE.test('how many wins do i have')).toBe(false)
  })
})
