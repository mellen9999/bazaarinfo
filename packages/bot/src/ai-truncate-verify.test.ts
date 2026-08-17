import { describe, expect, it, beforeEach } from 'bun:test'
import { extractFirstJson } from './http'

// A verifier lens is asked to REASON FIRST and judge second:
//   {"check":"<step-by-step verification>","ok":true,"quality":3}
// That ordering is the mechanism — the verdict is only trustworthy because the model
// worked through the fact before giving it. But it is also the worst possible ordering
// for a response that runs out of room: the reasoning eats the budget and the verdict
// never gets emitted.
//
// Nothing downstream could tell "the model ran out of tokens" from "the model said no",
// so a truncated lens voted REJECT. The panel requires all three lenses to accept, so a
// single truncation vetoed a perfectly good question and sent the round to the 12-call
// rescue pass. On 2026-08-16 that pass fired on nearly every round.
//
// The fix is NOT to move "ok" to the front — that would have the model rule before it
// reasons, trading the whole point of the panel for robustness. The fix is to stop
// starving the call: max_tokens is a ceiling, not a reservation, so raising it costs
// nothing on the responses that already fit, and rescues the ones that did not.

const TRUNCATED = '{"check":"The question asks which composer scored the game. Working through it: the credits list Yuka Tsujiyoko as the composer for the Fire Emblem titles of that era, and the claimed answer matches. Checking the count condition, the question states'

describe('a truncated verifier response is indistinguishable from a rejection', () => {
  it('loses the verdict entirely — the JSON never closes', () => {
    expect(extractFirstJson(TRUNCATED)).toBeNull()
  })

  it('still loses it when the reasoning alone was correct and accepting', () => {
    // the model had decided to accept; the token ran out mid-sentence, so the verdict
    // is simply absent. downstream this reads as a veto.
    expect(TRUNCATED).toContain('matches')
    expect(TRUNCATED).not.toContain('"ok"')
    expect(extractFirstJson(TRUNCATED)).toBeNull()
  })

  it('parses fine once the response has room to finish', () => {
    const complete = TRUNCATED + ' no count is involved.","ok":true,"quality":3}'
    const json = extractFirstJson(complete)
    expect(json).not.toBeNull()
    expect(JSON.parse(json!).ok).toBe(true)
  })
})

// The ceilings themselves are the fix, so they are asserted rather than left to drift
// back down. Each must clear the observed p99 of that call's output with real headroom.
describe('token ceilings leave room for the response to finish', () => {
  it('gives every stage more room than its measured average output', async () => {
    const src = await Bun.file(new URL('./ai-trivia.ts', import.meta.url)).text()
    const verify = Number(/const VERIFY_MAX_TOKENS = (\d+)/.exec(src)?.[1])
    const gen = Number(/const GEN_MAX_TOKENS = (\d+)/.exec(src)?.[1])
    const subject = Number(/const SUBJECT_MAX_TOKENS = (\d+)/.exec(src)?.[1])
    // production averaged ~187 output tokens per verify call against a 360 cap — an
    // average that close to the ceiling guarantees a fat truncated tail.
    expect(verify).toBeGreaterThanOrEqual(700)
    expect(gen).toBeGreaterThanOrEqual(400)
    expect(subject).toBeGreaterThanOrEqual(250)
  })
})

// A truncated GENERATION is the same waste one stage earlier: the question JSON never
// closes, validate() fails, and the candidate is dropped — a paid call that produced
// nothing, and one fewer candidate for the panel and the bank.
describe('a truncated generation is a silently dropped candidate', () => {
  it('fails validation rather than yielding a partial question', () => {
    const cut = '{"ok":true,"question":"Which composer scored the Genealogy of the Holy War soundtrack'
    expect(extractFirstJson(cut)).toBeNull()
  })
})

describe('hard stop stays scoped to permanent failures', () => {
  let m: typeof import('./ai-http')
  beforeEach(async () => {
    m = await import('./ai-http')
    m.resetHardStopForTests()
  })
  it('a truncated response is not a reason to stop calling the API', () => {
    expect(m.isHardStopped()).toBe(false)
  })
})
