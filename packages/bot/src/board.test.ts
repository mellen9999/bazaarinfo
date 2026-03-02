import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { getBoardState, getBoardCooldown, formatBoard, _reset } from './board'
import type { BoardState } from './board'

beforeEach(() => {
  _reset()
})

describe('getBoardCooldown', () => {
  test('returns 0 initially', () => {
    expect(getBoardCooldown('testchannel')).toBe(0)
  })

  test('case insensitive', () => {
    expect(getBoardCooldown('TestChannel')).toBe(0)
  })
})

describe('getBoardState', () => {
  test('returns null before any capture', () => {
    expect(getBoardState('testchannel')).toBeNull()
  })

  test('case insensitive', () => {
    expect(getBoardState('TestChannel')).toBeNull()
  })
})

describe('formatBoard', () => {
  test('formats player items with hero', () => {
    const state: BoardState = {
      hero: 'Vanessa',
      playerItems: [
        { name: 'Teddy Bear', matched: true, tier: 'Gold' },
        { name: 'Infernal Blade', matched: true, tier: 'Silver' },
        { name: 'Orange Julian', matched: true },
      ],
      opponentItems: [],
      capturedAt: Date.now(),
      channel: 'test',
    }
    const result = formatBoard(state)
    expect(result).toBe('[Vanessa] 🎮 Teddy Bear(G), Infernal Blade(S), Orange Julian')
  })

  test('formats with opponent count', () => {
    const state: BoardState = {
      playerItems: [{ name: 'Teddy Bear', matched: true }],
      opponentItems: [
        { name: 'Sword', matched: true },
        { name: 'Shield', matched: true },
        { name: 'Potion', matched: false },
      ],
      capturedAt: Date.now(),
      channel: 'test',
    }
    const result = formatBoard(state)
    expect(result).toBe('🎮 Teddy Bear | opp: 3 items')
  })

  test('no hero, no opponent', () => {
    const state: BoardState = {
      playerItems: [{ name: 'Lemonade', matched: true, tier: 'Bronze' }],
      opponentItems: [],
      capturedAt: Date.now(),
      channel: 'test',
    }
    expect(formatBoard(state)).toBe('🎮 Lemonade(B)')
  })

  test('all tier initials', () => {
    const state: BoardState = {
      playerItems: [
        { name: 'A', matched: true, tier: 'Bronze' },
        { name: 'B', matched: true, tier: 'Silver' },
        { name: 'C', matched: true, tier: 'Gold' },
        { name: 'D', matched: true, tier: 'Diamond' },
        { name: 'E', matched: true, tier: 'Legendary' },
      ],
      opponentItems: [],
      capturedAt: Date.now(),
      channel: 'test',
    }
    expect(formatBoard(state)).toBe('🎮 A(B), B(S), C(G), D(D), E(L)')
  })

  test('fits under 480 chars with max items', () => {
    const state: BoardState = {
      hero: 'Pygmalien',
      playerItems: Array.from({ length: 10 }, (_, i) => ({
        name: `Really Long Item Name ${i}`,
        matched: true,
        tier: 'Gold' as const,
      })),
      opponentItems: Array.from({ length: 10 }, (_, i) => ({
        name: `Opp Item ${i}`,
        matched: true,
      })),
      capturedAt: Date.now(),
      channel: 'test',
    }
    const result = formatBoard(state)
    expect(result.length).toBeLessThanOrEqual(480)
  })
})
