import { describe, it, expect } from 'bun:test'
import { holdFor, parseLatency, createDelayLine, totalDelay, MAX_LATENCY_MS, MAX_EXTRA_DELAY_MS } from './delay-line'

describe('holdFor', () => {
  it('holds a fresh frame for the viewer latency, minus time already spent in transit', () => {
    expect(holdFor(1000, 5000, 1000)).toBe(5000)
    expect(holdFor(1000, 5000, 1800)).toBe(4200)
  })

  it('applies immediately without a stamp or a latency reading', () => {
    expect(holdFor(undefined, 5000, 0)).toBe(0)
    expect(holdFor('1000', 5000, 0)).toBe(0)
    expect(holdFor(NaN, 5000, 0)).toBe(0)
    expect(holdFor(1000, 0, 1000)).toBe(0)
    expect(holdFor(1000, NaN, 1000)).toBe(0)
  })

  it('bounds a skewed viewer clock to [0, latency]', () => {
    expect(holdFor(1000, 5000, 1000 - 60_000)).toBe(5000) // viewer clock far behind
    expect(holdFor(1000, 5000, 1000 + 60_000)).toBe(0) // far ahead
  })

  it('caps absurd latency', () => {
    expect(holdFor(0, 600_000, 0)).toBe(MAX_LATENCY_MS)
  })
})

describe('holdFor with a declared stream delay', () => {
  it('adds the delay to the viewer latency', () => {
    expect(holdFor(1000, 5000, 1000, 20_000)).toBe(25_000)
    expect(holdFor(1000, 5000, 3000, 20_000)).toBe(23_000)
  })

  it('still holds when the latency is unknown, minus time already spent', () => {
    expect(holdFor(1000, 0, 1000, 20_000)).toBe(20_000)
    expect(holdFor(1000, NaN, 6000, 20_000)).toBe(15_000)
    expect(holdFor(1000, 0, 1000 + 60_000, 20_000)).toBe(0)
  })

  it('does not let a declared delay widen the viewer-latency cap', () => {
    expect(holdFor(0, 600_000, 0, 120_000)).toBe(MAX_LATENCY_MS + 120_000)
  })

  it('caps the delay itself and ignores junk', () => {
    expect(holdFor(0, 0, 0, 9_999_999)).toBe(MAX_EXTRA_DELAY_MS)
    expect(holdFor(1000, 5000, 1000, -5)).toBe(5000)
    expect(holdFor(1000, 5000, 1000, NaN)).toBe(5000)
  })

  it('bounds a skewed clock to [0, total]', () => {
    expect(holdFor(1000, 5000, 1000 - 60_000, 10_000)).toBe(15_000)
    expect(holdFor(1000, 5000, 1000 + 60_000, 10_000)).toBe(0)
  })

  it('still needs a stamp', () => {
    expect(holdFor(undefined, 0, 0, 10_000)).toBe(0)
  })
})

describe('totalDelay', () => {
  it('sums the capped parts', () => {
    expect(totalDelay(5000, 10_000)).toBe(15_000)
    expect(totalDelay(0, 0)).toBe(0)
    expect(totalDelay(-1, -1)).toBe(0)
  })
})

describe('parseLatency', () => {
  it('reads seconds as number or string', () => {
    expect(parseLatency(4.5)).toBe(4500)
    expect(parseLatency('2')).toBe(2000)
  })
  it('treats junk as unknown', () => {
    for (const v of [undefined, null, '', 'x', -1, 0, Infinity, {}]) expect(parseLatency(v)).toBe(0)
  })
})

function fakeTimers() {
  let now = 0
  let pending: { at: number; fn: () => void; id: number } | null = null
  let ids = 0
  return {
    t: {
      now: () => now,
      set: (fn: () => void, ms: number) => { pending = { at: now + ms, fn, id: ++ids }; return pending.id },
      clear: (id: unknown) => { if (pending?.id === id) pending = null },
    },
    advance(ms: number) {
      const end = now + ms
      while (pending && pending.at <= end) {
        const p = pending
        pending = null
        now = p.at
        p.fn()
      }
      now = end
    },
  }
}

describe('createDelayLine', () => {
  it('applies each frame at its due time, in order', () => {
    const ft = fakeTimers()
    const out: string[] = []
    const line = createDelayLine<string>((v) => out.push(v), ft.t)
    line.push('a', 3000)
    ft.advance(1000)
    line.push('b', 3000)
    ft.advance(1999)
    expect(out).toEqual([])
    ft.advance(1)
    expect(out).toEqual(['a'])
    ft.advance(1000)
    expect(out).toEqual(['a', 'b'])
  })

  it('never lets a newer frame overtake an older one', () => {
    const ft = fakeTimers()
    const out: string[] = []
    const line = createDelayLine<string>((v) => out.push(v), ft.t)
    line.push('old', 5000)
    line.push('new', 1000) // latency dropped
    ft.advance(1000)
    expect(out).toEqual([])
    ft.advance(4000)
    expect(out).toEqual(['old', 'new'])
  })

  it('applies at once when nothing is held', () => {
    const out: string[] = []
    const line = createDelayLine<string>((v) => out.push(v), fakeTimers().t)
    line.push('now', 0)
    expect(out).toEqual(['now'])
  })

  it('clear drops everything pending', () => {
    const ft = fakeTimers()
    const out: string[] = []
    const line = createDelayLine<string>((v) => out.push(v), ft.t)
    line.push('a', 1000)
    line.clear()
    ft.advance(5000)
    expect(out).toEqual([])
    expect(line.pending).toBe(0)
  })
})
