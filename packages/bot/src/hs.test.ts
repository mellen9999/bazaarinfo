import { test, expect, describe } from 'bun:test'
import { isHsRatingQuery, extractSubject, matchPlayer, resolveAlias, type HsEntry } from './hs'

// a small stand-in for the real board. shapes taken from live blizzard data so the
// matching rules are exercised against realistic battletags.
const e = (name: string, rank: number, rating: number, region = 'US'): HsEntry =>
  ({ name, rank, rating, region, mode: 'battlegrounds' })

const BOARD: HsEntry[] = [
  e('BeterBabbit', 1, 13156),
  e('dog', 6, 11390),
  e('dogdog', 41, 9800),
  e('Lyme', 8, 11112),
  e('guDDummit', 1, 14155, 'EU'),
  e('Sagepase', 9, 11026),
]

describe('isHsRatingQuery — routes a battlegrounds standings ask', () => {
  test('matches the real asks', () => {
    for (const q of [
      'whats kripps current BG rating? i want to join his lobby',
      'what is dog rating in battlegrounds',
      'who is number 1 in battlegrounds',
      'whats the top hearthstone BG rating',
      'hs battlegrounds leaderboard right now',
      'is he top 100 bg',
    ]) {
      expect(isHsRatingQuery(q)).toBe(true)
    }
  })

  test('leaves everything else alone', () => {
    // needs BOTH a battlegrounds/hearthstone word AND a rating word, so ordinary bazaar
    // chat and bare game-name banter never drag in a leaderboard block
    for (const q of [
      'whats the best bazaar item',
      'hows the weather',
      'is hearthstone dead',
      'whats my trivia rank',
      'best bg hero to play',
    ]) {
      expect(isHsRatingQuery(q)).toBe(false)
    }
  })
})

describe('extractSubject — who is being asked about', () => {
  test('pulls the player out of a rating ask', () => {
    expect(extractSubject('what is dog rating in battlegrounds')).toBe('dog')
    expect(extractSubject("what's Lyme's BG rating")).toBe('Lyme')
    expect(extractSubject('@Sagepase bg rating?')).toBe('Sagepase')
  })

  test('a leaderboard-wide ask names nobody', () => {
    expect(extractSubject('who is number 1 in battlegrounds')).toBe(null)
    expect(extractSubject('whats the top hearthstone BG rating')).toBe(null)
    expect(extractSubject('current bg leaderboard standings')).toBe(null)
  })
})

describe('resolveAlias — chat names a streamer, blizzard indexes battletags', () => {
  test('maps a known streamer to their stated battletag', () => {
    expect(resolveAlias('kripp')).toBe('LettuceKing')
    expect(resolveAlias('KRIPP')).toBe('LettuceKing')
    expect(resolveAlias('nl_kripp')).toBe('LettuceKing')
  })

  test('handles the apostrophe-less possessive chat actually types', () => {
    expect(resolveAlias('kripps')).toBe('LettuceKing')
  })

  test('an unknown name passes through untouched — never guessed at', () => {
    expect(resolveAlias('dog')).toBe('dog')
    expect(resolveAlias('somerandomviewer')).toBe('somerandomviewer')
  })
})

describe('matchPlayer — never report a stranger as someone else', () => {
  test('exact match wins, case-insensitively', () => {
    expect(matchPlayer(BOARD, 'dog')[0].rating).toBe(11390)
    expect(matchPlayer(BOARD, 'DOG')[0].rating).toBe(11390)
    expect(matchPlayer(BOARD, 'beterbabbit')[0].rank).toBe(1)
  })

  test('an exact name is never shadowed by a longer one', () => {
    // "dog" and "dogdog" both exist — a prefix rule alone would be ambiguous here, and
    // reporting dogdog's 9800 as dog's rating would be a fabricated stat about a person
    const hits = matchPlayer(BOARD, 'dog')
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('dog')
  })

  test('an ambiguous prefix resolves to nothing rather than a guess', () => {
    expect(matchPlayer(BOARD, 'do')).toEqual([])
  })

  test('an unambiguous prefix resolves', () => {
    expect(matchPlayer(BOARD, 'guDDum')[0].name).toBe('guDDummit')
  })

  test('an apostrophe-less possessive still finds the player', () => {
    // chat types "dogs rating", not "dog's rating"
    expect(matchPlayer(BOARD, 'dogs')[0].name).toBe('dog')
  })

  test('trailing-s trimming never invents a match', () => {
    // "Lymes" would trim to "Lyme" (real), but "randoms" must not trim into anything
    expect(matchPlayer(BOARD, 'Lymes')[0].name).toBe('Lyme')
    expect(matchPlayer(BOARD, 'randoms')).toEqual([])
  })

  test('an unranked player returns nothing, never a nearby name', () => {
    expect(matchPlayer(BOARD, 'kripp')).toEqual([])
    expect(matchPlayer(BOARD, '')).toEqual([])
  })

  test('multi-region entries come back best-rank first', () => {
    const multi = [e('Twin', 40, 9000, 'EU'), e('Twin', 3, 12000, 'US')]
    expect(matchPlayer(multi, 'twin').map((x) => x.region)).toEqual(['US', 'EU'])
  })
})
