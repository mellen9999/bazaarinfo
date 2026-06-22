import { describe, expect, it } from 'bun:test'
import { splitAlternates, pickLens, LENSES } from './ai-trivia'

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

describe('pickLens — varied question angles per channel', () => {
  it('always returns a real lens', () => {
    for (let i = 0; i < 50; i++) expect(LENSES).toContain(pickLens('#lenschan'))
  })
  it('never repeats an angle within the recent window (no back-to-back samey questions)', () => {
    // window is the last 4 picks; with 8 lenses a fresh pick always exists, so any pick
    // differs from the previous 4 — guaranteeing consecutive rounds never share an angle.
    const seen: string[] = []
    for (let i = 0; i < 30; i++) {
      const lens = pickLens('#windowchan')
      expect(seen.slice(-4)).not.toContain(lens)
      seen.push(lens)
    }
  })
  it('keeps channels independent', () => {
    const a = pickLens('#a')
    const b = pickLens('#b')
    expect(LENSES).toContain(a)
    expect(LENSES).toContain(b)
  })
})
