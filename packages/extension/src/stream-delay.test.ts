import { describe, it, expect } from 'bun:test'
import { parseDelay, parseDelayInput, serializeConfig, MAX_DELAY_S } from './stream-delay'
import { parseCrop, serializeCrop, IDENTITY_CROP } from './viewport'

const crop = { x: 0.1, y: 0.2, scale: 0.5 }

describe('parseDelay', () => {
  it('reads a stored delay', () => {
    expect(parseDelay(serializeConfig(crop, 45))).toBe(45)
    expect(parseDelay({ delay: 0 })).toBe(0)
    expect(parseDelay({ delay: MAX_DELAY_S })).toBe(MAX_DELAY_S)
  })

  it('reads old crop-only configs as no delay', () => {
    expect(parseDelay(serializeCrop(crop))).toBe(0)
  })

  it('reads anything malformed as no delay', () => {
    for (const v of [undefined, null, '', 'nope', '[]', '{"delay":-1}', '{"delay":601}', '{"delay":1.5}', '{"delay":"30"}', { delay: NaN }, 7]) {
      expect(parseDelay(v)).toBe(0)
    }
  })
})

describe('parseDelayInput', () => {
  it('takes whole seconds in range, blank as 0', () => {
    expect(parseDelayInput('30')).toBe(30)
    expect(parseDelayInput(' 600 ')).toBe(600)
    expect(parseDelayInput('')).toBe(0)
    expect(parseDelayInput('0')).toBe(0)
  })

  it('rejects the rest', () => {
    for (const v of ['601', '-1', '1.5', '1e2', 'abc', '3 0']) expect(parseDelayInput(v)).toBeNull()
  })
})

describe('serializeConfig', () => {
  it('keeps the crop and the delay independent', () => {
    const raw = serializeConfig(crop, 90)
    expect(parseCrop(raw)).toEqual(crop)
    expect(parseDelay(raw)).toBe(90)
  })

  it('writes the same crop fields serializeCrop does', () => {
    const { delay, ...rest } = JSON.parse(serializeConfig(crop, 5))
    expect(rest).toEqual(JSON.parse(serializeCrop(crop)))
    expect(delay).toBe(5)
  })

  it('the identity default carries no delay', () => {
    const raw = serializeConfig(IDENTITY_CROP, 0)
    expect(parseCrop(raw)).toEqual(IDENTITY_CROP)
    expect(parseDelay(raw)).toBe(0)
  })
})
