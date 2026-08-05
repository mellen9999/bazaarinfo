import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { clean, condense, parseDate, parsePatchDoc, pickLatest } from './patch-parse'

// the real published 17.0 document — a format change upstream should fail this file,
// not degrade quietly in production
const DOC = readFileSync(resolve(import.meta.dir, '../data/fixtures/patch-notes-17.0.md'), 'utf8')

const HEROES = ['Dooley', 'Jules', 'Karnok', 'Mak', 'Pygmalien', 'Stelle', 'Vanessa']
// a slice of real card/skill/monster/encounter titles, spelled as the card database does
const TITLES = [
  'Katana', 'Solar Drone', 'Dragon Tooth', 'Utility Belt', 'Yerdan', 'Ghost Pepper',
  'Bloodthirst', 'Burning Temper', 'Expert Pilot', 'Hypergreens', 'Premium Piggles',
  'Riceballer', 'Skyscraper', 'Spacescraper', 'Sponsored Apparel', 'Streaming Setup',
  'Tournament Arena', 'Yo-Yo', 'Squirrel Suit', 'Cosmic Amulet', 'Piano', 'Barrel',
]

const parsed = parsePatchDoc(DOC, HEROES, TITLES)!
const change = (card: string) => parsed.changes.find((c) => c.card === card)

describe('helpers', () => {
  test('clean strips markup and decodes entities', () => {
    expect(clean('<li>Deal <span class="tag">20</span> &amp; heal</li>')).toBe('Deal 20 & heal')
    expect(clean('a\n\t  b')).toBe('a b')
  })

  test('condense normalizes patch-note phrasing', () => {
    expect(condense('Base Shield [30/60/120] (from [40/80/160])')).toBe('Base Shield 30/60/120 (was 40/80/160)')
    expect(condense('CD 6 (from 8).')).toBe('CD 6 (was 8)')
    expect(condense('Gained a new setup:')).toBe('Gained a new setup')
  })

  test('condense leaves prose "from" alone', () => {
    expect(condense('Sells items from the Dragons')).toContain('from the Dragons')
  })

  test('parseDate handles the published format', () => {
    expect(parseDate(' August 5, 2026')).toEqual({ released: '2026-08-05', date: 'Aug 5' })
    expect(parseDate('December 25 2026')).toEqual({ released: '2026-12-25', date: 'Dec 25' })
    expect(parseDate('sometime soon')).toBeNull()
  })
})

describe('pickLatest', () => {
  const manifest = [
    { version: '16.0', date: '2026-07-01', translations: { English: '/docs/pn/v16.0/en.md' } },
    { version: '17.0', date: '2026-08-05', translations: { English: '/docs/pn/v17.0/en.md' } },
    { version: '9.1', date: '2026-01-01', translations: { English: '/docs/pn/v9.1/en.md' } },
  ]

  test('picks the highest version, not the first or last', () => {
    expect(pickLatest(manifest)).toEqual({ version: '17.0', path: '/docs/pn/v17.0/en.md' })
  })

  test('sorts numerically, not lexically', () => {
    expect(pickLatest([manifest[2], { ...manifest[0], version: '10.0' }])?.version).toBe('10.0')
  })

  test('rejects junk', () => {
    expect(pickLatest(null)).toBeNull()
    expect(pickLatest([])).toBeNull()
    expect(pickLatest([{ version: 'latest', translations: {} }])).toBeNull()
  })

  test('falls back to another language when English is missing', () => {
    expect(pickLatest([{ version: '1.0', date: 'x', translations: { Francais: '/fr.md' } }])?.path).toBe('/fr.md')
  })
})

describe('parsePatchDoc on the published 17.0 notes', () => {
  test('reads the header', () => {
    expect(parsed.version).toBe('17.0')
    expect(parsed.name).toBe('Roughtown Rockstars')
    expect(parsed.date).toBe('Aug 5')
    expect(parsed.released).toBe('2026-08-05')
  })

  test('finds the whole change list', () => {
    expect(parsed.changes.length).toBeGreaterThan(100)
    expect(parsed.emptySections).toEqual([])
  })

  test('attributes item changes to the hero whose section they are in', () => {
    expect(change('Katana')).toMatchObject({ hero: 'Vanessa' })
    expect(change('Solar Drone')).toMatchObject({ hero: 'Stelle' })
    expect(change('Katana')!.text).toBe('Damage 15/30/60/120 (was 8/16/32/64)')
  })

  test('captures skills, which are bare groups rather than item rows', () => {
    expect(change('Bloodthirst')).toMatchObject({ hero: 'Mak' })
    expect(change('Burning Temper')!.text).toContain('5/10/15/20 Burn')
  })

  test('splits a shared heading into one entry per name', () => {
    for (const m of ['Chronos', 'Cobweb', 'Freiya', 'Hef', 'Knightshade']) {
      expect(parsed.changes.find((c) => c.card === m)?.text).toContain('spawn the right amount')
    }
  })

  test('marks monsters and encounters instead of a hero', () => {
    expect(change('Yerdan')).toMatchObject({ hero: 'Monster' })
    expect(change('Ghost Pepper')).toMatchObject({ hero: 'Monster' })
  })

  test('resolves naming drift to the card database spelling', () => {
    // the notes say "Dragon's Tooth"; the database says "Dragon Tooth"
    expect(change('Dragon Tooth')).toBeDefined()
    expect(parsed.changes.some((c) => c.card === "Dragon's Tooth")).toBe(false)
    expect(parsed.unmatchedCards).not.toContain('Dragon Tooth')
  })

  test('expands a lead-in followed by a bare list of card names', () => {
    for (const c of ['Hypergreens', 'Premium Piggles', 'Riceballer']) {
      expect(change(c)?.text).toContain('golden enchants')
      expect(change(c)?.hero).toBe('Pygmalien')
    }
  })

  test('never re-attributes a monster board to the items on it', () => {
    // Yerdan lists "Gained a new setup:" then its board — those items are not changed
    expect(change('Tournament Arena')).toBeUndefined()
    expect(change('Yo-Yo')).toBeUndefined()
    expect(change('Yerdan')!.text).toContain('Diamond-tier')
  })

  test('detects a new hero from the new-content prose', () => {
    expect(parsed.newHeroes).toEqual(['The Dragons'])
  })

  test('keeps new-content rows as notes, never as card changes', () => {
    expect(parsed.changes.some((c) => /Equipment Van|Uitar Center|Mama Bear/.test(c.card))).toBe(false)
    expect(parsed.notes.some((n) => n.includes('Uitar Center'))).toBe(true)
  })

  test('collects readable notes', () => {
    expect(parsed.notes.length).toBeGreaterThan(8)
    expect(parsed.notes.some((n) => /800/.test(n))).toBe(true) // max health cap
    expect(parsed.notes.every((n) => n.length < 600)).toBe(true)
  })

  test('every change fits beside a card in a 480-char reply', () => {
    for (const c of parsed.changes) {
      expect(c.text.length).toBeLessThanOrEqual(240)
      expect(c.text.length).toBeGreaterThan(3)
      expect(c.card).not.toContain('<')
      expect(c.text).not.toContain('<')
    }
  })

  test('reports names it could not resolve rather than hiding them', () => {
    // with a partial title list most names are unmatched — the point is they are surfaced
    expect(parsed.unmatchedCards.length).toBeGreaterThan(0)
    expect(parsed.unmatchedCards).toContain('Likit')
  })

  test('returns null on a document it cannot read', () => {
    expect(parsePatchDoc('<h3>Nope</h3><p>no header here</p>', HEROES)).toBeNull()
    expect(parsePatchDoc('', HEROES)).toBeNull()
  })
})
