import { describe, expect, test } from 'bun:test'
import {
  OVERLAY,
  compareVersions,
  getCardChange,
  getHeroChanges,
  isOverlayFresh,
  pendingHeroes,
  resolvePatch,
  selectNotes,
} from './patch-notes'
import type { PatchInfo } from './patch'

const released = new Date(OVERLAY.released + 'T00:00:00Z').getTime()
const dayAfter = released + 24 * 60 * 60 * 1000
const longAfter = released + 365 * 24 * 60 * 60 * 1000

function scraped(version: string): PatchInfo {
  return {
    latestPatch: version,
    patchDate: 'Jul 17',
    sizeBadge: 'M',
    activeEvent: null,
    fetchedAt: new Date(dayAfter).toISOString(),
  }
}

describe('compareVersions', () => {
  test('orders by numeric segment', () => {
    expect(compareVersions('17.0', '16.2')).toBe(1)
    expect(compareVersions('16.2', '17.0')).toBe(-1)
    expect(compareVersions('17.0', '17.0')).toBe(0)
    expect(compareVersions('17.1', '17.0')).toBe(1)
    expect(compareVersions('9.9', '10.0')).toBe(-1)
  })

  test('tolerates ragged length and junk segments', () => {
    expect(compareVersions('17', '17.0')).toBe(0)
    expect(compareVersions('17.0.1', '17.0')).toBe(1)
    expect(compareVersions('x.y', '0.0')).toBe(0)
  })
})

describe('resolvePatch', () => {
  test('floors the version while the scraper lags', () => {
    const r = resolvePatch(scraped('16.2'), dayAfter)
    expect(r.info?.latestPatch).toBe(OVERLAY.version)
    expect(r.info?.patchDate).toBe(OVERLAY.date)
    expect(r.dbBehind).toBe(true)
  })

  test('never invents a size badge when it floors', () => {
    expect(resolvePatch(scraped('16.2'), dayAfter).info?.sizeBadge).toBe('')
  })

  test('defers to the scraper once it catches up', () => {
    const s = scraped(OVERLAY.version)
    const r = resolvePatch(s, dayAfter)
    expect(r.info).toBe(s)
    expect(r.dbBehind).toBe(false)
  })

  test('defers to a scraper that is ahead', () => {
    const r = resolvePatch(scraped('18.0'), dayAfter)
    expect(r.info?.latestPatch).toBe('18.0')
    expect(r.dbBehind).toBe(false)
  })

  test('covers a missing scrape while fresh', () => {
    const r = resolvePatch(null, dayAfter)
    expect(r.info?.latestPatch).toBe(OVERLAY.version)
    expect(r.dbBehind).toBe(true)
  })

  test('stops speaking once the overlay ages out', () => {
    expect(resolvePatch(scraped('16.2'), longAfter).info?.latestPatch).toBe('16.2')
    expect(resolvePatch(null, longAfter).info).toBeNull()
    expect(isOverlayFresh(longAfter)).toBe(false)
  })

  test('keeps a live event from the scrape when flooring', () => {
    const s = { ...scraped('16.2'), activeEvent: '16.2 Event Jul 17' }
    expect(resolvePatch(s, dayAfter).info?.activeEvent).toBe('16.2 Event Jul 17')
  })
})

describe('pendingHeroes', () => {
  test('reports a hero the dump has not listed yet', () => {
    expect(pendingHeroes(['Vanessa', 'Pygmalien'], dayAfter)).toEqual(['The Dragons'])
  })

  test('empties itself once the dump catches up', () => {
    expect(pendingHeroes(['Vanessa', 'The Dragons'], dayAfter)).toEqual([])
  })

  test('is empty once the overlay ages out', () => {
    expect(pendingHeroes(['Vanessa'], longAfter)).toEqual([])
  })
})

describe('getCardChange', () => {
  test('matches on exact name', () => {
    expect(getCardChange('Katana')?.text).toContain('15/30/60/120')
  })

  test('is case- and punctuation-insensitive', () => {
    expect(getCardChange('katana')?.hero).toBe('Vanessa')
    expect(getCardChange('dragon tooth')?.hero).toBe('Pygmalien')
    expect(getCardChange('Cyber-Sai')).not.toBeNull()
  })

  test('never fuzzy-matches a different card', () => {
    expect(getCardChange('Kat')).toBeNull()
    expect(getCardChange('Katana Blade')).toBeNull()
    expect(getCardChange('Solar Farm Deluxe')).toBeNull()
    expect(getCardChange('')).toBeNull()
  })
})

describe('getHeroChanges', () => {
  test('returns only that hero, case-insensitively', () => {
    const v = getHeroChanges('vanessa')
    expect(v.length).toBeGreaterThan(5)
    expect(v.every((c) => c.hero === 'Vanessa')).toBe(true)
  })

  test('is empty for an unknown hero', () => {
    expect(getHeroChanges('Nobody')).toEqual([])
  })
})

describe('selectNotes', () => {
  test('caps the count', () => {
    expect(selectNotes('whats new', 3).length).toBe(3)
    expect(selectNotes('whats new', 1).length).toBe(1)
  })

  test('ranks the on-topic note first', () => {
    expect(selectNotes('is there a new hero')[0]).toContain('Dragons')
    expect(selectNotes('what is an instrument')[0]).toContain('Instrument')
    expect(selectNotes('any tournament mode news')[0]).toContain('tournament')
  })

  test('falls back to document order with no overlap', () => {
    expect(selectNotes('zzz')[0]).toBe(OVERLAY.notes[0])
  })
})

describe('overlay data integrity', () => {
  test('has no duplicate card entries', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const c of OVERLAY.changes) {
      const k = c.card.toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (seen.has(k)) dupes.push(c.card)
      seen.add(k)
    }
    expect(dupes).toEqual([])
  })

  test('every change is attributed and non-empty', () => {
    const heroes = new Set(['Common', 'Dooley', 'Karnok', 'Jules', 'Mak', 'Pygmalien', 'Stelle', 'Vanessa', 'The Dragons', 'Monster', 'Encounter'])
    for (const c of OVERLAY.changes) {
      expect(heroes.has(c.hero)).toBe(true)
      expect(c.card.length).toBeGreaterThan(1)
      expect(c.text.length).toBeGreaterThan(10)
      // has to survive inside a 480-char Twitch reply alongside the card itself
      expect(c.text.length).toBeLessThan(240)
    }
  })

  // a curly apostrophe in a key normalizes differently from the dump's plain one, so the
  // entry would silently never fire. keys are matched against dump titles — keep them ascii.
  test('card keys are plain ascii, matching dump titles', () => {
    const bad = OVERLAY.changes.filter((c) => !/^[A-Za-z0-9 '\-]+$/.test(c.card))
    expect(bad.map((c) => c.card)).toEqual([])
  })

  test('notes stay short enough to inject', () => {
    for (const n of OVERLAY.notes) expect(n.length).toBeLessThan(500)
    expect(OVERLAY.notes.join('').length).toBeLessThan(4000)
  })

  test('version and date are well-formed', () => {
    expect(OVERLAY.version).toMatch(/^\d+(\.\d+)+$/)
    expect(OVERLAY.date).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
    expect(OVERLAY.released).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(isNaN(new Date(OVERLAY.released).getTime())).toBe(false)
  })
})
