// Holds each board frame back until this viewer's video shows it.
//
// The companion reports a board change the instant it happens; the viewer sees it
// on video seconds later — however far behind live their player is. Applying frames
// on arrival put cards on the overlay before they appeared on stream (spoiling
// shops and fights) and left hover zones over cards the video hadn't moved yet.
//
// Twitch tells every viewer their own latency (hlsLatencyBroadcaster), and the EBS
// stamps each frame with when it happened (`t`). A frame is due at t + latency.

// beyond this the player is buffering or the number is garbage; showing the board
// a little early beats holding it back indefinitely
export const MAX_LATENCY_MS = 30_000

// How long to hold a frame. The clamp to [0, latency] bounds a viewer clock that
// runs fast or slow: the worst case is the arrival-time behaviour we had anyway.
// No stamp or no latency reading (vod, some mobile players) → apply now.
export function holdFor(t: unknown, latencyMs: number, now: number): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 0
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 0
  const latency = Math.min(latencyMs, MAX_LATENCY_MS)
  return Math.min(Math.max(t + latency - now, 0), latency)
}

// Twitch reports seconds, sometimes as a string; anything else reads as "unknown"
export function parseLatency(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
  now: () => number
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

// Frames come out in the order they went in, each at its due time. A later frame
// never overtakes an earlier one: if the viewer's latency drops mid-stream, the
// newer frame waits for the older instead of the board stepping backwards.
export function createDelayLine<T>(apply: (v: T) => void, timers: Timers = realTimers) {
  const queue: { due: number; v: T }[] = []
  let timer: unknown = null

  const drain = () => {
    timer = null
    const now = timers.now()
    while (queue.length && queue[0].due <= now) apply(queue.shift()!.v)
    if (queue.length) timer = timers.set(drain, queue[0].due - now)
  }

  return {
    push(v: T, holdMs: number) {
      const now = timers.now()
      const last = queue[queue.length - 1]
      const due = Math.max(now + holdMs, last?.due ?? 0)
      if (holdMs <= 0 && !last) { apply(v); return }
      queue.push({ due, v })
      if (timer === null) timer = timers.set(drain, due - now)
    },
    clear() {
      queue.length = 0
      if (timer !== null) timers.clear(timer)
      timer = null
    },
    get pending() { return queue.length },
  }
}
