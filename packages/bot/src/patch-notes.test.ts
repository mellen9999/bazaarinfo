import { afterEach, describe, expect, test } from 'bun:test'
import * as notes from './patch-notes'
import {
  OVERLAY,
  adoptOverlay,
  compareVersions,
  getCardChange,
  getHeroChanges,
  isOverlayFresh,
  loadOverlayCache,
  pendingHeroes,
  resetOverlay,
  resolvePatch,
  selectNotes,
  validateOverlay,
} from './patch-notes'
import { SEED } from './patch-seed'
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

describe('overlay adoption', () => {
  afterEach(() => resetOverlay())

  const good = {
    version: '18.0',
    name: 'Next Patch',
    date: 'Sep 2',
    released: '2026-09-02',
    newHeroes: [],
    notes: ['something changed'],
    changes: Array.from({ length: 6 }, (_, i) => ({
      card: `Card ${i}`, hero: 'Vanessa', text: 'buff: damage doubled',
    })),
  }

  test('accepts a newer valid overlay and reindexes lookups', () => {
    expect(adoptOverlay(good)).toBe(true)
    expect(notes.OVERLAY.version).toBe('18.0')
    expect(getCardChange('card 3')?.text).toBe('buff: damage doubled')
    // the previous patch's entries are gone, not merged
    expect(getCardChange('Katana')).toBeNull()
  })

  test('refuses a downgrade', () => {
    expect(adoptOverlay({ ...good, version: '16.0', released: '2026-07-01' })).toBe(false)
    expect(notes.OVERLAY.version).toBe(SEED.version)
  })

  test('refuses a same-version overlay only if invalid, accepts if valid', () => {
    expect(adoptOverlay({ ...good, version: SEED.version })).toBe(true)
  })

  test('rejects structurally broken payloads instead of eroding the seed', () => {
    const seedVersion = notes.OVERLAY.version
    const bad: unknown[] = [
      null,
      'nope',
      { ...good, version: 'latest' },
      { ...good, date: '2026-09-02' },
      { ...good, released: 'Sep 2' },
      { ...good, changes: good.changes.slice(0, 2) },        // too few to be a real patch
      { ...good, changes: [{ card: 'X', hero: 'Y', text: 'z' }] },
      { ...good, changes: [...good.changes, { card: 'A', hero: 'B', text: 'x'.repeat(500) }] },
      { ...good, notes: ['x'.repeat(700)] },
      { ...good, newHeroes: [{}] },
    ]
    for (const b of bad) {
      expect(validateOverlay(b)).toBe(false)
      expect(adoptOverlay(b)).toBe(false)
    }
    expect(notes.OVERLAY.version).toBe(seedVersion)
    expect(seedVersion).toBe(SEED.version)
  })

  test('validates the committed seed itself', () => {
    expect(validateOverlay(OVERLAY)).toBe(true)
  })
})

describe('loadOverlayCache', () => {
  const path = `${process.env.TMPDIR ?? '/tmp'}/bzi-notes-test-${process.pid}.json`
  afterEach(async () => {
    resetOverlay()
    delete process.env.BAZAARINFO_NOTES_CACHE
    try { await Bun.write(path, '') } catch {}
  })

  test('adopts a valid cached parse', async () => {
    process.env.BAZAARINFO_NOTES_CACHE = path
    await Bun.write(path, JSON.stringify({
      version: '19.0', name: 'Cached', date: 'Oct 1', released: '2026-10-01',
      newHeroes: [], notes: [], changes: Array.from({ length: 6 }, (_, i) => ({
        card: `C${i}`, hero: 'Mak', text: 'nerf: cooldown up',
      })),
    }))
    expect(loadOverlayCache()).toBe(true)
    expect(notes.OVERLAY.version).toBe('19.0')
  })

  test('keeps the seed when the cache is corrupt or missing', async () => {
    process.env.BAZAARINFO_NOTES_CACHE = path
    await Bun.write(path, '{ not json')
    expect(loadOverlayCache()).toBe(false)
    expect(notes.OVERLAY.version).toBe(SEED.version)

    process.env.BAZAARINFO_NOTES_CACHE = `${path}.nope`
    expect(loadOverlayCache()).toBe(false)
    expect(notes.OVERLAY.version).toBe(SEED.version)
  })
})
