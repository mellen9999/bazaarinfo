import { describe, expect, it } from 'bun:test'
import { IDENTITY_CROP, isValidCrop, clampCrop, parseCrop, serializeCrop, applyCrop, isIdentityCrop } from './viewport'

const slot = { x: 0.2, y: 0.6, w: 0.05, h: 0.2, title: 'a', tier: 'Gold' }

describe('isValidCrop', () => {
  it('accepts identity and in-bounds boxes', () => {
    expect(isValidCrop(IDENTITY_CROP)).toBe(true)
    expect(isValidCrop({ x: 0.1, y: 0.1, scale: 0.7 })).toBe(true)
    expect(isValidCrop({ x: 0.3, y: 0, scale: 0.7 })).toBe(true) // touches right edge
  })
  it('rejects boxes that leave the player', () => {
    expect(isValidCrop({ x: 0.5, y: 0, scale: 0.7 })).toBe(false) // 0.5+0.7>1
    expect(isValidCrop({ x: 0, y: 0.9, scale: 0.7 })).toBe(false)
    expect(isValidCrop({ x: -0.1, y: 0, scale: 0.5 })).toBe(false)
  })
  it('rejects bad scale and non-finite', () => {
    expect(isValidCrop({ x: 0, y: 0, scale: 0 })).toBe(false)
    expect(isValidCrop({ x: 0, y: 0, scale: 0.01 })).toBe(false) // below MIN_SCALE
    expect(isValidCrop({ x: 0, y: 0, scale: 1.2 })).toBe(false)
    expect(isValidCrop({ x: NaN, y: 0, scale: 0.5 })).toBe(false)
    expect(isValidCrop({ x: 0, y: Infinity, scale: 0.5 })).toBe(false)
  })
  it('rejects non-objects', () => {
    expect(isValidCrop(null)).toBe(false)
    expect(isValidCrop('x')).toBe(false)
    expect(isValidCrop(undefined)).toBe(false)
  })
})

describe('clampCrop', () => {
  it('keeps the box on-stage', () => {
    expect(clampCrop({ x: 0.8, y: 0.8, scale: 0.5 })).toEqual({ x: 0.5, y: 0.5, scale: 0.5 })
    expect(clampCrop({ x: -1, y: -1, scale: 0.3 })).toEqual({ x: 0, y: 0, scale: 0.3 })
  })
  it('clamps scale into range', () => {
    expect(clampCrop({ x: 0, y: 0, scale: 5 }).scale).toBe(1)
    expect(clampCrop({ x: 0, y: 0, scale: 0.001 }).scale).toBe(0.05)
  })
  it('defaults missing/non-finite fields', () => {
    expect(clampCrop({})).toEqual(IDENTITY_CROP)
    expect(clampCrop({ x: NaN, y: NaN, scale: NaN })).toEqual(IDENTITY_CROP)
  })
  it('always yields a valid crop', () => {
    for (const c of [{ x: 9, y: -9, scale: 9 }, { x: 0.99, y: 0.99, scale: 0.99 }, {}]) {
      expect(isValidCrop(clampCrop(c))).toBe(true)
    }
  })
})

describe('parseCrop', () => {
  it('parses a valid JSON string', () => {
    expect(parseCrop('{"x":0.1,"y":0.2,"scale":0.6}')).toEqual({ x: 0.1, y: 0.2, scale: 0.6 })
  })
  it('parses an object', () => {
    expect(parseCrop({ x: 0.1, y: 0.2, scale: 0.6 })).toEqual({ x: 0.1, y: 0.2, scale: 0.6 })
  })
  it('falls back to identity on anything malformed', () => {
    expect(parseCrop('')).toEqual(IDENTITY_CROP)
    expect(parseCrop('not json')).toEqual(IDENTITY_CROP)
    expect(parseCrop('{"x":0.5,"y":0,"scale":0.9}')).toEqual(IDENTITY_CROP) // out of bounds
    expect(parseCrop(null)).toEqual(IDENTITY_CROP)
    expect(parseCrop(42)).toEqual(IDENTITY_CROP)
    expect(parseCrop('{"x":0}')).toEqual(IDENTITY_CROP) // missing fields
  })
  it('ignores extra fields like version', () => {
    expect(parseCrop('{"v":1,"x":0.1,"y":0.2,"scale":0.6}')).toEqual({ x: 0.1, y: 0.2, scale: 0.6 })
  })
})

describe('serializeCrop / round-trip', () => {
  it('round-trips through parse', () => {
    const c = { x: 0.1234, y: 0.5678, scale: 0.4321 }
    expect(parseCrop(serializeCrop(c))).toEqual(c)
  })
  it('rounds to 4 decimals', () => {
    expect(serializeCrop({ x: 0.123456, y: 0, scale: 1 })).toBe('{"v":1,"x":0.1235,"y":0,"scale":1}')
  })
})

describe('applyCrop', () => {
  it('is a no-op identity (same reference)', () => {
    expect(applyCrop(slot, IDENTITY_CROP)).toBe(slot)
    expect(isIdentityCrop(IDENTITY_CROP)).toBe(true)
  })
  it('translates and scales coords', () => {
    const c = { x: 0.1, y: 0.2, scale: 0.5 }
    const out = applyCrop(slot, c)
    expect(out.x).toBeCloseTo(0.1 + 0.2 * 0.5)
    expect(out.y).toBeCloseTo(0.2 + 0.6 * 0.5)
    expect(out.w).toBeCloseTo(0.05 * 0.5)
    expect(out.h).toBeCloseTo(0.2 * 0.5)
  })
  it('preserves other fields', () => {
    const out = applyCrop(slot, { x: 0.1, y: 0.1, scale: 0.8 })
    expect(out.title).toBe('a')
    expect(out.tier).toBe('Gold')
  })
  it('keeps cropped slots inside the player when crop and slot are both in-bounds', () => {
    const c = { x: 0.15, y: 0.15, scale: 0.7 }
    for (const s of [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0.9, y: 0.9, w: 0.05, h: 0.05 }]) {
      const o = applyCrop(s, c)
      expect(o.x).toBeGreaterThanOrEqual(0)
      expect(o.y).toBeGreaterThanOrEqual(0)
      expect(o.x + o.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(o.y + o.h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })
})
