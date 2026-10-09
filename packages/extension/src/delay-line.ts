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

// A streamer who delays their own feed in OBS (say, to dodge stream snipers) shifts
// the video by a number Twitch cannot see, so they declare it in the config view.
// 10 minutes is the most that view lets them enter; a stored value past it is junk.
export const MAX_EXTRA_DELAY_MS = 600_000

// How far behind the companion this viewer's video runs: their own latency (capped,
// it is a reading that can be garbage) plus the streamer's declared delay (trusted
// up to its own cap — it is a deliberate number, not a measurement). Capping the
// parts separately keeps the viewer-side cap at 30s whatever the delay, so a
// 5-minute OBS delay is held in full instead of being truncated to 30s.
export function totalDelay(latencyMs: number, extraMs: number): number {
  const latency = Number.isFinite(latencyMs) && latencyMs > 0 ? Math.min(latencyMs, MAX_LATENCY_MS) : 0
  const extra = Number.isFinite(extraMs) && extraMs > 0 ? Math.min(extraMs, MAX_EXTRA_DELAY_MS) : 0
  return latency + extra
}

// How long to hold a frame. The clamp to [0, total] bounds a viewer clock that
// runs fast or slow: the worst case is the arrival-time behaviour we had anyway.
// No stamp, or nothing to wait for (no latency reading — vod, some mobile players —
// and no declared delay) → apply now. A declared delay with an unknown latency
// still holds: it is the one part of the gap we do know.
export function holdFor(t: unknown, latencyMs: number, now: number, extraMs = 0): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 0
  const total = totalDelay(latencyMs, extraMs)
  if (total <= 0) return 0
  return Math.min(Math.max(t + total - now, 0), total)
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
