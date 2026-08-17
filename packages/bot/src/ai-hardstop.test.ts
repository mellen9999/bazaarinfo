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

  it('keeps the FIRST reason when a whole doomed fan-out reports in', () => {
    noteHardStop(401, 'authentication_error')
    const first = hardStopReasonText()
    noteHardStop(400, 'You have reached your specified API usage limits')
    expect(hardStopReasonText()).toBe(first)
  })
})
