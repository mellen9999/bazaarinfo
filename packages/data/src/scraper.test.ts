import { describe, expect, it } from 'bun:test'
import { findJsonEnd, extractPageCards, extractMonsters } from './scraper'

describe('findJsonEnd', () => {
  it('finds matching bracket for simple array', () => {
    const text = '[1,2,3]'
    expect(findJsonEnd(text, 0)).toBe(6)
  })

  it('finds matching brace for simple object', () => {
    const text = '{"a":1}'
    expect(findJsonEnd(text, 0)).toBe(6)
  })

  it('handles nested brackets', () => {
    const text = '[[1,[2,3]],4]'
    expect(findJsonEnd(text, 0)).toBe(12)
  })

  it('handles strings with escaped quotes', () => {
    const text = '{"key":"val\\"ue"}'
    expect(findJsonEnd(text, 0)).toBe(text.length - 1)
  })

  it('handles strings with brackets inside', () => {
    const text = '{"a":"[not a bracket]"}'
    expect(findJsonEnd(text, 0)).toBe(text.length - 1)
  })

  it('returns -1 for unmatched bracket', () => {
    expect(findJsonEnd('[1,2', 0)).toBe(-1)
  })

  it('handles offset start position', () => {
    const text = 'prefix[1,2]suffix'
    expect(findJsonEnd(text, 6)).toBe(10)
  })
})

describe('extractPageCards', () => {
  it('extracts cards from RSC payload', () => {
    const card = { Id: 'test-1', Title: { Text: 'Sword' }, Type: 'Item' }
    const rsc = `some prefix "pageCards":[${JSON.stringify(card)}] some suffix`
    const result = extractPageCards(rsc)
    expect(result).toHaveLength(1)
    expect(result[0].Id).toBe('test-1')
  })

  it('returns empty array when no pageCards marker', () => {
    expect(extractPageCards('some random text')).toEqual([])
  })

  it('returns empty array for malformed JSON', () => {
    const rsc = '"pageCards":[{broken json'
    expect(extractPageCards(rsc)).toEqual([])
  })

  it('handles nested objects in cards', () => {
    const card = { Id: 't', Tiers: { Bronze: { attrs: {} } }, Nested: [1, [2, 3]] }
    const rsc = `"pageCards":[${JSON.stringify(card)}]`
    const result = extractPageCards(rsc)
    expect(result).toHaveLength(1)
    expect(result[0].Id).toBe('t')
  })
})

describe('extractMonsters', () => {
  it('extracts monsters from RSC payload', () => {
    const monster = {
      Id: 'mon-1',
      Type: 'CombatEncounter',
      Title: { Text: 'Spider' },
      MonsterMetadata: { day: 3, health: 100, board: [] },
    }
    const rsc = `prefix ${JSON.stringify(monster)} suffix`
    const result = extractMonsters(rsc)
    expect(result).toHaveLength(1)
    expect(result[0].Title.Text).toBe('Spider')
  })

  it('extracts multiple monsters', () => {
    const m1 = { Id: 'a', Type: 'CombatEncounter', Title: { Text: 'A' }, MonsterMetadata: { day: 1, health: 50, board: [] } }
    const m2 = { Id: 'b', Type: 'CombatEncounter', Title: { Text: 'B' }, MonsterMetadata: { day: 2, health: 100, board: [] } }
    const rsc = `${JSON.stringify(m1)} gap ${JSON.stringify(m2)}`
    const result = extractMonsters(rsc)
    expect(result).toHaveLength(2)
  })

  it('returns empty array when no monsters', () => {
    expect(extractMonsters('no combat encounters here')).toEqual([])
  })

  it('skips malformed monster JSON gracefully', () => {
    const rsc = '{"Type":"CombatEncounter" broken json'
    const result = extractMonsters(rsc)
    expect(result).toEqual([])
  })
})
