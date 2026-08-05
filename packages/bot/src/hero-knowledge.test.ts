import { describe, it, test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { KNOWLEDGE } from './ai-query'

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/items.json')

// Every playable hero must have a grounded KNOWLEDGE entry so "what does X do"
// injects real archetype context instead of the model vibing (hallucination-prone).
// If the game adds a hero, add its entry AND a row here.
const HEROES: Array<[string, string[]]> = [
  ['Vanessa', ['what does vanessa do', 'vanessa', 'is vanessa good']],
  ['Dooley', ['who is dooley', 'dooley', 'how do dooley cores work']],
  ['Pygmalien', ['tell me about pygmalien', 'pyg', 'pygmalion build']],
  ['Mak', ['what does mak do', 'mak', 'mak poison']],
  ['Jules', ['whats jules', 'jules', 'jules heated']],
  ['Stelle', ['what does stelle do', 'stelle', 'stelle flying']],
  ['Karnok', ['what does karnok do', 'karnok', 'karnok rage']],
]

function match(query: string): string | null {
  for (const [re, text] of KNOWLEDGE) if (re.test(query)) return text
  return null
}

describe('hero KNOWLEDGE coverage', () => {
  for (const [hero, phrasings] of HEROES) {
    it(`grounds ${hero}`, () => {
      for (const q of phrasings) {
        const hit = match(q)
        expect(hit, `no KNOWLEDGE match for "${q}"`).not.toBeNull()
        // the matched entry must actually be about this hero (name in the text)
        expect(hit!.toLowerCase()).toContain(hero.toLowerCase().slice(0, 4))
      }
    })
  }

  it('does not false-match "make" to Mak', () => {
    expect(match('make me a build') ?? '').not.toContain('Mak:')
  })

  // CI tripwire: if a real cache is present (dev/prod machines — gitignored, absent in
  // CI proper), confirm every hero the dump actually knows about has SOME KNOWLEDGE
  // match. Catches a new hero shipping with no grounded entry before chat does.
  test.skipIf(!existsSync(CACHE_PATH))('every hero in cache/items.json matches a KNOWLEDGE entry', async () => {
    const cache = await Bun.file(CACHE_PATH).json()
    const FAKE_HEROES = new Set(['???', 'Common'])
    const heroSet = new Set<string>()
    for (const card of [...(cache.items ?? []), ...(cache.skills ?? [])]) {
      for (const h of card.Heroes ?? []) if (!FAKE_HEROES.has(h)) heroSet.add(h)
    }
    expect(heroSet.size).toBeGreaterThan(0)
    for (const hero of heroSet) {
      expect(match(hero), `no KNOWLEDGE match for hero "${hero}"`).not.toBeNull()
    }
  })
})
