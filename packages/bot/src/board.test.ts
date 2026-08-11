import { describe, it, expect } from 'bun:test'
import { isBoardQuery, getBoardLine, __setBoardCacheForTest } from './board'

describe('isBoardQuery', () => {
  it('matches board/build-shaped asks', () => {
    expect(isBoardQuery("what's on his board")).toBe(true)
    expect(isBoardQuery('rate this build')).toBe(true)
    expect(isBoardQuery('what is kripp running')).toBe(true)
    expect(isBoardQuery("what's he rocking today")).toBe(true)
    expect(isBoardQuery('whats his loadout')).toBe(true)
    expect(isBoardQuery('current item setup?')).toBe(true)
  })

  it('ignores unrelated chat', () => {
    expect(isBoardQuery('bubble gum stats')).toBe(false)
    expect(isBoardQuery('my game keeps running slow')).toBe(false)
    expect(isBoardQuery('when is he streaming next')).toBe(false)
    expect(isBoardQuery('what a play')).toBe(false)
  })
})

describe('getBoardLine', () => {
  const card = (title: string, owner = 'player', type = 'Item') => ({ title, owner, type })

  it('formats items, skills, and the opponent, with the honesty instruction', () => {
    __setBoardCacheForTest('kripp', {
      cards: [card('Bubble Gum'), card('Bubble Gum'), card('Toaster'), card('Sharpening Stone', 'player', 'Skill'), card('Fang', 'opponent')],
      ageMs: 30_000,
    })
    const line = getBoardLine('kripp')
    expect(line).toContain('Bubble Gum x2')
    expect(line).toContain('Toaster')
    expect(line).toContain('skills: Sharpening Stone')
    expect(line).toContain('Opponent this fight: Fang')
    expect(line).toContain('tiers/enchantments are NOT known')
  })

  it('is empty with no snapshot, an empty board, or a stale one', () => {
    __setBoardCacheForTest('nobody', null)
    expect(getBoardLine('nobody')).toBe('')
    __setBoardCacheForTest('empty', { cards: [], ageMs: 1_000 })
    expect(getBoardLine('empty')).toBe('')
    __setBoardCacheForTest('stale', { cards: [card('Toaster')], ageMs: 11 * 60_000 })
    expect(getBoardLine('stale')).toBe('')
  })

  it('ambient framing carries the dont-force instruction and the echo-catchable head', () => {
    __setBoardCacheForTest('kripp', { cards: [card('Toaster')], ageMs: 5_000 })
    const line = getBoardLine('kripp', true)
    expect(line.startsWith('Live board (')).toBe(true)
    expect(line).toContain('never force a board mention')
    expect(line).toContain('Toaster')
  })

  it('caps runaway card lists without cutting the instruction', () => {
    __setBoardCacheForTest('big', {
      cards: Array.from({ length: 50 }, (_, i) => card(`Extremely Long Card Name Number ${i}`)),
      ageMs: 1_000,
    })
    const line = getBoardLine('big')
    expect(line.length).toBeLessThan(600)
    expect(line).toContain('never state or guess them')
  })
})
