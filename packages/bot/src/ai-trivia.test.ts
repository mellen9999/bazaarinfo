import { describe, expect, it } from 'bun:test'
import { splitAlternates, pickDistinctLenses, LENSES } from './ai-trivia'

describe('splitAlternates — fold answer alternates into accept', () => {
  it('splits a parenthetical alternate', () => {
    expect(splitAlternates('Ti (or Si)')).toEqual({ canonical: 'Ti', alts: ['Si'] })
    expect(splitAlternates('Ti (Si)')).toEqual({ canonical: 'Ti', alts: ['Si'] })
  })
  it('splits "/" and " or " forms', () => {
    expect(splitAlternates('Ti / Si')).toEqual({ canonical: 'Ti', alts: ['Si'] })
    expect(splitAlternates('Ti or Si')).toEqual({ canonical: 'Ti', alts: ['Si'] })
  })
  it('leaves a single clean answer untouched', () => {
    expect(splitAlternates('San Francisco')).toEqual({ canonical: 'San Francisco', alts: [] })
    expect(splitAlternates('42')).toEqual({ canonical: '42', alts: [] })
  })
  it('does not split an ampersand name', () => {
    expect(splitAlternates('Mortar & Pestle')).toEqual({ canonical: 'Mortar & Pestle', alts: [] })
  })
})

describe('pickDistinctLenses — best-of-N varied angles per round', () => {
  it('returns k distinct real lenses', () => {
    for (let i = 0; i < 50; i++) {
      const ls = pickDistinctLenses('#lenschan', 3)
      expect(ls.length).toBe(3)
      expect(new Set(ls).size).toBe(3) // all distinct within a round
      for (const l of ls) expect(LENSES).toContain(l)
    }
  })
  it('clamps k to the lens count and always returns at least 1', () => {
    expect(pickDistinctLenses('#clamp', 99).length).toBe(LENSES.length)
    expect(pickDistinctLenses('#clamp', 0).length).toBe(1)
    expect(pickDistinctLenses('#clamp', -5).length).toBe(1)
  })
  it('prefers fresh angles round-to-round (low overlap with the previous round)', () => {
    // with 8 lenses and the recent window, two back-to-back rounds of 3 should not be
    // identical sets — fresh angles are preferred until the pool is exhausted.
    const r1 = new Set(pickDistinctLenses('#freshchan', 3))
    const r2 = new Set(pickDistinctLenses('#freshchan', 3))
    const overlap = [...r2].filter((l) => r1.has(l)).length
    expect(overlap).toBeLessThan(3) // never a full repeat of the prior round
  })
  it('keeps channels independent', () => {
    expect(pickDistinctLenses('#a', 2).every((l) => LENSES.includes(l))).toBe(true)
    expect(pickDistinctLenses('#b', 2).every((l) => LENSES.includes(l))).toBe(true)
  })
})
