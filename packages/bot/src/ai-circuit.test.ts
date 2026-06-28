import { test, expect } from 'bun:test'
import { cbRecordSuccess, cbRecordFailure, cbIsOpen } from './ai-cache'

// regression guard: a partial upstream slowdown alternates success/failure and never
// chains 5 misses in a row, so the old consecutive-failure breaker stayed shut forever —
// every other user ate a full deadline wait then a transient-miss fallback (the "backed
// up 45s then dumped a wall of glitch lines" bug). the windowed-rate breaker must open.
test('circuit breaker trips on failure RATE, not just consecutive failures', () => {
  // healthy stream with a couple scattered misses must NOT trip
  cbRecordSuccess()
  cbRecordSuccess()
  cbRecordFailure()
  cbRecordSuccess()
  cbRecordSuccess()
  cbRecordSuccess()
  expect(cbIsOpen()).toBe(false)

  // upstream degrades: failures now dominate the recent window even though they never
  // chain 5-in-a-row from the breaker's perspective. it must open and shed load.
  cbRecordFailure()
  cbRecordFailure()
  cbRecordFailure()
  cbRecordFailure()
  cbRecordFailure()
  cbRecordFailure()
  expect(cbIsOpen()).toBe(true)
})
