import { describe, expect, test } from 'bun:test'
import { formatFortniteCountdown, isFortniteFridayQuery, nextFortniteFriday } from './fortnite'

// fri 2026-10-09 8:00pm PDT = 2026-10-10 03:00 UTC
const FRI_PDT = Date.UTC(2026, 9, 10, 3)

describe('nextFortniteFriday', () => {
  test('thursday afternoon PT → this friday 8pm PDT', () => {
    expect(nextFortniteFriday(Date.UTC(2026, 9, 8, 21))).toBe(FRI_PDT)
  })
  test('a second before the start still counts down', () => {
    expect(nextFortniteFriday(FRI_PDT - 1000)).toBe(FRI_PDT)
  })
  test('exactly at the start → next week', () => {
    expect(nextFortniteFriday(FRI_PDT)).toBe(FRI_PDT + 7 * 86400_000)
  })
  test('across the DST change (nov 1) it stays 8pm local: 04:00 UTC in PST', () => {
    expect(nextFortniteFriday(Date.UTC(2026, 9, 31, 12))).toBe(Date.UTC(2026, 10, 7, 4))
  })
  test('back into DST (mar 14 2027) → 03:00 UTC again', () => {
    expect(nextFortniteFriday(Date.UTC(2027, 2, 15, 12))).toBe(Date.UTC(2027, 2, 20, 3))
  })
})

describe('formatFortniteCountdown', () => {
  test('exact to the second', () => {
    expect(formatFortniteCountdown(FRI_PDT - (26 * 3600 + 4 * 60 + 9) * 1000)).toBe(
      'fortnite friday starts in 1d 2h 4m 9s — fri 8:00pm PT',
    )
  })
  test('under a minute shows just seconds', () => {
    expect(formatFortniteCountdown(FRI_PDT - 42_000)).toContain('starts in 42s')
  })
  test('just after the start says it is on', () => {
    expect(formatFortniteCountdown(FRI_PDT + 23 * 60_000)).toContain('fortnite friday is ON — started 23m 0s ago')
  })
  test('hours later it counts down to next week', () => {
    expect(formatFortniteCountdown(FRI_PDT + 5 * 3600_000)).toContain('starts in 6d 19h 0m 0s')
  })
})

describe('isFortniteFridayQuery', () => {
  test.each(['when is fortnite friday', 'how long till fortnite', 'fortnite countdown', 'is it fortnite time yet', 'fn friday when'])(
    'matches: %s',
    (q) => expect(isFortniteFridayQuery(q)).toBe(true),
  )
  test.each(['is fortnite a good game', 'kripp plays fortnite?', 'when is the next stream', 'friday'])(
    'ignores: %s',
    (q) => expect(isFortniteFridayQuery(q)).toBe(false),
  )
})
