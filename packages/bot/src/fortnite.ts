// fortnite friday: every friday 8:00pm pacific (DST-aware). chat asked for an exact
// countdown on demand ("im worried kripp is gonna forget") — deterministic, never AI,
// so the seconds are real. a per-second countdown posted to chat was declined: spam.

const TZ = 'America/Los_Angeles'
const FRIDAY = 5
const START_HOUR = 20
// right after the start, "it's on" beats a 7-day countdown nobody asked for
const ON_WINDOW_MS = 4 * 3600_000

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
})
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function wall(t: number) {
  const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, wd: WD[p.weekday] }
}

// pacific wall-clock → utc ms. offset taken at the guess, then re-taken, so a DST
// changeover between now and friday still lands on 8:00pm local.
function pacificToUtc(y: number, m: number, d: number, h: number): number {
  const naive = Date.UTC(y, m - 1, d, h)
  let t = naive
  for (let i = 0; i < 2; i++) {
    const w = wall(t)
    const offset = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - t
    t = naive - offset
  }
  return t
}

/** start of the most recent fortnite friday at or before `now` (utc ms). */
function lastStart(now: number): number {
  const w = wall(now)
  const back = (w.wd - FRIDAY + 7) % 7
  let t = pacificToUtc(w.y, w.m, w.d - back, START_HOUR)
  if (t > now) t = pacificToUtc(w.y, w.m, w.d - back - 7, START_HOUR)
  return t
}

/** next fortnite friday start strictly after `now` (utc ms). */
export function nextFortniteFriday(now: number): number {
  const w = wall(lastStart(now))
  return pacificToUtc(w.y, w.m, w.d + 7, START_HOUR)
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts = [d && `${d}d`, (d || h) && `${h}h`, (d || h || m) && `${m}m`, `${s % 60}s`]
  return parts.filter(Boolean).join(' ')
}

export function formatFortniteCountdown(now: number): string {
  const since = now - lastStart(now)
  if (since < ON_WINDOW_MS) return `fortnite friday is ON — started ${clock(since)} ago (fri 8:00pm PT)`
  return `fortnite friday starts in ${clock(nextFortniteFriday(now) - now)} — fri 8:00pm PT`
}

// "when's fortnite friday", "how long till fortnite", "fortnite countdown", "is it fortnite time"
const FN_RE = /\bfort\s?nite\b|\bfn\s+friday\b/i
const FN_WHEN_RE = /\b(?:friday|when|how\s+long|till|until|countdown|time|start\w*|eta|soon|left|tonight|today)\b/i
export function isFortniteFridayQuery(q: string): boolean {
  return FN_RE.test(q) && FN_WHEN_RE.test(q)
}

// AI grounding for fortnite-shaped asks the deterministic route didn't take
export function fortniteContext(q: string, now: number): string {
  if (!FN_RE.test(q)) return ''
  return `\nFortnite friday (weekly, fri 8:00pm PT): ${formatFortniteCountdown(now)}. Exact — relay this, never estimate.`
}
