// "runic glaive" got "scales off burn count stacked on the enemy" and "Ice water" got
// "confirmed, Ice Water - that's your slow/regen Jules item": both card-shaped, neither a
// card. the dump knows that, so the prompt gets told — and "flying carpets aren't an item"
// (Magic Carpet exists) is the inverse, caught after the fact.
import { describe, it, expect, beforeAll } from 'bun:test'
import { initDb } from './db'
import { loadStore, isMissingCardName, cardsWithWord, findCard } from './store'
import { buildUserMessage } from './ai-build'
import { findFalseDenials } from './ai-verify'

beforeAll(async () => { initDb(':memory:'); await loadStore() })

const ctx = { user: 'tester', channel: '#cardmiss-test' }

describe('isMissingCardName', () => {
  it.each(['runic glaive', 'Ice water', 'flying carpet'])('card-shaped, no card: %s', (q) => expect(isMissingCardName(q)).toBe(true))
  it.each(['Magic Carpet', 'Runic Blade', 'krippo', 'vanilla', 'good bot', 'nerf jules', 'is boomerang good', 'wollip'])('not flagged: %s', (q) => expect(isMissingCardName(q)).toBe(false))
})

describe('cardMiss section', () => {
  it('tells the model the card does not exist', () => {
    const out = buildUserMessage('runic glaive', ctx)
    expect(out.text).toContain('no Bazaar card or skill is named "runic glaive"')
    expect(out.contextSections.some((s) => s.name === 'cardMiss')).toBe(true)
  })
  it('stays out of a real card ask and of chat', () => {
    expect(buildUserMessage('magic carpet', ctx).text).not.toContain('Card lookup:')
    expect(buildUserMessage('krippo', ctx).text).not.toContain('Card lookup:')
  })
})

describe('findFalseDenials', () => {
  const CTX = 'Game data:\nMagic Carpet (Mak, Large) — Flying.\n---\n[USER]: do frauds have flying carpets?'
  const deny = (t: string, c = CTX) => findFalseDenials(t, c, cardsWithWord, (n) => !!findCard(n))
  it('a card title denied outright', () => {
    expect(deny("boomerang isn't an item", '')).toContain('boomerang is a real card')
  })
  it('names the real card behind a denial', () => {
    expect(deny("flying carpets aren't an item, no. frauds get regular vehicles like anyone else")).toContain('Magic Carpet is a real card')
  })
  it('leaves true denials alone', () => {
    expect(deny("gold isn't an item, it's a resource")).toEqual([])
    expect(deny("that isn't a card, it's an emote")).toEqual([])
    expect(deny('runic glaive is not a card, closest is runic blade')).toEqual([])
    expect(deny("flying carpets aren't an item", '[USER]: do frauds have flying carpets?')).toEqual([])
  })
})
