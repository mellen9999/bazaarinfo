// FIFO slot semaphore (acquireAiSlot) — the AI concurrency gate. a bug here is catastrophic
// (deadlock = the bot stops answering entirely, or over-allocation = we blow past the
// concurrency ceiling), so this is stress-tested hard: ceiling never exceeded, FIFO order,
// every acquirer resolves, idempotent release, and the pool always drains back to zero.
import { describe, it, expect } from 'bun:test'
import { acquireAiSlot, activeSlotCount, AI_MAX_CONCURRENT } from './ai-cache'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('acquireAiSlot FIFO semaphore', () => {
  it('never exceeds AI_MAX_CONCURRENT active at once', async () => {
    let peak = 0
    const N = AI_MAX_CONCURRENT * 5
    const held: Array<() => void> = []
    // acquire N slots; each records the peak concurrency it observes while held
    const runs = Array.from({ length: N }, () =>
      acquireAiSlot().then(async (release) => {
        peak = Math.max(peak, activeSlotCount())
        expect(activeSlotCount()).toBeLessThanOrEqual(AI_MAX_CONCURRENT)
        await tick()
        release()
      }),
    )
    await Promise.all(runs)
    expect(peak).toBe(AI_MAX_CONCURRENT) // contention high enough to saturate
    expect(activeSlotCount()).toBe(0) // fully drained, no leak
  })

  it('hands freed slots to waiters in FIFO order', async () => {
    // saturate the pool
    const holders = await Promise.all(
      Array.from({ length: AI_MAX_CONCURRENT }, () => acquireAiSlot()),
    )
    // queue extra acquirers in a known order; record the order they actually get a slot
    const order: number[] = []
    const queued = Array.from({ length: 5 }, (_, i) =>
      acquireAiSlot().then((release) => {
        order.push(i)
        return release
      }),
    )
    // release the held slots one at a time — each should wake the NEXT queued waiter in order
    for (const release of holders) {
      release()
      await tick()
    }
    const releases = await Promise.all(queued)
    expect(order).toEqual([0, 1, 2, 3, 4]) // strict FIFO, no barging
    releases.forEach((r) => r())
    expect(activeSlotCount()).toBe(0)
  })

  it('release is idempotent — a double release cannot over-free the pool', async () => {
    const r1 = await acquireAiSlot()
    expect(activeSlotCount()).toBe(1)
    r1()
    r1() // second call must be a no-op
    r1()
    expect(activeSlotCount()).toBe(0)
    // pool still works correctly after the abuse
    const r2 = await acquireAiSlot()
    expect(activeSlotCount()).toBe(1)
    r2()
    expect(activeSlotCount()).toBe(0)
  })

  it('stress: randomized holds, ceiling holds and pool fully drains', async () => {
    let peak = 0
    // deterministic pseudo-random holds (no Math.random — banned in this env's workflows,
    // and keeps the test reproducible); vary tick counts by index
    const N = 200
    const runs = Array.from({ length: N }, (_, i) =>
      acquireAiSlot().then(async (release) => {
        peak = Math.max(peak, activeSlotCount())
        expect(activeSlotCount()).toBeLessThanOrEqual(AI_MAX_CONCURRENT)
        const holds = (i % 4) + 1
        for (let k = 0; k < holds; k++) await tick()
        release()
      }),
    )
    await Promise.all(runs) // must all resolve — a deadlock would hang this
    expect(peak).toBe(AI_MAX_CONCURRENT)
    expect(activeSlotCount()).toBe(0)
  })
})
