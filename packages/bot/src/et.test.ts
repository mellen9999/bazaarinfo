import { describe, expect, it } from 'bun:test'
import { etClock, etDayIndex, etWeekday } from './et'

describe('et', () => {
  it('summer = EDT (utc-4)', () => expect(etClock(Date.UTC(2026, 6, 1, 18, 0))).toBe('14:00 ET'))
  it('winter = EST (utc-5)', () => expect(etClock(Date.UTC(2026, 0, 1, 18, 0))).toBe('13:00 ET'))
  it('weekday and day roll in ET, not UTC', () => {
    const t = Date.UTC(2026, 9, 15, 2, 0) // thu 02:00 utc = wed 22:00 ET
    expect(etWeekday(t)).toBe('wed')
    expect(etDayIndex(t)).toBe(Math.floor(Date.UTC(2026, 9, 14) / 86_400_000))
  })
})
