import { describe, expect, it } from 'bun:test'
import { findUngroundedStats, correctClockClaim } from './ai-verify'

const CARD = 'Game data:\nPumpkin (Vanessa, Medium) — Heal 30/45/60. Cooldown 7 seconds.\n---\n[USER]: what does pumpkin do'

describe('findUngroundedStats — numbers checked against the injected card', () => {
  it('passes numbers that come straight off the card', () => {
    expect(findUngroundedStats('pumpkin heals 60 at diamond on a 7 second cooldown', CARD)).toEqual([])
  })

  it('catches a number invented on top of real data', () => {
    expect(findUngroundedStats('pumpkin heals 85 at diamond', CARD)).toEqual(['85'])
  })

  it('reports every bad number, not just the first', () => {
    const bad = findUngroundedStats('deals 91 damage and 84 burn', CARD).sort()
    expect(bad).toEqual(['84', '91'])
  })

  it('ignores numbers that are not stat claims', () => {
    expect(findUngroundedStats("reacher season 2 is better, and it's $20 on steam", CARD)).toEqual([])
    expect(findUngroundedStats('run 2 of these and you win day 9', CARD)).toEqual([])
  })

  it('does not flag a year sitting next to a stat word', () => {
    expect(findUngroundedStats('the 2025 damage rework changed it', CARD)).toEqual([])
  })

  it('allows arithmetic the model derived from a grounded number', () => {
    expect(findUngroundedStats('about 7.5 damage a second', CARD)).toEqual([])
  })

  it('reads stat-first phrasing too', () => {
    expect(findUngroundedStats('cooldown of 3 seconds', CARD)).toEqual(['3'])
    expect(findUngroundedStats('cooldown of 7 seconds', CARD)).toEqual([])
  })

  it('grounds against the whole context, not only the card block', () => {
    const ctx = `${CARD}\nTrivia standings: bob 42 points`
    expect(findUngroundedStats('bob is on 42 damage worth of points', ctx)).toEqual([])
  })
})

describe('correctClockClaim — a weekday claim is always checkable', () => {
  const ctx = 'Right now: wednesday 12 aug 2026, 17:42 UTC.'

  it('repairs the wrong day', () => {
    expect(correctClockClaim('today is monday', ctx)!.text).toBe('today is wednesday')
    expect(correctClockClaim("today's tuesday, chat", ctx)!.text).toBe("today's wednesday, chat")
  })

  it('only rewrites the day inside the claim, never another one in the sentence', () => {
    const r = correctClockClaim("next stream is thursday, and today's monday", ctx)!
    expect(r.text).toBe("next stream is thursday, and today's wednesday")
    expect(r.day).toBe('wednesday')
  })

  it('passes the right day', () => {
    expect(correctClockClaim("today's wednesday", ctx)).toBeNull()
    expect(correctClockClaim('it is Wednesday', ctx)).toBeNull()
  })

  it('leaves any weekday that is not a claim about today alone', () => {
    expect(correctClockClaim('next stream is thursday', ctx)).toBeNull()
    expect(correctClockClaim('he streamed monday and friday last week', ctx)).toBeNull()
  })

  it('does nothing without a clock line', () => {
    expect(correctClockClaim('today is monday', 'no clock here')).toBeNull()
  })
})
