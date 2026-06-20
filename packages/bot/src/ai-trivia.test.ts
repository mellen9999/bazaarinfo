import { describe, expect, it } from 'bun:test'
import { splitAlternates } from './ai-trivia'

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
