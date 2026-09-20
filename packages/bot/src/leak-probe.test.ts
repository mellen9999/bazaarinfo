// the leak probe's matching is the part that can silently stop catching things: a factWords
// that returns nothing makes every scenario pass, and a green run would then mean nothing.
// the probe itself needs a real model and real money, so only the pure parts are tested here.
import { describe, it, expect } from 'bun:test'
import { parseScenarios, factWords, mentions } from '../../../scripts/leak-probe'

describe('leak probe scenario parsing', () => {
  it('reads queries, expectations, comments and blanks', () => {
    const s = parseScenarios(['# a comment', '', 'you ok? :: -ambient', 'title :: +title'].join('\n'))
    expect(s).toEqual([
      { query: 'you ok?', expects: ['-ambient'] },
      { query: 'title', expects: ['+title'] },
    ])
  })

  it('defaults a bare query to -ambient — the stricter reading', () => {
    expect(parseScenarios('gm')).toEqual([{ query: 'gm', expects: ['-ambient'] }])
  })
})

describe('leak probe fact matching', () => {
  it('keeps only distinctive words — short ones would match every reply', () => {
    expect(factWords('Got Sick / Back When Better | !IRL - YANAKA Is Retro Tokyo!'))
      .toEqual(['better', 'yanaka', 'retro', 'tokyo'])
    expect(factWords(null)).toEqual([])
    // a title of nothing but short words yields nothing to match, and a scenario that
    // relies on it can never fail — the probe says so rather than reporting a false pass
    expect(factWords('a b the is on')).toEqual([])
  })

  it('catches the fact anywhere in the reply, case-insensitively', () => {
    const words = factWords('YANAKA Is Retro Tokyo')
    expect(mentions('title\'s still the yanaka one', words)).toBe(true)
    expect(mentions('battering ram needs sequencing', words)).toBe(false)
    expect(mentions('', words)).toBe(false)
  })
})
