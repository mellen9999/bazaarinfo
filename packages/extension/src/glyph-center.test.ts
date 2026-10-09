import { describe, it, expect } from 'bun:test'
import { inkOffset } from './glyph-center'

// 14px font, ascent 13 / descent 4: content area 17 > 14, half-leading -1.5
const base = { adv: 8.4, left: 0, right: 8.4, asc: 8, desc: 0, fAsc: 13, fDesc: 4 }

describe('inkOffset', () => {
  it('a glyph already centred needs no nudge', () => {
    // baseline = 13 + floor((14-17)/2) = 11; ink 3..11 is centred on 7
    const o = inkOffset(base, 14)
    expect(o.y).toBeCloseTo(0, 6)
    expect(o.x).toBeCloseTo(0, 6)
  })

  it('ink riding high moves down, sitting low moves up', () => {
    expect(inkOffset({ ...base, asc: 12 }, 14).y).toBeGreaterThan(0)
    expect(inkOffset({ ...base, asc: 4 }, 14).y).toBeLessThan(0)
  })

  it('ink left of its cell centre moves right, right of it moves left', () => {
    expect(inkOffset({ ...base, left: 0, right: 5 }, 14).x).toBeGreaterThan(0)
    expect(inkOffset({ ...base, left: 3, right: 8.4 }, 14).x).toBeGreaterThan(0)
    expect(inkOffset({ ...base, left: -3, right: 8.4 }, 14).x).toBeLessThan(0)
  })

  it('is in em and lands the ink centre on the box centre', () => {
    const m = { adv: 8, left: 1, right: 7, asc: 6, desc: 1, fAsc: 13, fDesc: 4 }
    const o = inkOffset(m, 16)
    const baseline = 13 + Math.floor((16 - 17) / 2)
    expect(baseline - (6 - 1) / 2 + o.y * 16).toBeCloseTo(8, 6)
    // box as wide as the advance: ink centre is origin + (right-left)/2
    expect((7 - 1) / 2 + o.x * 16).toBeCloseTo(4, 6)
  })

  it('never returns NaN and zeroes out on missing metrics', () => {
    expect(inkOffset({ adv: NaN, left: NaN, right: NaN, asc: NaN, desc: NaN, fAsc: NaN, fDesc: NaN }, 14)).toEqual({ x: 0, y: 0 })
    expect(inkOffset(base, 0)).toEqual({ x: 0, y: 0 })
    expect(inkOffset({ ...base, fAsc: 0, fDesc: 0 }, 14)).toEqual({ x: 0, y: 0 })
    const o = inkOffset({ ...base, adv: Infinity }, 14)
    expect(Number.isFinite(o.x) && Number.isFinite(o.y)).toBe(true)
  })
})
