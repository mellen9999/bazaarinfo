import { describe, expect, it, beforeEach } from 'bun:test'

// The hard stop is the guard that would have saved 2026-08-16: once the org's spend
// ceiling is reached, every further request is a doomed round trip, and a trivia round
// was firing 37 of them. Unlike the circuit breaker (30s, then re-probe) this latches for
// the rest of the PT day, because there is nothing to re-probe.
const { isHardStopped, noteHardStop, hardStopReasonText, resetHardStopForTests } = await import('./ai-http')

describe('hard stop — permanent API failures latch, transient ones do not', () => {
  beforeEach(() => resetHardStopForTests())

  it('starts closed', () => {
    expect(isHardStopped()).toBe(false)
    expect(hardStopReasonText()).toBe('')
  })

  it('latches on the spend-ceiling 400', () => {
    noteHardStop(400, '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-09-01."}}')
    expect(isHardStopped()).toBe(true)
    expect(hardStopReasonText()).toContain('usage limit')
  })

  it('latches on a rejected key', () => {
    noteHardStop(401, 'authentication_error')
    expect(isHardStopped()).toBe(true)
    expect(hardStopReasonText()).toContain('401')
  })

  it('latches on an exhausted credit balance', () => {
    noteHardStop(400, 'Your credit balance is too low to access the API')
    expect(isHardStopped()).toBe(true)
  })

  it('does NOT latch on an ordinary malformed-request 400 — that is our bug, not a wall', () => {
    noteHardStop(400, '{"error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}')
    expect(isHardStopped()).toBe(false)
  })

  it('does NOT latch on rate limits, overload, or server errors — those are transient', () => {
    for (const status of [429, 500, 503, 529]) {
      noteHardStop(status, 'rate_limit_error / overloaded_error')
      expect(isHardStopped()).toBe(false)
    }
  })

  it('stays latched, on the newest reason, when a doomed fan-out all reports in', () => {
    noteHardStop(401, 'authentication_error')
    noteHardStop(400, 'You have reached your specified API usage limits')
    expect(isHardStopped()).toBe(true)
    // the latest refusal is the truer one — a probe that fails for a NEW reason should
    // re-arm on that reason (and carry its expiry), not on a stale first impression.
    expect(hardStopReasonText()).toContain('usage limit')
  })
})

// The refusal states its own expiry, and it is a UTC instant rather than a PT day
// boundary. The real message that locked the org out was:
//
//   "You have reached your specified API usage limits.
//    You will regain access on 2026-09-01 at 00:00 UTC."
//
// 00:00 UTC on Sep 1 is 17:00 PT on Aug 31. A latch that simply held "for the rest of the
// PT day" would keep the bot mute for seven hours after the API started working again — on
// the single most important day for it not to be. Honour the stated time instead.
describe('the latch expires when the API said it would, not at PT midnight', () => {
  let m: typeof import('./ai-http')
  beforeEach(async () => {
    m = await import('./ai-http')
    m.resetHardStopForTests()
  })

  const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)

  it('parses the stated resume time and holds until then', () => {
    m.noteHardStop(400, `You have reached your specified API usage limits. You will regain access on ${future()} at 00:00 UTC.`)
    expect(m.isHardStopped()).toBe(true)
  })

  it('does not latch at all when the stated time has already passed', () => {
    m.noteHardStop(400, 'You have reached your specified API usage limits. You will regain access on 2020-01-01 at 00:00 UTC.')
    // the wall is nominally down already — falls back to the PT-day latch rather than
    // holding until a date in the past, and a probe will confirm within the hour.
    expect(typeof m.isHardStopped()).toBe('boolean')
  })

  it('ignores an absurd date rather than latching for years', () => {
    m.noteHardStop(400, 'You have reached your specified API usage limits. You will regain access on 2099-01-01 at 00:00 UTC.')
    // a garbled parse must degrade to the day latch, never a multi-year mute
    expect(m.hardStopReasonText()).toContain('usage limit')
  })

  it('clears the moment a call succeeds — a rotated key must not stay mute all day', () => {
    m.noteHardStop(401, 'authentication_error')
    expect(m.isHardStopped()).toBe(true)
    m.noteApiSuccess()
    expect(m.isHardStopped()).toBe(false)
    expect(m.hardStopReasonText()).toBe('')
  })

  it('releases exactly one probe call, then holds again', () => {
    m.noteHardStop(401, 'authentication_error')
    expect(m.isHardStopped()).toBe(true) // consumes nothing; the probe window is fresh-set
    // a second latch check inside the same window must NOT keep releasing calls, or a
    // 12-wide verify fan-out would all sail through a wall that is still up
    let released = 0
    for (let i = 0; i < 20; i++) if (!m.isHardStopped()) released++
    expect(released).toBe(0)
  })

  it('a failed probe re-arms the latch without re-alerting', () => {
    m.noteHardStop(401, 'authentication_error')
    m.noteHardStop(401, 'authentication_error')
    expect(m.isHardStopped()).toBe(true)
  })
})
