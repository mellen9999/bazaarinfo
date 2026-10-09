import { describe, it, expect } from 'bun:test'
import { KEYWORD_LABEL } from '@bazaarinfo/shared/src/keywords'
import { KEYWORD_STYLE, tokenizeKeywords } from './keywords'

const PALETTE = ['#000000', '#ff0000', '#00ff00', '#ffff00', '#8888ff', '#ff00ff', '#00ffff', '#ffffff']

describe('keyword style map', () => {
  it('styles every shared keyword, and only those', () => {
    expect(Object.keys(KEYWORD_STYLE).sort()).toEqual(Object.keys(KEYWORD_LABEL).sort())
  })

  it('stays inside the 8-colour palette', () => {
    for (const [k, s] of Object.entries(KEYWORD_STYLE)) {
      expect(PALETTE, `${k} colour ${s.color}`).toContain(s.color)
    }
  })

  it('pins emoji-capable glyphs to text presentation (U+FE0E)', () => {
    for (const [k, s] of Object.entries(KEYWORD_STYLE)) {
      const cps = [...s.glyph]
      if (/\p{Emoji}/u.test(cps[0])) expect(cps[1], `${k} glyph`).toBe('\uFE0E')
      expect(cps.length).toBeLessThanOrEqual(2)
    }
  })

  it('gives each keyword its own look', () => {
    const looks = Object.values(KEYWORD_STYLE).map((s) => s.glyph)
    expect(new Set(looks).size).toBe(looks.length)
  })
})

describe('tokenizeKeywords', () => {
  it('splits text around keywords and keeps original casing', () => {
    expect(tokenizeKeywords('Deal 5 DAMAGE now')).toEqual([
      'Deal 5 ',
      { kw: 'damage', text: 'DAMAGE' },
      ' now',
    ])
  })

  it('finds every keyword in a list, punctuation adjacent', () => {
    const toks = tokenizeKeywords('When you Slow, Poison or Freeze, adjacent items gain Haste.')
    expect(toks.filter((t) => typeof t !== 'string').map((t) => (t as { kw: string }).kw))
      .toEqual(['slow', 'poison', 'freeze', 'haste'])
    expect(toks[toks.length - 1]).toBe('.')
  })

  it('folds the inflections card text prints onto the base keyword', () => {
    const kws = (s: string) => tokenizeKeywords(s).filter((t) => typeof t !== 'string')
    expect(kws('Frozen')).toEqual([{ kw: 'freeze', text: 'Frozen' }])
    expect(kws('Slowed')).toEqual([{ kw: 'slow', text: 'Slowed' }])
    expect(kws('Hastes')).toEqual([{ kw: 'haste', text: 'Hastes' }])
    expect(kws('Poisoned')).toEqual([{ kw: 'poison', text: 'Poisoned' }])
    expect(kws('Burns')).toEqual([{ kw: 'burn', text: 'Burns' }])
  })

  it('never matches inside another word', () => {
    expect(tokenizeKeywords('Healthy Slowly Charger Damaged')).toEqual(['Healthy Slowly Charger Damaged'])
  })

  it('leaves the Shielded enchantment name alone', () => {
    expect(tokenizeKeywords('Enchant it with Shielded')).toEqual(['Enchant it with Shielded'])
  })

  it('styles Crit but not the Chance after it', () => {
    expect(tokenizeKeywords('+5% Crit Chance')).toEqual(['+5% ', { kw: 'crit', text: 'Crit' }, ' Chance'])
  })

  it('returns plain text and empty input untouched', () => {
    expect(tokenizeKeywords('')).toEqual([])
    expect(tokenizeKeywords('This has no keywords')).toEqual(['This has no keywords'])
  })

  it('is repeatable across calls (shared global regex state)', () => {
    const a = tokenizeKeywords('Burn Burn')
    expect(tokenizeKeywords('Burn Burn')).toEqual(a)
  })
})
