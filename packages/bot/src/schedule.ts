// stream schedule prediction — deterministic, timezone-agnostic, honest.
// predicts a channel's next stream start from logged Helix `started_at` timestamps.
//
// no LLM here on purpose: a schedule is a statistics problem, and an AI guess would
// fabricate a confident-but-wrong time. this reads the streamer's real rhythm and
// refuses to answer when the data can't support one.

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

// tunables
const MIN_SESSIONS = 6 // fewer logged starts than this: still learning
const MIN_SPAN_DAYS = 10 // history must cover at least this long a window
const STREAM_DAY_PROB = 0.4 // a weekday is a "stream day" at >= this hit-rate across weeks
const MIN_CONFIDENCE = 25 * MIN // never claim a window tighter than this
const LOOSE_CONFIDENCE = 3 * HOUR // wider than this and we flag the guess as rough
const MAX_CONFIDENCE = 6 * HOUR // hard cap on the reported ± window
const LOOKAHEAD_DAYS = 16 // how far forward to search for the next stream day
const GRACE = 15 * MIN // a start this-soon-past still counts as "upcoming"

export interface StreamSession {
  startedAt: number // epoch ms — authoritative Helix started_at
  lastSeenAt: number // epoch ms — last poll the stream was still observed live
}

export type Prediction =
  | { kind: 'insufficient'; sessions: number; needed: number }
  | { kind: 'irregular'; sessions: number; medianGapMs: number | null }
  | { kind: 'weekday'; at: number; confidenceMs: number; loose: boolean; samples: number }
  | { kind: 'gap'; at: number; confidenceMs: number; samples: number }

// circular statistics over fraction-of-day values in [0,1) — handles midnight wrap.
// returns the mean instant (as a day fraction) and a spread (std, also a day fraction).
function circStats(fracs: number[]): { mean: number; stdFrac: number } {
  if (fracs.length === 0) return { mean: 0, stdFrac: 0.5 }
  let sc = 0
  let ss = 0
  for (const f of fracs) {
    const a = f * 2 * Math.PI
    sc += Math.cos(a)
    ss += Math.sin(a)
  }
  const n = fracs.length
  const mc = sc / n
  const ms = ss / n
  let mean = Math.atan2(ms, mc) / (2 * Math.PI)
  if (mean < 0) mean += 1
  const R = Math.min(Math.hypot(mc, ms), 1) // concentration, 0 (spread) .. 1 (tight)
  const stdFrac = R > 1e-9 ? Math.sqrt(-2 * Math.log(R)) / (2 * Math.PI) : 0.5
  return { mean, stdFrac }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function median(a: number[]): number {
  return quantile([...a].sort((x, y) => x - y), 0.5)
}

// clean input: drop garbage, dedupe by start instant, sort ascending.
function tidy(raw: StreamSession[]): StreamSession[] {
  const seen = new Set<number>()
  return raw
    .filter((x) => Number.isFinite(x.startedAt) && x.startedAt > 0)
    .filter((x) => {
      if (seen.has(x.startedAt)) return false
      seen.add(x.startedAt)
      return true
    })
    .sort((a, b) => a.startedAt - b.startedAt)
}

// predict the next stream start. pure: no clock reads, no i/o — `now` is passed in.
export function predictNextStream(raw: StreamSession[], now: number): Prediction {
  const s = tidy(raw)
  if (s.length < MIN_SESSIONS) return { kind: 'insufficient', sessions: s.length, needed: MIN_SESSIONS }
  const spanDays = (s[s.length - 1].startedAt - s[0].startedAt) / DAY
  if (spanDays < MIN_SPAN_DAYS) return { kind: 'insufficient', sessions: s.length, needed: MIN_SESSIONS }

  // timezone-agnostic frame: we don't know the streamer's tz, so we derive a shift that
  // moves the typical start to local-noon. that keeps each stream day's start cluster far
  // from a day boundary, so weekday bucketing never splits one night across two days.
  const utcFrac = (ts: number) => (((ts % DAY) + DAY) % DAY) / DAY
  const globalUtc = circStats(s.map((x) => utcFrac(x.startedAt)))
  const shift = ((((0.5 - globalUtc.mean) % 1) + 1) % 1) * DAY
  const L = (ts: number) => ts + shift // shifted-local epoch; a day's starts cluster near noon
  const localFrac = (ts: number) => (((L(ts) % DAY) + DAY) % DAY) / DAY

  // bucket sessions by weekday of the shifted-local day, and track which weeks had each.
  const byWd: number[][] = Array.from({ length: 7 }, () => [])
  const wdWeeks: Set<number>[] = Array.from({ length: 7 }, () => new Set())
  const allWeeks = new Set<number>()
  for (const x of s) {
    const l = L(x.startedAt)
    const wd = new Date(l).getUTCDay()
    const week = Math.floor(l / (7 * DAY))
    byWd[wd].push(localFrac(x.startedAt))
    wdWeeks[wd].add(week)
    allWeeks.add(week)
  }
  const weeks = Math.max(allWeeks.size, 1)
  const streamDay = byWd.map((_, wd) => wdWeeks[wd].size / weeks >= STREAM_DAY_PROB)
  const globalLocal = circStats(s.map((x) => localFrac(x.startedAt)))
  const wdStart = byWd.map((fracs) => (fracs.length >= 3 ? circStats(fracs) : globalLocal))

  // primary model: next upcoming weekday that's a stream day, at its typical start time.
  if (streamDay.some(Boolean)) {
    const nowDay = Math.floor(L(now) / DAY)
    for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
      const dayL = nowDay + d
      const wd = new Date(dayL * DAY).getUTCDay()
      if (!streamDay[wd]) continue
      const st = wdStart[wd]
      const at = dayL * DAY + st.mean * DAY - shift // shifted-local midnight + tod, back to real epoch
      if (at > now - GRACE) {
        const raw = st.stdFrac * DAY
        return {
          kind: 'weekday',
          at,
          confidenceMs: Math.max(MIN_CONFIDENCE, Math.min(raw, MAX_CONFIDENCE)),
          loose: raw > LOOSE_CONFIDENCE,
          samples: s.length,
        }
      }
    }
  }

  // fallback: is the inter-stream gap consistent enough to project forward?
  const gaps: number[] = []
  for (let i = 1; i < s.length; i++) gaps.push(s[i].startedAt - s[i - 1].startedAt)
  const g = [...gaps].sort((a, b) => a - b)
  const medGap = median(gaps)
  const iqr = quantile(g, 0.75) - quantile(g, 0.25)
  if (medGap > 0 && iqr / medGap < 0.5) {
    let at = s[s.length - 1].startedAt + medGap
    while (at <= now) at += medGap
    return { kind: 'gap', at, confidenceMs: Math.max(MIN_CONFIDENCE, Math.min(iqr, MAX_CONFIDENCE)), samples: s.length }
  }

  return { kind: 'irregular', sessions: s.length, medianGapMs: medGap > 0 ? medGap : null }
}

// median live duration, for "kripp usually runs ~6h" — null if too few real sessions.
export function typicalDurationMs(raw: StreamSession[]): number | null {
  const durs = tidy(raw)
    .map((x) => x.lastSeenAt - x.startedAt)
    .filter((d) => d > 5 * MIN)
  return durs.length >= 3 ? median(durs) : null
}

// compact human delta: "40m", "~7h", "~3d".
export function humanizeDelta(ms: number): string {
  if (ms < 90 * MIN) return `${Math.max(1, Math.round(ms / MIN))}m`
  if (ms < 47 * HOUR) return `~${Math.round(ms / HOUR)}h`
  return `~${Math.round(ms / DAY)}d`
}

function dayLabel(at: number, now: number): string {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const d0 = Math.floor(now / DAY)
  const d1 = Math.floor(at / DAY)
  if (d1 === d0) return 'today'
  if (d1 === d0 + 1) return 'tomorrow'
  return days[new Date(at).getUTCDay()]
}

function utcClock(at: number): string {
  const d = new Date(at)
  const h = String(d.getUTCHours()).padStart(2, '0')
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m} UTC`
}

export interface LiveInfo {
  isLive: boolean
  liveSince?: number
  durationMs?: number | null
}

// full chat reply. `channel` is the display name (no #). honest by construction.
export function formatSchedule(channel: string, pred: Prediction, now: number, live: LiveInfo): string {
  if (live.isLive) {
    const up = live.liveSince ? ` — up ${humanizeDelta(now - live.liveSince)}` : ''
    const usual = live.durationMs ? `, usually runs ~${Math.round(live.durationMs / HOUR)}h` : ''
    return `${channel} is live right now${up}${usual}. that's a real signal, not a guess.`
  }
  switch (pred.kind) {
    case 'insufficient':
      return `still learning ${channel}'s schedule — only ${pred.sessions}/${pred.needed} stream starts logged so far. ask again in a few days once i've watched more.`
    case 'irregular':
      return pred.medianGapMs
        ? `${channel}'s schedule is too irregular to call a time — roughly one stream every ${humanizeDelta(pred.medianGapMs)}, but no reliable pattern.`
        : `not enough of a pattern in ${channel}'s streams to predict a next one yet.`
    case 'weekday':
    case 'gap': {
      const when = dayLabel(pred.at, now)
      const inMs = pred.at - now
      const soon = inMs <= GRACE ? 'any moment now' : `in ${humanizeDelta(inMs)}`
      const rough = pred.kind === 'weekday' && pred.loose ? ', rough' : ''
      return `next ${channel} stream likely ${when} ${soon} (±${humanizeDelta(pred.confidenceMs)}${rough}) — around ${utcClock(pred.at)}. best guess from ${pred.samples} past starts, not a promise.`
    }
  }
}

// does this message ask when the channel next streams? drives both the deterministic
// command answer and the AI-context injection. narrow enough not to catch item lookups.
const STREAM_WORD_RE = /\b(?:stream(?:ing|s|ed)?|live|broadcast(?:ing)?)\b/i
const WHEN_WORD_RE = /\b(?:when|next|what\s*time|how\s*long|schedule|soon|again|tonight|today|tomorrow|eta|back|going\s+live)\b/i
export function isScheduleQuery(q: string): boolean {
  if (/\b(?:next\s+stream|stream\s+schedule|stream\s+predict\w*)\b/i.test(q)) return true
  return STREAM_WORD_RE.test(q) && WHEN_WORD_RE.test(q)
}

// terse block for AI-context injection: gives the model real numbers to relay, never invent.
export function scheduleContext(channel: string, pred: Prediction, now: number, live: LiveInfo): string {
  if (live.isLive) return `Stream schedule for ${channel}: LIVE right now${live.liveSince ? ` (up ${humanizeDelta(now - live.liveSince)})` : ''}.`
  switch (pred.kind) {
    case 'insufficient':
      return `Stream schedule for ${channel}: not enough data yet (${pred.sessions}/${pred.needed} starts logged). Do not guess a time.`
    case 'irregular':
      return `Stream schedule for ${channel}: too irregular to predict${pred.medianGapMs ? ` (~1 every ${humanizeDelta(pred.medianGapMs)})` : ''}. Do not guess a specific time.`
    case 'weekday':
    case 'gap':
      return `Stream schedule for ${channel}: next likely ${dayLabel(pred.at, now)} in ${humanizeDelta(pred.at - now)} (±${humanizeDelta(pred.confidenceMs)}), ~${utcClock(pred.at)}, from ${pred.samples} logged starts. Currently offline. This is a statistical estimate, not confirmed.`
  }
}
