import { describe, expect, it } from 'bun:test'
import { tessellate, separateRows, padVertical } from './tessellate'

const row = (xs: [number, number][], extra: Record<string, unknown> = {}) =>
  xs.map(([x, w]) => ({ x, y: 0.6, w, h: 0.2, owner: 'player', type: 'Item', ...extra }))

// no two zones in the returned set overlap horizontally within a row
function noOverlap(zs: { x: number; w: number; y: number; h: number }[]): boolean {
  const s = [...zs].sort((a, b) => a.x - b.x)
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i].x + s[i].w > s[i + 1].x + 1e-9) return false
  }
  return true
}

describe('tessellate', () => {
  it('returns input untouched for <2 zones', () => {
    const one = row([[0.1, 0.05]])
    expect(tessellate(one)).toBe(one)
    expect(tessellate([])).toEqual([])
  })

  it('fills the gap between two adjacent cards at the midpoint', () => {
    const [a, b] = tessellate(row([[0.10, 0.05], [0.20, 0.05]]))
    // gap was 0.05 (0.15..0.20); each grows 0.025 → meet at 0.175
    expect(a.x + a.w).toBeCloseTo(0.175)
    expect(b.x).toBeCloseTo(0.175)
    expect(noOverlap([a, b])).toBe(true)
  })

  it('never overlaps and leaves the shared boundary seamless', () => {
    const t = tessellate(row([[0.10, 0.05], [0.17, 0.05], [0.24, 0.05]]))
    expect(noOverlap(t)).toBe(true)
    // adjacent zones share an edge (no dead gap) for small gaps
    expect(t[0].x + t[0].w).toBeCloseTo(t[1].x, 5)
    expect(t[1].x + t[1].w).toBeCloseTo(t[2].x, 5)
  })

  it('removes a pre-existing overlap by splitting at the midpoint', () => {
    const [a, b] = tessellate(row([[0.10, 0.08], [0.15, 0.08]]))
    // overlap 0.15..0.18; midpoint of (0.18, 0.15) = 0.165
    expect(a.x + a.w).toBeCloseTo(0.165)
    expect(b.x).toBeCloseTo(0.165)
    expect(noOverlap([a, b])).toBe(true)
  })

  it('caps growth into a huge gap (far-apart cards do not balloon)', () => {
    const [a, b] = tessellate(row([[0.05, 0.05], [0.80, 0.05]]))
    // half-gap 0.35 >> cap 0.05*0.6=0.03, so each grows only 0.03
    expect(a.w).toBeCloseTo(0.08)
    expect(b.x).toBeCloseTo(0.77)
    expect(noOverlap([a, b])).toBe(true)
  })

  it('does not merge across rows (owner/type/vertical band)', () => {
    const mixed = [
      { x: 0.10, y: 0.60, w: 0.05, h: 0.2, owner: 'player', type: 'Item' },
      { x: 0.10, y: 0.13, w: 0.05, h: 0.2, owner: 'opponent', type: 'Item' },
      { x: 0.16, y: 0.60, w: 0.05, h: 0.2, owner: 'player', type: 'Item' },
    ]
    const t = tessellate(mixed)
    // opponent zone untouched (different row, no horizontal neighbor)
    const opp = t.find(z => z.owner === 'opponent')!
    expect(opp.x).toBe(0.10)
    expect(opp.w).toBe(0.05)
    // the two player items tessellated together
    const players = t.filter(z => z.owner === 'player').sort((a, b) => a.x - b.x)
    expect(players[0].x + players[0].w).toBeCloseTo(players[1].x, 5)
  })

  it('padVertical grows y/h by the capped margin, clamped to [0,1]', () => {
    const [z] = padVertical([{ x: 0.1, y: 0.60, w: 0.05, h: 0.20 }], 0.12, 0.03)
    const grow = Math.min(0.20 * 0.12, 0.03) // 0.024
    expect(z.y).toBeCloseTo(0.60 - grow)
    expect(z.h).toBeCloseTo(0.20 + 2 * grow)
  })
  it('padVertical caps growth and never leaves [0,1]', () => {
    const [top] = padVertical([{ x: 0, y: 0.01, w: 0.05, h: 0.5 }], 0.5, 0.05)
    expect(top.y).toBe(0) // clamped, not negative
    const [bot] = padVertical([{ x: 0, y: 0.6, w: 0.05, h: 0.45 }], 0.5, 1)
    expect(bot.y + bot.h).toBeLessThanOrEqual(1 + 1e-9)
  })
  it('padVertical leaves x/w untouched and handles empty', () => {
    const [z] = padVertical([{ x: 0.3, y: 0.5, w: 0.07, h: 0.1 }], 0.12, 0.03)
    expect(z.x).toBe(0.3)
    expect(z.w).toBe(0.07)
    expect(padVertical([], 0.12, 0.03)).toEqual([])
  })

  it('preserves non-positional fields and order', () => {
    const input = row([[0.10, 0.05], [0.20, 0.05]], { title: 'X', tier: 'Gold' })
    const t = tessellate(input)
    expect(t[0].title).toBe('X')
    expect(t[0].tier).toBe('Gold')
    expect(t.length).toBe(2)
    expect(input[0].w).toBe(0.05) // input not mutated
  })
})

// Real geometry the companion ships: both item rows are quoted as socket-panel
// heights, and the panels sit flush, so the raw boxes cross by ~0.011 before any
// padding is applied. These are the numbers from logwatch.py.
const PLAYER_ROW = { y: 0.502838, h: 0.231916, owner: 'player', type: 'Item' }
const OPPONENT_ROW = { y: 0.281485, h: 0.231916, owner: 'opponent', type: 'Item' }

describe('separateRows', () => {
  it('splits an overlapping player/opponent pair at the midpoint', () => {
    const [opp, ply] = separateRows([
      { x: 0.5, w: 0.06, ...OPPONENT_ROW },
      { x: 0.5, w: 0.06, ...PLAYER_ROW },
    ])
    const oppBottom = opp.y + opp.h
    expect(oppBottom).toBeCloseTo(ply.y, 9)
    // split point sits inside the original overlap band, not outside it
    expect(oppBottom).toBeGreaterThan(PLAYER_ROW.y)
    expect(oppBottom).toBeLessThan(OPPONENT_ROW.y + OPPONENT_ROW.h)
  })

  it('leaves same-row neighbours alone', () => {
    const zs = row([[0.10, 0.05], [0.20, 0.05]])
    expect(separateRows(zs)).toEqual(zs)
  })

  it('never grows a zone', () => {
    const before = [{ x: 0.5, w: 0.06, ...OPPONENT_ROW }, { x: 0.5, w: 0.06, ...PLAYER_ROW }]
    for (const [i, z] of separateRows(before).entries()) {
      expect(z.h).toBeLessThanOrEqual(before[i].h + 1e-12)
    }
  })

  it('refuses to trim a row fully swallowed by another', () => {
    const zs = [
      { x: 0.5, w: 0.06, y: 0.2, h: 0.6, owner: 'opponent', type: 'Item' },
      { x: 0.5, w: 0.06, y: 0.4, h: 0.1, owner: 'player', type: 'Item' },
    ]
    expect(separateRows(zs)).toEqual(zs)
  })
})

describe('padVertical row clamp', () => {
  it('cannot pad one row into another', () => {
    const [opp, ply] = padVertical(separateRows([
      { x: 0.5, w: 0.06, ...OPPONENT_ROW },
      { x: 0.5, w: 0.06, ...PLAYER_ROW },
    ]), 0.12, 0.03)
    expect(opp.y + opp.h).toBeLessThanOrEqual(ply.y + 1e-12)
  })

  it('still pads freely when there is nothing above or below', () => {
    const [z] = padVertical([{ x: 0.5, w: 0.06, ...PLAYER_ROW }], 0.12, 0.03)
    const grow = Math.min(PLAYER_ROW.h * 0.12, 0.03)
    expect(z.y).toBeCloseTo(PLAYER_ROW.y - grow, 9)
    expect(z.y + z.h).toBeCloseTo(PLAYER_ROW.y + PLAYER_ROW.h + grow, 9)
  })

  it('lets a same-row neighbour pad by the full amount', () => {
    const zs = row([[0.10, 0.05], [0.20, 0.05]])
    const grow = Math.min(0.2 * 0.12, 0.03)
    for (const z of padVertical(zs, 0.12, 0.03)) {
      expect(z.y).toBeCloseTo(0.6 - grow, 9)
    }
  })
})
