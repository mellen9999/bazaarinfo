import { test, expect } from 'bun:test'
import { firstUsable, hedged, type Attempt } from './ai-hedge'

type R = { status: number; data?: string }
const usable = (r: R) => r.status === 200 && !!r.data
const FALLBACK: R = { status: 0 }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// an attempt that resolves to `result` after `ms`, unless aborted first (→ status 0)
function fakeAttempt(ms: number, result: R): Attempt<R> {
  return (signal) =>
    new Promise<R>((resolve) => {
      if (signal.aborted) return resolve({ status: 0 })
      const t = setTimeout(() => resolve(result), ms)
      signal.addEventListener('abort', () => { clearTimeout(t); resolve({ status: 0 }) })
    })
}

// --- firstUsable ---

test('firstUsable returns the first usable result, ignoring a slower one', async () => {
  const fast = delay(5).then<R>(() => ({ status: 200, data: 'fast' }))
  const slow = delay(50).then<R>(() => ({ status: 200, data: 'slow' }))
  expect(await firstUsable([slow, fast], usable, FALLBACK)).toEqual({ status: 200, data: 'fast' })
})

test('firstUsable skips an early failure and waits for a later success', async () => {
  const failFast = delay(5).then<R>(() => ({ status: 503 }))
  const okSlow = delay(40).then<R>(() => ({ status: 200, data: 'ok' }))
  expect(await firstUsable([failFast, okSlow], usable, FALLBACK)).toEqual({ status: 200, data: 'ok' })
})

test('firstUsable returns the last settled result when none are usable', async () => {
  const a = delay(5).then<R>(() => ({ status: 503 }))
  const b = delay(30).then<R>(() => ({ status: 429 }))
  expect(await firstUsable([a, b], usable, FALLBACK)).toEqual({ status: 429 })
})

test('firstUsable treats a rejection as not-usable and still resolves', async () => {
  const rejects = delay(5).then<R>(() => { throw new Error('boom') })
  const ok = delay(30).then<R>(() => ({ status: 200, data: 'ok' }))
  expect(await firstUsable([rejects, ok], usable, FALLBACK)).toEqual({ status: 200, data: 'ok' })
})

// --- hedged ---

test('hedged: fast primary settles before the hedge — only one attempt runs', async () => {
  let calls = 0
  const attempt: Attempt<R> = (s) => { calls++; return fakeAttempt(5, { status: 200, data: 'p' })(s) }
  const r = await hedged(attempt, { hedgeAfterMs: 30, enabled: true, usable, fallback: FALLBACK })
  expect(r).toEqual({ status: 200, data: 'p' })
  expect(calls).toBe(1)
})

test('hedged: slow primary triggers a backup that wins', async () => {
  let calls = 0
  // primary is slow (100ms), backup (fired at 20ms) is fast (5ms) → backup wins ~25ms
  const attempt: Attempt<R> = (s) => {
    calls++
    return calls === 1 ? fakeAttempt(100, { status: 200, data: 'primary' })(s)
                       : fakeAttempt(5, { status: 200, data: 'backup' })(s)
  }
  const start = Date.now()
  const r = await hedged(attempt, { hedgeAfterMs: 20, enabled: true, usable, fallback: FALLBACK })
  expect(r).toEqual({ status: 200, data: 'backup' })
  expect(calls).toBe(2)
  expect(Date.now() - start).toBeLessThan(80) // didn't wait for the 100ms primary
})

test('hedged: disabled runs exactly one attempt even if slow', async () => {
  let calls = 0
  const attempt: Attempt<R> = (s) => { calls++; return fakeAttempt(10, { status: 200, data: 'only' })(s) }
  const r = await hedged(attempt, { hedgeAfterMs: 1, enabled: false, usable, fallback: FALLBACK })
  expect(r).toEqual({ status: 200, data: 'only' })
  expect(calls).toBe(1)
})

test('hedged: both attempts fail → returns a real failure status, not the fallback hang', async () => {
  const attempt: Attempt<R> = (s) => fakeAttempt(5, { status: 503 })(s)
  const r = await hedged(attempt, { hedgeAfterMs: 1, enabled: true, usable, fallback: FALLBACK })
  expect(r.status).toBe(503)
})
