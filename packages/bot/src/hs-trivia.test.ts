import { test, expect, describe, beforeAll } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { extractBgCards, __setHsCards } from './hs-cards'
import { HS_GENERATORS, hsTriviaReady, __leaksNameForTest } from './hs-trivia'

// run against the REAL card set when it's on disk (mele, and any dev box that has
// refreshed once). a generator for data we don't control is only worth what it does on
// the real thing — the same reason the companion parser is tested against a real log.
const CACHE = resolve(import.meta.dir, '../../../cache/hs-cards.json')
const hasCache = existsSync(CACHE)

beforeAll(() => {
  if (!hasCache) return
  const parsed = JSON.parse(readFileSync(CACHE, 'utf8'))
  __setHsCards(parsed.cards, parsed.ids ?? {})
})

describe('hs trivia generators', () => {
  test('every generator produces a question from the real card set', () => {
    if (!hasCache) return
    expect(hsTriviaReady()).toBe(true)
    for (const gen of HS_GENERATORS) {
      let q = null
      for (let i = 0; i < 40 && !q; i++) q = gen()
      expect(q, `${gen.name} never produced a question`).not.toBeNull()
      expect(q!.question.length).toBeGreaterThan(10)
      expect(q!.answer.length).toBeGreaterThan(0)
      expect(q!.accepted).toContain(q!.answer)
    }
  })

  test('the answer is never sitting in the question', () => {
    if (!hasCache) return
    // a free win is worse than no question — this is the bar every Bazaar generator
    // already holds itself to
    for (const gen of HS_GENERATORS) {
      for (let i = 0; i < 60; i++) {
        const q = gen()
        if (!q) continue
        expect(q.question.toLowerCase()).not.toContain(q.answer.toLowerCase())
      }
    }
  })

  test('questions stay inside a twitch message', () => {
    if (!hasCache) return
    for (const gen of HS_GENERATORS) {
      for (let i = 0; i < 40; i++) {
        const q = gen()
        if (q) expect(q.question.length).toBeLessThan(400)
      }
    }
  })

  test('never asks about a card the current pool no longer offers', () => {
    if (!hasCache) return
    const parsed = JSON.parse(readFileSync(CACHE, 'utf8'))
    const poolNames = new Set(
      parsed.cards.filter((c: { p?: number }) => c.p).map((c: { n: string }) => c.n.toLowerCase()),
    )
    for (const gen of HS_GENERATORS) {
      for (let i = 0; i < 40; i++) {
        const q = gen()
        if (!q) continue
        // when the answer IS a card name, that card has to still be offered
        const a = q.answer.toLowerCase()
        if (/^[a-z' .,\-!]+$/i.test(q.answer) && q.answer.length > 6 && Number.isNaN(Number(q.answer))) {
          if ([...poolNames].some((n) => n === a)) expect(poolNames.has(a)).toBe(true)
        }
      }
    }
  })

  test('a tribe answer is never a multi-tribe card — those have several right answers', () => {
    if (!hasCache) return
    const tribe = HS_GENERATORS.find((g) => g.name === 'genHsTribeQuestion')!
    for (let i = 0; i < 60; i++) {
      const q = tribe()
      if (q) expect(q.answer).not.toContain('/')
    }
  })

  test('with no card data loaded, every generator declines instead of inventing', () => {
    __setHsCards([], {})
    expect(hsTriviaReady()).toBe(false)
    for (const gen of HS_GENERATORS) expect(gen()).toBeNull()
    // restore for any later test in this file
    if (hasCache) {
      const parsed = JSON.parse(readFileSync(CACHE, 'utf8'))
      __setHsCards(parsed.cards, parsed.ids ?? {})
    }
  })
})

describe('leaksName — the shared free-win guard', () => {
  test('catches a card naming itself in its own text', () => {
    expect(__leaksNameForTest('Deflect-o-Bot', 'Whenever Deflect-o-Bot loses Divine Shield…')).toBe(true)
    expect(__leaksNameForTest('Sellemental', 'When you sell this, get a 3/3 Elemental.')).toBe(false)
  })

  test('ignores words too short to be distinctive', () => {
    // "Bot", "Ur" would match half the card set; only words over three letters count
    expect(__leaksNameForTest('Bot Wrangler', 'Get a Bot.')).toBe(false)
    expect(__leaksNameForTest('Bird Buddy', 'Get a bird.')).toBe(true)  // "bird" is long enough
  })
})
