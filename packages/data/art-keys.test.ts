import { describe, it, expect } from 'bun:test'
import artKeys from './art-keys.json'

// This map is the only thing standing between the overlay and a wall of fallback
// glyphs, and it fails silently: a stale or empty map just means no card has art,
// which nobody notices until someone looks.
//
// It went stale exactly that way once. bazaardb moved its CDN from /v1/z11.0/ to
// /v1/z17.0/ and re-keyed the files from 32-hex to 40-hex; the scraper's pattern was
// pinned to the old version so it matched nothing, and the committed map kept its
// old identifiers, which the CDN had stopped serving. Every tooltip lost its art and
// no test, log line, or alert said a word.
//
// So these assertions are deliberately shape-specific. If bazaardb re-keys again
// they will fail loudly and the fix is one command: delete packages/data/art-keys.json
// and re-run scripts/scrape-images.ts.
const map = artKeys as Record<string, string>
const entries = Object.entries(map)

// current CDN filenames are sha1 hex
const CDN_HASH = /^[a-f0-9]{40}$/
// generous floor — the dump carries ~1900 cards; well under half means a broken
// or half-finished harvest got committed
const MIN_ENTRIES = 1500

describe('art-keys map', () => {
  it('covers the card list rather than a handful of leftovers', () => {
    expect(entries.length).toBeGreaterThanOrEqual(MIN_ENTRIES)
  })

  it('every value is a current-shape CDN hash', () => {
    const wrong = entries.filter(([, v]) => !CDN_HASH.test(v))
    expect(wrong.slice(0, 5)).toEqual([])
  })

  it('has no blank entries, which would render as a broken image', () => {
    expect(entries.filter(([, v]) => !v || !v.trim())).toEqual([])
  })

  it('has no blank titles to look up by', () => {
    expect(entries.filter(([k]) => !k.trim())).toEqual([])
  })
})
