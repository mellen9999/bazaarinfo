import { describe, expect, it } from 'bun:test'
import { shouldRefetch, CARD_REFRESH_MIN_MS } from './card-refresh'

describe('shouldRefetch', () => {
  it('never refetches when nothing is missing', () => {
    expect(shouldRefetch(false, null, 1000)).toBe(false)
    expect(shouldRefetch(false, 0, CARD_REFRESH_MIN_MS * 5)).toBe(false)
  })
  it('refetches on the first miss', () => {
    expect(shouldRefetch(true, null, 1000)).toBe(true)
  })
  it('throttles inside the window', () => {
    expect(shouldRefetch(true, 1000, 1000 + CARD_REFRESH_MIN_MS - 1)).toBe(false)
  })
  it('allows again once the window has passed', () => {
    expect(shouldRefetch(true, 1000, 1000 + CARD_REFRESH_MIN_MS)).toBe(true)
  })
  it('survives a backwards clock jump', () => {
    expect(shouldRefetch(true, 5000, 100)).toBe(true)
  })
})
