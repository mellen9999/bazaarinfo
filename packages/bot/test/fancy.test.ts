import { test, expect, describe } from 'bun:test'
import { toFancy, detectFancyStyle, type FancyStyle } from '../src/fancy'

describe('detectFancyStyle', () => {
  test('explicit font names', () => {
    expect(detectFancyStyle('make a pasta in fraktur')).toBe('fraktur')
    expect(detectFancyStyle('bold fraktur copypasta')).toBe('boldFraktur')
    expect(detectFancyStyle('write it cursive')).toBe('script')
    expect(detectFancyStyle('bold cursive please')).toBe('boldScript')
    expect(detectFancyStyle('fullwidth aesthetic text')).toBe('fullwidth')
    expect(detectFancyStyle('double-struck letters')).toBe('doubleStruck')
    expect(detectFancyStyle('monospace pls')).toBe('monospace')
    expect(detectFancyStyle('bold italic')).toBe('boldItalic')
    expect(detectFancyStyle('just italic')).toBe('italic')
    expect(detectFancyStyle('make it bold')).toBe('bold')
  })

  test('generic fancy intent defaults to script', () => {
    expect(detectFancyStyle('copypasta in a fancy font')).toBe('script')
    expect(detectFancyStyle('make it stylized')).toBe('script')
    expect(detectFancyStyle('give me cult vibes font')).toBe('script')
  })

  test('echoes when user typed fancy unicode', () => {
    expect(detectFancyStyle('continue this 𝔤𝔬𝔱𝔥')).toBe('script')
  })

  test('null when not a fancy request', () => {
    expect(detectFancyStyle('make a normal copypasta about kripp')).toBeNull()
    expect(detectFancyStyle('what is the best hero')).toBeNull()
    expect(detectFancyStyle('roast chat')).toBeNull()
  })
})

describe('toFancy transcode', () => {
  const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!)

  test('fraktur: hole codepoint for C, block offset for lowercase', () => {
    // C is a Letterlike-Symbols hole (ℭ U+212D); u/l/t come from the 0x1D51E block.
    expect(cps(toFancy('Cult', 'fraktur'))).toEqual([
      0x212d, 0x1d51e + 20, 0x1d51e + 11, 0x1d51e + 19,
    ])
  })

  test('script handles letterlike holes', () => {
    // B,E,F,H,I,L,M,R upper / e,g,o lower borrow Letterlike Symbols
    expect(toFancy('B', 'script')).toBe('ℬ')
    expect(toFancy('e', 'script')).toBe('ℯ')
    expect(toFancy('g', 'script')).toBe('ℊ')
  })

  test('double-struck digits + holes', () => {
    // R is a hole (ℝ U+211D); 2 maps into the 0x1D7D8 digit block.
    expect(cps(toFancy('R2', 'doubleStruck'))).toEqual([0x211d, 0x1d7d8 + 2])
  })

  test('fullwidth maps space + digits', () => {
    expect(toFancy('A 1', 'fullwidth')).toBe('Ａ　１')
  })

  test('preserves punctuation, emoji, and existing unicode', () => {
    const out = toFancy('hi! 🔥', 'bold')
    // h,i from the 0x1D41A bold-lowercase block; '! ', emoji untouched
    expect(cps(out)).toEqual([0x1d41a + 7, 0x1d41a + 8, 0x21, 0x20, 0x1f525])
  })

  test('every style round-trips length by code points (no dropped/extra glyphs)', () => {
    const styles: FancyStyle[] = ['fraktur', 'boldFraktur', 'script', 'boldScript',
      'bold', 'italic', 'boldItalic', 'doubleStruck', 'monospace', 'fullwidth']
    const src = 'The Quick Brown Fox 123!'
    for (const s of styles) {
      const out = toFancy(src, s)
      expect([...out].length).toBe([...src].length)
      // ascii letters must have actually changed (not a no-op map)
      expect(out).not.toBe(src)
    }
  })

  test('400-ascii cap stays under twitch 500-char limit after transcode', () => {
    const src = 'a'.repeat(400)
    const out = toFancy(src, 'fraktur')
    expect([...out].length).toBe(400) // 400 twitch chars, well under 500
  })
})
