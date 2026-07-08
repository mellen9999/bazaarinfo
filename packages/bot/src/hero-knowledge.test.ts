import { describe, it, expect } from 'bun:test'
import { KNOWLEDGE } from './ai-query'

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
})
