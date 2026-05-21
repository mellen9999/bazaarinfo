import { describe, it, expect } from 'bun:test'
import { fitToBudget } from './ai-build'

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
