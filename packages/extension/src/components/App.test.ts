import { describe, expect, it, afterEach } from 'bun:test'
import { makeSlotValidator, slotsEqual, computeOverlayRect, parseAspect } from './App'

// These four are the validators standing directly on the PubSub broadcast input
// path (see the compatibility-contract comment on onBroadcast in App.tsx) — a
// hostile or malformed frame reaching them must fail closed, never throw or
// silently coerce.

const baseSlot = () => ({ title: 'Toaster', tier: 'Gold', x: 0.1, y: 0.1, w: 0.05, h: 0.05 })
const validTiers = new Set(['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'])

describe('makeSlotValidator', () => {
  const isValid = makeSlotValidator(validTiers)

  it('accepts a well-formed slot', () => {
    expect(isValid(baseSlot())).toBe(true)
  })

  it('accepts well-formed optional fields', () => {
    expect(isValid({ ...baseSlot(), owner: 'opponent', type: 'Item', enchantment: 'Heavy', tierKnown: true })).toBe(true)
  })

  it('rejects non-objects', () => {
    expect(isValid(null)).toBe(false)
    expect(isValid(undefined)).toBe(false)
    expect(isValid('slot')).toBe(false)
    expect(isValid(42)).toBe(false)
    expect(isValid(true)).toBe(false)
  })

  it('rejects a missing, empty, wrong-typed, or oversized title', () => {
    const { title: _title, ...rest } = baseSlot()
    expect(isValid(rest)).toBe(false)
    expect(isValid({ ...baseSlot(), title: '' })).toBe(false)
    expect(isValid({ ...baseSlot(), title: 123 })).toBe(false)
    expect(isValid({ ...baseSlot(), title: 'x'.repeat(81) })).toBe(false)
    expect(isValid({ ...baseSlot(), title: 'x'.repeat(80) })).toBe(true)
  })

  it('rejects an unrecognised, wrong-typed, or empty tier', () => {
    expect(isValid({ ...baseSlot(), tier: 'Wood' })).toBe(false)
    expect(isValid({ ...baseSlot(), tier: '' })).toBe(false)
    expect(isValid({ ...baseSlot(), tier: 7 })).toBe(false)
    expect(isValid({ ...baseSlot(), tier: null })).toBe(false)
  })

  it('falls back to the built-in tier set when the dump has not loaded yet', () => {
    const isValidDefault = makeSlotValidator(new Set())
    expect(isValidDefault({ ...baseSlot(), tier: 'Gold' })).toBe(true)
    expect(isValidDefault({ ...baseSlot(), tier: 'NotATier' })).toBe(false)
  })

  it('rejects non-finite, missing, or wrong-typed coordinates', () => {
    for (const field of ['x', 'y', 'w', 'h'] as const) {
      expect(isValid({ ...baseSlot(), [field]: NaN })).toBe(false)
      expect(isValid({ ...baseSlot(), [field]: Infinity })).toBe(false)
      expect(isValid({ ...baseSlot(), [field]: -Infinity })).toBe(false)
      expect(isValid({ ...baseSlot(), [field]: '0.1' })).toBe(false)
      expect(isValid({ ...baseSlot(), [field]: null })).toBe(false)
      const { [field]: _omit, ...rest } = baseSlot()
      expect(isValid(rest)).toBe(false)
    }
  })

  it('rejects out-of-range x/y', () => {
    expect(isValid({ ...baseSlot(), x: -0.01 })).toBe(false)
    expect(isValid({ ...baseSlot(), x: 1.01 })).toBe(false)
    expect(isValid({ ...baseSlot(), y: -0.01 })).toBe(false)
    expect(isValid({ ...baseSlot(), y: 1.01 })).toBe(false)
    expect(isValid({ ...baseSlot(), x: 0, y: 0 })).toBe(true) // touches the edge
  })

  it('rejects zero, negative, or out-of-range w/h', () => {
    expect(isValid({ ...baseSlot(), w: 0 })).toBe(false)
    expect(isValid({ ...baseSlot(), w: -0.1 })).toBe(false)
    expect(isValid({ ...baseSlot(), w: 1.01 })).toBe(false)
    expect(isValid({ ...baseSlot(), h: 0 })).toBe(false)
  })

  it('rejects a zone big enough to blanket the board', () => {
    // a hostile/buggy whole-board bbox — 0.6*0.6 = 0.36 > the 0.2 cap
    expect(isValid({ ...baseSlot(), w: 0.6, h: 0.6 })).toBe(false)
    // just under the cap and still in-range stays valid
    expect(isValid({ ...baseSlot(), w: 0.4, h: 0.4 })).toBe(true)
  })

  it('rejects malformed optional fields', () => {
    expect(isValid({ ...baseSlot(), owner: 123 })).toBe(false)
    expect(isValid({ ...baseSlot(), owner: 'x'.repeat(51) })).toBe(false)
    expect(isValid({ ...baseSlot(), type: 123 })).toBe(false)
    expect(isValid({ ...baseSlot(), enchantment: 'x'.repeat(51) })).toBe(false)
    expect(isValid({ ...baseSlot(), tierKnown: 'yes' })).toBe(false)
  })
})

describe('slotsEqual', () => {
  it('is true for equal-content arrays with different identities', () => {
    expect(slotsEqual([baseSlot() as any], [{ ...baseSlot() } as any])).toBe(true)
  })

  it('is true for two empty arrays', () => {
    expect(slotsEqual([], [])).toBe(true)
  })

  it('is false when lengths differ', () => {
    expect(slotsEqual([baseSlot() as any], [])).toBe(false)
  })

  it('is false when any tracked field differs', () => {
    expect(slotsEqual([baseSlot() as any], [{ ...baseSlot(), tier: 'Diamond' } as any])).toBe(false)
    expect(slotsEqual([baseSlot() as any], [{ ...baseSlot(), x: 0.2 } as any])).toBe(false)
    expect(slotsEqual([baseSlot() as any], [{ ...baseSlot(), owner: 'opponent' } as any])).toBe(false)
    expect(slotsEqual([baseSlot() as any], [{ ...baseSlot(), tierKnown: true } as any])).toBe(false)
  })
})

describe('computeOverlayRect', () => {
  afterEach(() => {
    delete (globalThis as any).window
  })

  const setViewport = (w: number, h: number) => {
    (globalThis as any).window = { innerWidth: w, innerHeight: h }
  }

  it('returns the full frame when it already matches the aspect', () => {
    setViewport(1600, 900)
    expect(computeOverlayRect(16 / 9)).toEqual({ left: 0, top: 0, width: 1600, height: 900 })
  })

  it('pillarboxes (centers horizontally) when the frame is wider than the aspect', () => {
    setViewport(2000, 900)
    const r = computeOverlayRect(16 / 9)
    expect(r.height).toBe(900)
    expect(r.width).toBeCloseTo(1600)
    expect(r.left).toBeCloseTo(200)
    expect(r.top).toBe(0)
  })

  it('letterboxes (centers vertically) when the frame is taller than the aspect', () => {
    setViewport(1600, 1200)
    const r = computeOverlayRect(16 / 9)
    expect(r.width).toBe(1600)
    expect(r.height).toBeCloseTo(900)
    expect(r.top).toBeCloseTo(150)
    expect(r.left).toBe(0)
  })

  it('falls back to the raw frame for a non-finite or non-positive aspect', () => {
    setViewport(1600, 900)
    for (const bad of [NaN, 0, -1, Infinity, -Infinity]) {
      expect(computeOverlayRect(bad)).toEqual({ left: 0, top: 0, width: 1600, height: 900 })
    }
  })

  it('falls back safely when the viewport is unmeasured', () => {
    setViewport(0, 0)
    expect(computeOverlayRect(16 / 9)).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})

describe('parseAspect', () => {
  it('parses a WxH resolution string', () => {
    expect(parseAspect('1920x1080')).toBeCloseTo(16 / 9)
    expect(parseAspect('1920 x 1080')).toBeCloseTo(16 / 9)
  })

  it('returns null for undefined, empty, or malformed input', () => {
    expect(parseAspect(undefined)).toBeNull()
    expect(parseAspect('')).toBeNull()
    expect(parseAspect('garbage')).toBeNull()
    expect(parseAspect('1920x')).toBeNull()
    expect(parseAspect('x1080')).toBeNull()
    expect(parseAspect('1920,1080')).toBeNull()
    expect(parseAspect('1920x1080x60')).toBeNull()
  })

  it('rejects zero or negative dimensions', () => {
    expect(parseAspect('0x1080')).toBeNull()
    expect(parseAspect('1920x0')).toBeNull()
    expect(parseAspect('-1920x1080')).toBeNull()
  })
})
