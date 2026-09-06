import { describe, expect, it } from 'bun:test'
import { isNullFact, stripNoBotCommitments } from './ai-background'

describe('isNullFact', () => {
  it('drops the extractor\'s "nothing to extract" answer in every observed shape', () => {
    expect(isNullFact('No facts to extract.')).toBe(true)
    expect(isNullFact('No facts about X found in the provided text.')).toBe(true)
    expect(isNullFact('There are no facts to extract.')).toBe(true)
    expect(isNullFact('No facts extracted.')).toBe(true)
    expect(isNullFact('Output: (nothing to extract)')).toBe(true)
    expect(isNullFact('Output: *(nothing to extract)*')).toBe(true)
  })

  it('keeps real facts', () => {
    expect(isNullFact('favorite item is tour bus')).toBe(false)
    expect(isNullFact("doesn't play bazaar")).toBe(false)
  })
})

describe('stripNoBotCommitments', () => {
  it('strips the echoed instruction sentence', () => {
    expect(stripNoBotCommitments('chat argued about tier 4 boards. No bot commitments made.'))
      .toBe('chat argued about tier 4 boards.')
    expect(stripNoBotCommitments('quiet stream, some banter about vanessa. No bot commitments.'))
      .toBe('quiet stream, some banter about vanessa.')
    expect(stripNoBotCommitments('kripp died to day 8 boss. bot made no commitments.'))
      .toBe('kripp died to day 8 boss.')
  })

  it('leaves an unrelated summary untouched', () => {
    const s = 'chat is hyped about the new season, bot agreed to track the winrate thread.'
    expect(stripNoBotCommitments(s)).toBe(s)
  })
})
