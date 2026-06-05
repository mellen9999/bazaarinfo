// Hedged-request orchestration, split out from ai.ts so the concurrency (race / first-usable
// / loser-abort) is unit-testable in isolation. Dependency-injected: callers pass an `attempt`
// thunk that takes an AbortSignal, so this file has no knowledge of HTTP, fetch, or the API.

export type Attempt<T> = (signal: AbortSignal) => Promise<T>

// Resolve the first result that satisfies `usable`. If none do, resolve the LAST one to settle
// so the caller still sees a real (failure) result rather than hanging. Never rejects — the
// attempt thunk is expected to map its own errors into a result value (a rejection counts as
// "not usable" and is folded into the pending count).
export function firstUsable<T>(
  results: Promise<T>[],
  usable: (r: T) => boolean,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    let pending = results.length
    let last = fallback
    for (const p of results) {
      p.then((r) => {
        if (usable(r)) resolve(r)
        else { last = r; if (--pending === 0) resolve(last) }
      }).catch(() => { if (--pending === 0) resolve(last) })
    }
  })
}

export interface HedgeOptions<T> {
  hedgeAfterMs: number
  // only hedge when there's budget for a meaningful backup window; otherwise run a single attempt
  enabled: boolean
  usable: (r: T) => boolean
  // result returned if every attempt fails before any settles usefully
  fallback: T
}

// Run `attempt`. If it hasn't settled within `hedgeAfterMs`, run one identical backup and take
// whichever returns a usable result first, aborting the loser. The backup fires ONLY on the slow
// tail, so the common (fast) path makes exactly one call and adds only a single cheap timer.
export async function hedged<T>(attempt: Attempt<T>, opts: HedgeOptions<T>): Promise<T> {
  const abort = new AbortController()
  const primary = attempt(abort.signal)
  if (!opts.enabled) return primary

  const HEDGE = Symbol('hedge')
  let timer: ReturnType<typeof setTimeout> | undefined
  const raced = await Promise.race([
    primary,
    new Promise<typeof HEDGE>((r) => { timer = setTimeout(() => r(HEDGE), opts.hedgeAfterMs) }),
  ])
  if (raced !== HEDGE) { clearTimeout(timer); return raced as T } // primary settled first

  const backup = attempt(abort.signal)
  const winner = await firstUsable([primary, backup], opts.usable, opts.fallback)
  abort.abort() // cancel whichever attempt is still in flight
  return winner
}
