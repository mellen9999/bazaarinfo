import { describe, expect, it } from 'bun:test'
import { splitAlternates, pickDistinctLenses, LENSES, answerLeaks, answerEchoesTopic } from './ai-trivia'

describe('splitAlternates — fold answer alternates into accept', () => {
  it('splits a parenthetical alternate', () => {
    expect(splitAlternates('Ti (or Si)')).toEqual({ canonical: 'Ti', alts: ['Si'] })
    expect(splitAlternates('Ti (Si)')).toEqual({ canonical: 'Ti', alts: ['Si'] })
  })
  it('splits "/" and " or " forms', () => {
    expect(splitAlternates('Ti / Si')).toEqual({ canonical: 'Ti', alts: ['Si'] })
    expect(splitAlternates('Ti or Si')).toEqual({ canonical: 'Ti', alts: ['Si'] })
  })
  it('leaves a single clean answer untouched', () => {
    expect(splitAlternates('San Francisco')).toEqual({ canonical: 'San Francisco', alts: [] })
    expect(splitAlternates('42')).toEqual({ canonical: '42', alts: [] })
  })
  it('does not split an ampersand name', () => {
    expect(splitAlternates('Mortar & Pestle')).toEqual({ canonical: 'Mortar & Pestle', alts: [] })
  })
})

describe('pickDistinctLenses — best-of-N varied angles per round', () => {
  it('returns k distinct real lenses', () => {
    for (let i = 0; i < 50; i++) {
      const ls = pickDistinctLenses('#lenschan', 3)
      expect(ls.length).toBe(3)
      expect(new Set(ls).size).toBe(3) // all distinct within a round
      for (const l of ls) expect(LENSES).toContain(l)
    }
  })
  it('clamps k to the lens count and always returns at least 1', () => {
    expect(pickDistinctLenses('#clamp', 99).length).toBe(LENSES.length)
    expect(pickDistinctLenses('#clamp', 0).length).toBe(1)
    expect(pickDistinctLenses('#clamp', -5).length).toBe(1)
  })
  it('prefers fresh angles round-to-round (low overlap with the previous round)', () => {
    // with 8 lenses and the recent window, two back-to-back rounds of 3 should not be
    // identical sets — fresh angles are preferred until the pool is exhausted.
    const r1 = new Set(pickDistinctLenses('#freshchan', 3))
    const r2 = new Set(pickDistinctLenses('#freshchan', 3))
    const overlap = [...r2].filter((l) => r1.has(l)).length
    expect(overlap).toBeLessThan(3) // never a full repeat of the prior round
  })
  it('keeps channels independent', () => {
    expect(pickDistinctLenses('#a', 2).every((l) => LENSES.includes(l))).toBe(true)
    expect(pickDistinctLenses('#b', 2).every((l) => LENSES.includes(l))).toBe(true)
  })
})

describe('answerEchoesTopic — the asked topic can never be the answer', () => {
  const mk = (question: string, answer: string, accept: string[] = []) => ({ question, answer, accept })

  it('flags the literal digimon tautology (answer == topic)', () => {
    expect(answerEchoesTopic(mk('What franchise began as a 1997 virtual pet toy?', 'Digimon', ['digimon']), 'digimon')).toBe(true)
  })
  it('flags a topic hiding only in an accept alias', () => {
    expect(answerEchoesTopic(mk('What 1999 series introduced the DigiDestined?', 'Digimon Adventure', ['digimon']), 'digimon')).toBe(true)
  })
  it('flags a near-restatement ("the office" → "office")', () => {
    expect(answerEchoesTopic(mk('...', 'Office', ['office']), 'the office')).toBe(true)
  })
  it('flags singular/plural restatement', () => {
    expect(answerEchoesTopic(mk('...', 'digimon', ['digimon']), 'digimons')).toBe(true)
  })
  it('passes a real fact ABOUT the topic', () => {
    expect(answerEchoesTopic(mk('Which company created Digimon?', 'Bandai', ['bandai']), 'digimon')).toBe(false)
    expect(answerEchoesTopic(mk('What year did the virtual pet launch?', '1997', ['1997']), 'digimon')).toBe(false)
  })
  it('passes a subject answer under a BROAD topic (guess-the-subject stays legal)', () => {
    expect(answerEchoesTopic(mk('What franchise began as a 1997 virtual pet toy?', 'Digimon', ['digimon']), 'anime')).toBe(false)
  })
})

describe('answerLeaks — deterministic giveaway guard', () => {
  const mk = (question: string, answer: string, accept: string[] = []) => ({ question, answer, accept })

  it('flags an answer sitting verbatim in the question', () => {
    expect(answerLeaks(mk("what is Bob Barker's character's first name?", 'Bob', ['bob', 'bob barker']))).toBe(true)
  })
  it('flags an eponym leak hiding in an accepted form', () => {
    // canonical "Raymond Novaco" isn't contiguous in the q, but accepted "novaco" is
    expect(answerLeaks(mk('The Novaco Anger Scale is named after which psychologist?', 'Raymond Novaco', ['novaco', 'raymond novaco']))).toBe(true)
  })
  it('flags a multi-word answer present as a contiguous run', () => {
    expect(answerLeaks(mk('Which bay does the San Francisco peninsula enclose?', 'San Francisco', ['san francisco']))).toBe(true)
  })
  it('passes a clean question where the answer is withheld', () => {
    expect(answerLeaks(mk('What one-word handle is Minecraft\'s creator known by?', 'Notch', ['notch', 'markus persson']))).toBe(false)
    expect(answerLeaks(mk('What is the only bird that can fly backwards?', 'hummingbird', ['the hummingbird']))).toBe(false)
  })
  it('ignores pure-number and tiny answers that recur harmlessly', () => {
    expect(answerLeaks(mk('How many sides does a hexagon have, given it has 6 vertices?', '6', ['6']))).toBe(false)
    expect(answerLeaks(mk('What note is A above middle C tuned to in Hz?', 'A', ['a']))).toBe(false)
  })
  it('does not false-positive on a shared word that is not the answer', () => {
    expect(answerLeaks(mk('What is the name of the innermost of the three walls?', 'Wall Sina', ['wall sina', 'sina']))).toBe(false)
  })
})
