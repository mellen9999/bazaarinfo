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
const STREAK_RUN = 5 // most recent starts examined for an active near-daily run
const STREAK_CLOCK = 15 // starts feeding the typical-clock estimate (cadence stays on STREAK_RUN)
const STREAK_DECAY = 0.85 // per-start recency decay on the clock estimate
const STREAK_MAX_GAP = 40 * HOUR // median recent gap at/below this = actively streaming ~daily
const STREAK_BROKEN = 3 // silent for this × the recent gap ⇒ the run ended, use the long models

// how far back the caller should read sessions from. lives here, not in the query glue,
// because it's a property of the prediction: starts older than this are deliberately
// ignored (a schedule from four months ago predicts nothing about tonight).
export const PREDICT_WINDOW_DAYS = 120

export interface StreamSession {
  startedAt: number // epoch ms — authoritative Helix started_at
  lastSeenAt: number // epoch ms — last poll the stream was still observed live
}

export type Prediction =
  | { kind: 'insufficient'; sessions: number; needed: number }
  | { kind: 'irregular'; sessions: number; medianGapMs: number | null }
  | { kind: 'streak'; at: number; confidenceMs: number; samples: number }
  | { kind: 'weekday'; at: number; confidenceMs: number; loose: boolean; samples: number }
  | { kind: 'gap'; at: number; confidenceMs: number; samples: number }

// signed circular distance between two day fractions, in [-0.5, 0.5) — handles midnight wrap.
function circDelta(f: number, center: number): number {
  return ((((f - center + 0.5) % 1) + 1) % 1) - 0.5
}

// robust circular center: the sample minimizing total circular distance to the rest.
// a circular mean gets dragged toward an outlier, which then inflates every deviation
// the spread quantile sees; the medoid stays inside the punctual cluster. weights (if
// given, parallel to fracs) let recent starts count more than a stale cluster.
function circCenter(fracs: number[], w?: number[]): number {
  let best = fracs[0] ?? 0
  let bestCost = Infinity
  for (const c of fracs) {
    let cost = 0
    for (let i = 0; i < fracs.length; i++) cost += Math.abs(circDelta(fracs[i], c)) * (w?.[i] ?? 1)
    if (cost < bestCost) {
      bestCost = cost
      best = c
    }
  }
  return best
}

// robust ± window: the half-width around the center that covers COVERAGE of the
// observed (weighted) starts. the old circular std was what viewers felt as "±4h" —
// a single odd late-night start inflates a std for weeks; a quantile just drops it.
const COVERAGE = 0.8
function circSpread(fracs: number[], center: number, w?: number[]): number {
  if (fracs.length === 0) return 0.5
  const devs = fracs
    .map((f, i) => ({ d: Math.abs(circDelta(f, center)), w: w?.[i] ?? 1 }))
    .sort((a, b) => a.d - b.d)
  const total = devs.reduce((acc, x) => acc + x.w, 0)
  let cum = 0
  for (const x of devs) {
    cum += x.w
    if (cum >= COVERAGE * total) return x.d
  }
  return devs[devs.length - 1].d
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

// clean input: drop garbage, sort ascending, and merge starts <30min apart — a
// crash-restart (or a backfilled VOD beside its polled twin) is one evening of
// streaming, not two sessions; near-zero gaps would poison the gap/streak medians.
const MERGE_MS = 30 * MIN
function tidy(raw: StreamSession[]): StreamSession[] {
  const sorted = raw
    .filter((x) => Number.isFinite(x.startedAt) && x.startedAt > 0)
    .sort((a, b) => a.startedAt - b.startedAt)
  const out: StreamSession[] = []
  for (const x of sorted) {
    const prev = out[out.length - 1]
    if (prev && x.startedAt - prev.startedAt < MERGE_MS) {
      prev.lastSeenAt = Math.max(prev.lastSeenAt, x.lastSeenAt)
      continue
    }
    out.push({ ...x })
  }
  return out
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

  // recent-cadence model, checked first: a near-daily run in the last few starts beats
  // weekday averages — weeks containing a vacation or a schedule change poison those
  // hit-rates long after the streamer is back to a steady daily rhythm.
  const recent = s.slice(-STREAK_RUN)
  if (recent.length >= 4) {
    const rGaps: number[] = []
    for (let i = 1; i < recent.length; i++) rGaps.push(recent[i].startedAt - recent[i - 1].startedAt)
    const medR = median(rGaps)
    const lastStart = recent[recent.length - 1].startedAt
    if (medR > 0 && medR <= STREAK_MAX_GAP && now - lastStart <= STREAK_BROKEN * medR) {
      // cadence comes from the last few gaps, but the typical clock deserves more
      // history — five starts make any spread estimate a coin flip; fifteen let the
      // quantile actually forget the one late night. recency-weighted so a schedule
      // shift stops poisoning the estimate within a few streams.
      const clock = s.slice(-STREAK_CLOCK).map((x) => utcFrac(x.startedAt))
      const w = clock.map((_, i) => STREAK_DECAY ** (clock.length - 1 - i))
      const center = circCenter(clock, w)
      const conf = Math.max(MIN_CONFIDENCE, Math.min(circSpread(clock, center, w) * DAY, MAX_CONFIDENCE))
      // next start: the typical recent clock, on the first day still meaningfully ahead.
      // a slot stays "today" while within its own ± window — the model shouldn't skip to
      // tomorrow one hour past a mean it only claims to know within two.
      let at = Math.floor(lastStart / DAY) * DAY + center * DAY
      while (at <= lastStart + medR / 2 || at <= now - Math.max(GRACE, conf)) at += DAY
      // `samples` is the history this drew on, not the clock slice — reporting the slice
      // read as "a rolling window of 15, oldest drops off", which is not what happens.
      return { kind: 'streak', at, confidenceMs: conf, samples: s.length }
    }
  }

  const globalUtcCenter = circCenter(s.map((x) => utcFrac(x.startedAt)))
  const shift = ((((0.5 - globalUtcCenter) % 1) + 1) % 1) * DAY
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
  const model = (fracs: number[]) => {
    const mean = circCenter(fracs)
    return { mean, spreadFrac: circSpread(fracs, mean) }
  }
  const globalLocal = model(s.map((x) => localFrac(x.startedAt)))
  const wdStart = byWd.map((fracs) => (fracs.length >= 3 ? model(fracs) : globalLocal))

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
        const raw = st.spreadFrac * DAY
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
  if (d1 === d0 - 1) return 'yesterday'
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

// does a channel title state schedule info? streamer-stated plans ("NEXT STREAM
// WEDNESDAY") beat any statistical guess, so a matching title is surfaced first.
// short weekday forms risk idiom hits ("sat down") but titles are short and surfacing
// one is honest info either way.
export const TITLE_SCHEDULE_RE = /\b(?:next\s+stream|back|returns?|no\s+stream|off\s+(?:today|tonight|this)|tomorrow|tonight|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[:.]\d{2})\b/i

// prepend a schedule-stating title to the reply — the streamer's own word outranks
// the model. offline only: a live channel's title is about the current stream.
export function withTitleOverride(base: string, channel: string, title: string | null | undefined, live: LiveInfo): string {
  if (!title || live.isLive || !TITLE_SCHEDULE_RE.test(title)) return base
  return `${channel}'s title says: "${title}" — streamer's word beats my stats. ${base}`
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
    case 'streak': {
      const when = dayLabel(pred.at, now)
      const inMs = pred.at - now
      const soon = inMs <= GRACE ? 'any moment now' : `in ${humanizeDelta(inMs)}`
      return `${channel}'s been streaming near-daily lately — next likely ${when} ${soon} (±${humanizeDelta(pred.confidenceMs)}), around ${utcClock(pred.at)}. from ${pred.samples} logged starts, recent ones weighted heaviest. not a promise.`
    }
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
// "getting/coming/hopping on" and "online" count as stream words — "when kripp getting
// on" was a real ask that fell through to an AI dodge. "going on" stays excluded
// ("what's going on" is idiom, not a schedule ask).
const STREAM_WORD_RE = /\b(?:stream(?:ing|s|ed)?|live|broadcast(?:ing)?|online|(?:get(?:ting|s)?|com(?:ing|es)?|hop(?:ping|s)?|be|back)\s+on)\b/i
const WHEN_WORD_RE = /\b(?:when|next|what\s*time|how\s*long|schedule|soon|again|tonight|today|tomorrow|eta|back|going\s+live|predict\w*)\b/i
export function isScheduleQuery(q: string): boolean {
  if (/\b(?:next\s+stream|stream\s+schedule|stream\s+predict\w*)\b/i.test(q)) return true
  return STREAM_WORD_RE.test(q) && WHEN_WORD_RE.test(q)
}

// past-tense schedule ask ("when did kripp start yesterday") — answered from logged
// sessions, never the predictor. `last` alone is too loose ("how long do streams last"
// is the verb), so it only counts glued to a noun/`live`.
const PAST_WORD_RE = /\b(?:did|was|were|yesterday|earlier|ago|last\s+(?:stream|night|time|live))\b/i
export function isPastStreamQuery(q: string): boolean {
  return isScheduleQuery(q) && PAST_WORD_RE.test(q)
}

// terse block for AI-context injection: gives the model real numbers to relay, never invent.
export function scheduleContext(channel: string, pred: Prediction, now: number, live: LiveInfo): string {
  if (live.isLive) return `Stream schedule for ${channel}: LIVE right now${live.liveSince ? ` (up ${humanizeDelta(now - live.liveSince)})` : ''}.`
  switch (pred.kind) {
    case 'insufficient':
      return `Stream schedule for ${channel}: not enough data yet (${pred.sessions}/${pred.needed} starts logged). Do not guess a time.`
    case 'irregular':
      return `Stream schedule for ${channel}: too irregular to predict${pred.medianGapMs ? ` (~1 every ${humanizeDelta(pred.medianGapMs)})` : ''}. Do not guess a specific time.`
    case 'streak':
      return `Stream schedule for ${channel}: streaming near-daily lately; next likely ${dayLabel(pred.at, now)} in ${humanizeDelta(pred.at - now)} (±${humanizeDelta(pred.confidenceMs)}), ~${utcClock(pred.at)}, from ${pred.samples} logged starts (recent ones weighted heaviest). Currently offline. This is a statistical estimate, not confirmed.`
    case 'weekday':
    case 'gap':
      return `Stream schedule for ${channel}: next likely ${dayLabel(pred.at, now)} in ${humanizeDelta(pred.at - now)} (±${humanizeDelta(pred.confidenceMs)}), ~${utcClock(pred.at)}, from ${pred.samples} logged starts. Currently offline. This is a statistical estimate, not confirmed.`
  }
}

// "how do you predict that?" / "what's the rolling window?" — asks about the METHOD, not
// the time. without a grounded answer the model invents a mechanism, and a wrong one
// already reached a mod as a bug report ("it forgets after 15 dates"). narrow on purpose:
// only pairs with an already-schedule-shaped conversation, so an algorithm question about
// trivia or anything else never pulls this in.
const METHOD_RE =
  /\b(?:algorithm|rolling\s*window|sample\s*size|how\s+(?:do|does|did|d)\s*(?:you|it|u)\s+(?:predict|know|work|guess|calculate|figure|estimate)|how\s+(?:is|does)\s+(?:that|this|it)\s+(?:predicted|calculated|work)|do\s+you\s+learn|machine\s*learn\w*|(?:improve|train)\w*\s+(?:your|the|it)|get\s+better)\b/i
export function isScheduleMethodQuery(q: string): boolean {
  return METHOD_RE.test(q)
}

// the honest description of the predictor, for the model to relay verbatim-in-spirit.
// every claim here is checkable against predictNextStream above — keep them in sync.
export const SCHEDULE_METHOD = `How the stream prediction works — this section is the ONLY true account of the method: relay it, never embellish, and never invent a mechanism, window size, sample limit or cost. Plain statistics, no AI and no learning between runs — it recomputes from scratch on every ask. It reads EVERY stream start logged in the last ${PREDICT_WINDOW_DAYS} days; it is NOT a fixed-size rolling window and it does not "forget" after N starts (older-than-${PREDICT_WINDOW_DAYS}-days is dropped on purpose, because schedules drift). Three models, first one that fits wins: (1) near-daily streak — typical start time across recent starts, weighted so recent ones count more; (2) day-of-week pattern — a weekday counts as a stream day if it had a stream in >=40% of logged weeks, predicted at that weekday's own typical time; (3) steady gap — project the median interval between streams forward. Guards: under 6 starts or under 10 days of history = "still learning"; no pattern in either model = "too irregular". It does get more accurate as more starts are logged.`

// the latest logged session, with a duration only when the poller actually observed one.
function latestSession(raw: StreamSession[]): { startedAt: number; durMs: number | null } | null {
  const s = tidy(raw)
  const last = s.at(-1)
  if (!last) return null
  const dur = last.lastSeenAt - last.startedAt
  return { startedAt: last.startedAt, durMs: dur > 5 * MIN ? dur : null }
}

// past-tense chat reply: what actually happened, straight from logged Helix starts.
// says "yesterday"/"sat" from the data, so an off-by-a-day ask stays honest by construction.
export function formatLastStream(channel: string, sessions: StreamSession[], now: number, live: LiveInfo): string {
  const last = latestSession(sessions)
  if (live.isLive) {
    const since = live.liveSince ?? last?.startedAt
    const up = since ? ` — started ${utcClock(since)}, up ${humanizeDelta(now - since)}` : ''
    return `${channel} is live right now${up}.`
  }
  if (!last) return `haven't logged any ${channel} streams yet — i only see starts from when i'm watching.`
  const ran = last.durMs ? `, ran ${humanizeDelta(last.durMs)}` : ''
  return `last ${channel} stream started ${dayLabel(last.startedAt, now)} around ${utcClock(last.startedAt)} (${humanizeDelta(now - last.startedAt)} ago${ran}).`
}

// AI-context twin of formatLastStream, for the mention-path backstop.
export function lastStreamContext(channel: string, sessions: StreamSession[], now: number, live: LiveInfo): string {
  const last = latestSession(sessions)
  if (live.isLive) {
    const since = live.liveSince ?? last?.startedAt
    return `Last stream for ${channel}: LIVE right now${since ? ` (started ${utcClock(since)}, up ${humanizeDelta(now - since)})` : ''}.`
  }
  if (!last) return `Last stream for ${channel}: no logged sessions. Do not guess a time.`
  const ran = last.durMs ? `, ran ${humanizeDelta(last.durMs)}` : ''
  return `Last stream for ${channel}: started ${dayLabel(last.startedAt, now)} ~${utcClock(last.startedAt)} (${humanizeDelta(now - last.startedAt)} ago${ran}). Relay these numbers, do not guess others.`
}
