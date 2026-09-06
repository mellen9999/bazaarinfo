import { describe, expect, it } from 'bun:test'
import { isNullFact } from './ai-background'

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
