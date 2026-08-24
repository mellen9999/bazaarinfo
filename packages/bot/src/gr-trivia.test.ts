import { describe, expect, it, beforeEach } from 'bun:test'
import { __setGrCards, type GrCard } from './guildrun'
import {
  GR_GENERATORS, grTriviaReady,
  genGrClassQuestion, genGrGuildQuestion, genGrHeroHpQuestion,
  genGrRelicTextQuestion, genGrKeywordQuestion, genGrSpecQuestion,
} from './gr-trivia'

// Deterministic guildrun rounds hold the same bar as every other generator family:
// one crisp answer, never visible in its own question, no multi-answer questions.

const CARDS: GrCard[] = [
  { n: 'Irini', k: 'hero', c: 'Duelist', g: 'Sporty', st: '650 HP, 31 base hit', sp: ['The Electric: shocks.', 'The Mighty: might.'] },
  { n: 'Kai', k: 'hero', c: 'Warrior', g: 'Iron Pact', st: '900 HP', sp: ['The Bold: bold.'] },
  { n: 'Tilly', k: 'hero', c: 'Warrior/Duelist', g: 'Sporty', st: '750 HP' },
  { n: 'Shard Maximizer', k: 'relic', r: 'unique', x: 'Gain 2 extra Shards at the end of every combat round.' },
  { n: 'Momentum Engine', k: 'relic', r: 'unique', x: 'Your heroes gain 40 Attack Speed for each Duelist fielded.' },
]

beforeEach(() => __setGrCards(CARDS))

describe('gr trivia generators', () => {
  it('class question skips dual-class heroes — two right answers is zero fair ones', () => {
    for (let i = 0; i < 60; i++) {
      const q = genGrClassQuestion()
      if (!q) continue
      expect(q.question).not.toContain('Tilly')
      expect(['Duelist', 'Warrior']).toContain(q.answer)
    }
  })

  it('guild question answers from the real guild field', () => {
    let q = null
    for (let i = 0; i < 40 && !q; i++) q = genGrGuildQuestion()
    expect(q).not.toBeNull()
    expect(['Sporty', 'Iron Pact']).toContain(q!.answer)
  })

  it('hero hp question parses the stat line and stays typeable', () => {
    let q = null
    for (let i = 0; i < 40 && !q; i++) q = genGrHeroHpQuestion()
    expect(q).not.toBeNull()
    expect(['650', '900', '750']).toContain(q!.answer)
    expect(q!.accepted).toContain(`${q!.answer} hp`)
  })

  it('relic text question never uses a text with an unstated "X" number', () => {
    __setGrCards([
      ...CARDS,
      { n: 'Vague Relic', k: 'relic', x: 'Gain X (scales with Attack) damage every second of combat.' },
    ])
    for (let i = 0; i < 80; i++) {
      const q = genGrRelicTextQuestion()
      if (q) expect(q.answer).not.toBe('Vague Relic')
    }
  })

  it('keyword question comes from the curated glossary with aliases accepted', () => {
    let seen = 0
    for (let i = 0; i < 80; i++) {
      const q = genGrKeywordQuestion()
      if (!q) continue
      seen++
      expect(q.question).toContain('Guildrun mechanic')
      expect(q.accepted).toContain(q.answer)
      // leak-freedom is asserted on GR_GENERATORS below — the guarded layer trivia.ts
      // actually registers (the raw generator may emit "stuns"→Stun; the guard nulls it)
    }
    expect(seen).toBeGreaterThan(0)
  })

  it('keyword question never asks about a mechanic that is not in the game', () => {
    for (let i = 0; i < 120; i++) {
      const q = genGrKeywordQuestion()
      if (q) expect(['Bleed', 'Damage Amp']).not.toContain(q.answer)
    }
  })

  it('spec question maps a unique spec name to its one hero', () => {
    let q = null
    for (let i = 0; i < 60 && !q; i++) q = genGrSpecQuestion()
    expect(q).not.toBeNull()
    expect(['Irini', 'Kai']).toContain(q!.answer)
    expect(q!.question).not.toContain(q!.answer)
  })

  it('every generator obeys the universal free-win guard', () => {
    for (const gen of GR_GENERATORS) {
      for (let i = 0; i < 40; i++) {
        const q = gen()
        if (!q) continue
        const hay = q.question.toLowerCase()
        expect(hay.includes(q.answer.toLowerCase()), `${gen.name} leaked its answer`).toBe(false)
      }
    }
  })

  it('readiness requires the fetched card set, not just the built-in keywords', () => {
    expect(grTriviaReady()).toBe(true)
    __setGrCards([])
    expect(grTriviaReady()).toBe(false)
  })
})
