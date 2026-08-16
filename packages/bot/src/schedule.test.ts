import { test, expect, describe } from 'bun:test'
import {
  predictNextStream,
  typicalDurationMs,
  formatSchedule,
  scheduleContext,
  isScheduleQuery,
  isPastStreamQuery,
  formatLastStream,
  lastStreamContext,
  humanizeDelta,
  withTitleOverride,
  isScheduleMethodQuery,
  SCHEDULE_METHOD,
  PREDICT_WINDOW_DAYS,
  TITLE_SCHEDULE_RE,
  type StreamSession,
} from './schedule'
import { resolveScheduleChannel } from './schedule-query'

const HOUR = 3_600_000
const DAY = 86_400_000
const BASE = Date.UTC(2026, 2, 1, 0, 0, 0) // Sun Mar 1 2026, day-aligned UTC

// a session on day `d` (offset from BASE) starting at `hour`:`min` UTC, live `durH` hours
function sess(d: number, hour: number, min = 0, durH = 5): StreamSession {
  const startedAt = BASE + d * DAY + hour * HOUR + min * 60_000
  return { startedAt, lastSeenAt: startedAt + durH * HOUR }
}

describe('predictNextStream — honesty guards', () => {
  test('too few sessions → insufficient', () => {
    const s = [sess(0, 18), sess(1, 18), sess(2, 18)]
    const p = predictNextStream(s, BASE + 3 * DAY)
    expect(p.kind).toBe('insufficient')
  })

  test('enough sessions but span < 10 days → insufficient', () => {
    const s = [0, 1, 2, 3, 4, 5, 6].map((d) => sess(d, 18)) // 7 sessions, 6-day span
    const p = predictNextStream(s, BASE + 7 * DAY)
    expect(p.kind).toBe('insufficient')
  })

  test('erratic gaps, no weekday pattern → irregular', () => {
    // weekdays spread ≤2 each (no day reaches the 0.4 stream-day bar) + erratic gaps
    const offsets = [0, 2, 8, 18, 20, 26, 37, 41, 57, 60, 70, 73]
    const s = offsets.map((d, i) => sess(d, 12 + (i % 6))) // scattered hours too
    const p = predictNextStream(s, BASE + 76 * DAY)
    expect(p.kind).toBe('irregular')
  })
})

describe('predictNextStream — weekday model', () => {
  test('daily at 18:00 UTC → predicts next day ~18:00', () => {
    const s = Array.from({ length: 28 }, (_, d) => sess(d, 18))
    const now = BASE + 28 * DAY + 20 * HOUR // day 28, 20:00 — today's slot already passed
    const p = predictNextStream(s, now)
    expect(p.kind).toBe('streak') // daily cadence is claimed by the recent-run model
    if (p.kind !== 'streak') return
    expect(p.at).toBeGreaterThan(now)
    // next 18:00 is day 29
    expect(Math.abs(p.at - (BASE + 29 * DAY + 18 * HOUR))).toBeLessThan(45 * 60_000)
    expect(p.confidenceMs).toBeLessThan(2 * HOUR) // tight — all starts identical
  })

  test('one outlier start cannot blow up the ± window', () => {
    // punctual daily 16:00 ±10m, except one 19:00 late night — the window must
    // stay tight (a std here reported ±hours; the coverage quantile drops it)
    const s = Array.from({ length: 20 }, (_, d) => (d === 15 ? sess(d, 19) : sess(d, 16, d % 3 ? 10 : 0)))
    const now = BASE + 20 * DAY + 12 * HOUR
    const p = predictNextStream(s, now)
    expect(p.kind).toBe('streak')
    if (p.kind !== 'streak') return
    expect(Math.abs(p.at - (BASE + 20 * DAY + 16 * HOUR))).toBeLessThan(30 * 60_000) // outlier can't drag the time either
    expect(p.confidenceMs).toBeLessThan(45 * 60_000)
  })

  test('recency-weighted clock follows a schedule shift', () => {
    // a month at 22:00, then five recent streams at 16:00 — prediction must follow
    // the new slot, not average the two into ~19:00
    const s = [
      ...Array.from({ length: 25 }, (_, d) => sess(d, 22)),
      ...Array.from({ length: 5 }, (_, i) => sess(25 + i, 16)),
    ]
    const now = BASE + 30 * DAY + 10 * HOUR
    const p = predictNextStream(s, now)
    expect(p.kind).toBe('streak')
    if (p.kind !== 'streak') return
    expect(Math.abs(p.at - (BASE + 30 * DAY + 16 * HOUR))).toBeLessThan(30 * 60_000)
  })

  test('midnight-straddling starts (23:30 UTC daily) stay coherent', () => {
    const s = Array.from({ length: 28 }, (_, d) => sess(d, 23, 30))
    const now = BASE + 28 * DAY + 12 * HOUR // midday, before tonight's 23:30
    const p = predictNextStream(s, now)
    expect(p.kind).toBe('streak')
    if (p.kind !== 'streak') return
    expect(p.at).toBeGreaterThan(now)
    expect(p.at - now).toBeLessThan(1.1 * DAY) // predicts tonight, not a scrambled far date
    expect(p.confidenceMs).toBeLessThan(3 * HOUR) // not split across a day boundary
  })

  test('weekend-only streamer → predicts a Sat or Sun', () => {
    const s: StreamSession[] = []
    for (let d = 0; d < 42; d++) {
      const wd = new Date(BASE + d * DAY).getUTCDay()
      if (wd === 0 || wd === 6) s.push(sess(d, 20))
    }
    const now = BASE + 44 * DAY // a Tuesday-ish, mid-week
    const p = predictNextStream(s, now)
    expect(p.kind).toBe('weekday')
    if (p.kind !== 'weekday') return
    const wd = new Date(p.at).getUTCDay()
    expect(wd === 0 || wd === 6).toBe(true)
    expect(p.at).toBeGreaterThan(now)
  })
})

describe('predictNextStream — streak model (recent run beats stale weeks)', () => {
  // the real nl_kripp shape: sparse pre-vacation starts, 15-day break, then near-daily
  const kripp = [
    sess(0, 22, 26),
    sess(15, 19, 35),
    sess(19, 20, 4),
    sess(26, 0, 0),
    sess(26, 18, 55),
    sess(27, 19, 22),
    sess(29, 0, 0),
    sess(29, 20, 59),
    sess(30, 22, 1),
  ]

  test('back-from-vacation daily run → predicts today, not a stale weekday', () => {
    const now = BASE + 31 * DAY + 21 * HOUR // ~23h after the last start
    const p = predictNextStream(kripp, now)
    expect(p.kind).toBe('streak')
    if (p.kind !== 'streak') return
    expect(p.at).toBeGreaterThan(now - 15 * 60_000)
    expect(p.at - now).toBeLessThan(DAY) // tonight-ish, never "wed in ~2d"
  })

  test('slot only slightly past its mean stays today, inside the ± window', () => {
    const now = BASE + 31 * DAY + 22 * HOUR // ~1h past the ~21:00 typical clock, σ ~2h
    const p = predictNextStream(kripp, now)
    expect(p.kind).toBe('streak')
    if (p.kind !== 'streak') return
    expect(p.at - now).toBeLessThan(0) // still tonight's slot, reported "any moment now"
    expect(now - p.at).toBeLessThan(p.confidenceMs)
    const out = formatSchedule('nl_kripp', p, now, { isLive: false })
    expect(out).toContain('any moment now')
  })

  test('run gone quiet for 4 days → streak stands down, long models take over', () => {
    const now = BASE + 34 * DAY + 21 * HOUR
    const p = predictNextStream(kripp, now)
    expect(p.kind).not.toBe('streak')
  })

  test('streak copy says near-daily and stays hedged', () => {
    const now = BASE + 31 * DAY + 18 * HOUR
    const out = formatSchedule('nl_kripp', { kind: 'streak', at: now + 3 * HOUR, confidenceMs: 2 * HOUR, loose: false, samples: 5 }, now, { isLive: false })
    expect(out).toContain('near-daily')
    // the hedge is "likely" + the ± window — provenance/disclaimer tails were cut as noise
    expect(out).toContain('likely')
    expect(out).toContain('±')
    const ctx = scheduleContext('nl_kripp', { kind: 'streak', at: now + 3 * HOUR, confidenceMs: 2 * HOUR, loose: false, samples: 5 }, now, { isLive: false })
    expect(ctx).toContain('near-daily')
    expect(ctx.toLowerCase()).toContain('not confirmed')
  })

  // a mod was told "rolling window = only the last 15 stream starts count, oldest drops
  // off" — the model read that straight off our own "from the last 15 starts" copy, where
  // 15 was the clock slice, not the history. the reported count must be the history.
  test('streak reports the full history it read, not the clock slice', () => {
    const s = Array.from({ length: 40 }, (_, d) => sess(d, 18))
    const p = predictNextStream(s, BASE + 39 * DAY + 22 * HOUR)
    expect(p.kind).toBe('streak')
    if (p.kind !== 'streak') return
    expect(p.samples).toBe(40)
    const ctx = scheduleContext('nl_kripp', p, BASE + 39 * DAY + 22 * HOUR, { isLive: false })
    expect(ctx).toContain('40 logged starts')
    expect(ctx).not.toMatch(/last 15 starts/i)
  })
})

describe('prediction method — grounded, so the bot cant invent its own internals', () => {
  test('method asks are recognised, plain time asks are not', () => {
    for (const q of [
      'what does the rolling window mean',
      'how do you predict that',
      'how does it work',
      'do you learn between streams',
      'how can you improve your algorithm',
      'do you improve your algorithm each stream',
    ]) {
      expect(isScheduleMethodQuery(q)).toBe(true)
    }
    for (const q of ['when is kripp streaming', 'is he live', 'translate that to eastern time']) {
      expect(isScheduleMethodQuery(q)).toBe(false)
    }
  })

  test('the method blurb states the real window and denies the invented one', () => {
    expect(SCHEDULE_METHOD).toContain(String(PREDICT_WINDOW_DAYS))
    expect(SCHEDULE_METHOD).toMatch(/NOT a fixed-size rolling window/i)
    expect(SCHEDULE_METHOD).toMatch(/no learning between runs/i)
    // it must not claim an AI is involved — the predictor is deliberately deterministic
    expect(SCHEDULE_METHOD).toMatch(/no AI/i)
  })
})

describe('tidy — near-duplicate starts merge into one session', () => {
  test('crash-restart 20min later is one evening, and its gap never poisons the streak median', () => {
    const s = Array.from({ length: 12 }, (_, d) => sess(d, 18))
    // day 11's stream crashes and restarts at 18:20 — same evening, second Helix started_at
    s.push({ startedAt: BASE + 11 * DAY + 18 * HOUR + 20 * 60_000, lastSeenAt: BASE + 11 * DAY + 23 * HOUR })
    const now = BASE + 12 * DAY + 12 * HOUR // midday, before today's slot
    const p = predictNextStream(s, now)
    expect(p.kind).toBe('streak')
    if (p.kind !== 'streak') return
    // merged: prediction is today's 18:00, the restart row never skews the clock
    expect(Math.abs(p.at - (BASE + 12 * DAY + 18 * HOUR))).toBeLessThan(45 * 60_000)
  })

  test('merged session keeps the longest observed end for duration stats', () => {
    const a = { startedAt: BASE, lastSeenAt: BASE + HOUR }
    const b = { startedAt: BASE + 10 * 60_000, lastSeenAt: BASE + 7 * HOUR }
    expect(typicalDurationMs([a, b, sess(2, 18, 0, 6), sess(4, 18, 0, 6)])).toBe(6 * HOUR)
  })
})

describe('predictNextStream — gap fallback', () => {
  test('consistent every-3-day cadence (weekday drifts) → gap model', () => {
    const s = Array.from({ length: 12 }, (_, i) => sess(i * 3, 19))
    const now = BASE + 34 * DAY // just after last (day 33) + into next gap
    const p = predictNextStream(s, now)
    expect(p.kind).toBe('gap')
    if (p.kind !== 'gap') return
    expect(p.at).toBeGreaterThan(now)
    expect(p.at - now).toBeLessThan(3 * DAY)
  })
})

describe('typicalDurationMs', () => {
  test('median duration over real sessions', () => {
    const s = [sess(0, 18, 0, 4), sess(1, 18, 0, 6), sess(2, 18, 0, 5)]
    expect(typicalDurationMs(s)).toBe(5 * HOUR)
  })
  test('too few sessions → null', () => {
    expect(typicalDurationMs([sess(0, 18)])).toBeNull()
  })
})

describe('formatSchedule / scheduleContext — never fabricate', () => {
  const now = BASE + 30 * DAY
  test('live now leads with the real signal', () => {
    const out = formatSchedule('nl_kripp', { kind: 'irregular', sessions: 9, medianGapMs: null }, now, {
      isLive: true,
      liveSince: now - 3 * HOUR,
      durationMs: 6 * HOUR,
    })
    expect(out).toContain('live right now')
    expect(out).toContain('up ~3h')
  })
  test('insufficient data admits it', () => {
    const out = formatSchedule('nl_kripp', { kind: 'insufficient', sessions: 2, needed: 6 }, now, { isLive: false })
    expect(out).toContain('still learning')
    expect(out).toContain('2/6')
  })
  test('irregular refuses a specific time', () => {
    const out = formatSchedule('nl_kripp', { kind: 'irregular', sessions: 9, medianGapMs: 2 * DAY }, now, { isLive: false })
    expect(out.toLowerCase()).toContain('irregular')
  })
  test('scheduleContext tells the model not to guess when data is thin', () => {
    const ctx = scheduleContext('nl_kripp', { kind: 'insufficient', sessions: 1, needed: 6 }, now, { isLive: false })
    expect(ctx.toLowerCase()).toContain('do not guess')
  })
  test('prediction line hedges honestly', () => {
    const out = formatSchedule('nl_kripp', { kind: 'weekday', at: now + 18 * HOUR, confidenceMs: 40 * 60_000, loose: false, samples: 23 }, now, { isLive: false })
    expect(out).toContain('likely')
    expect(out).toContain('±')
  })

  // chat copy stays tight — the provenance ("from N logged starts") is grounding for the
  // model, not something a viewer asked for. it lives in scheduleContext only.
  test('chat copy is short and drops the provenance tail', () => {
    const p = { kind: 'weekday', at: now + 18 * HOUR, confidenceMs: 40 * 60_000, loose: false, samples: 23 } as const
    const out = formatSchedule('nl_kripp', p, now, { isLive: false })
    expect(out.length).toBeLessThan(110)
    expect(out).not.toContain('23')
    expect(out).not.toMatch(/not a promise|best guess/i)
    expect(scheduleContext('nl_kripp', p, now, { isLive: false })).toContain('23 logged starts')
  })
})

describe('isScheduleQuery', () => {
  test.each([
    'next stream',
    "when's the next stream",
    'when is kripp streaming',
    'when do you stream again',
    'stream schedule',
    'when will kripp be live',
    'is there stream tonight',
    'ai stream predictor',
    'how long until stream',
    'predict kripp stream time', // "predict" before "stream" — the order the regex used to miss
  ])('matches: %s', (q) => expect(isScheduleQuery(q)).toBe(true))

  test.each(['pyg', 'vanessa haste', 'what is heated', 'leaderboard', 'trivia'])(
    'ignores item/other: %s',
    (q) => expect(isScheduleQuery(q)).toBe(false),
  )
})

describe('isPastStreamQuery — tense routing', () => {
  test.each([
    'when did kripp start streaming yesterday',
    'what time did kripp start his stream yesterday',
    'when did kripps stream start',
    'when was the last stream',
    'when was kripp last live',
    'how long was the stream yesterday',
    'when did the stream end',
  ])('past: %s', (q) => expect(isPastStreamQuery(q)).toBe(true))

  test.each([
    'when is the next stream',
    "when's the next stream",
    'when will kripp stream again',
    'how long do streams usually last',
    'is there stream tonight',
    'stream schedule',
  ])('future stays future: %s', (q) => expect(isPastStreamQuery(q)).toBe(false))
})

describe('formatLastStream / lastStreamContext — real data, never a forward guess', () => {
  const now = BASE + 30 * DAY + 15 * HOUR
  const sessions = [sess(20, 21), sess(22, 21, 10), sess(29, 21, 7, 6)] // latest: yesterday 21:07, ran 6h

  test('reports the latest logged start, not a prediction', () => {
    const out = formatLastStream('nl_kripp', sessions, now, { isLive: false })
    expect(out).toContain('yesterday')
    expect(out).toContain('21:07 UTC')
    expect(out).toContain('~6h')
    expect(out).not.toContain('likely')
    expect(out).not.toContain('next')
  })

  test('live now → current stream start, real signal', () => {
    const live = [...sessions, { startedAt: now - 2 * HOUR, lastSeenAt: now - 60_000 }]
    const out = formatLastStream('nl_kripp', live, now, { isLive: true, liveSince: now - 2 * HOUR })
    expect(out).toContain('live right now')
    expect(out).toContain('~2h')
  })

  test('no sessions → honest no-data, no fabrication', () => {
    const out = formatLastStream('nl_kripp', [], now, { isLive: false })
    expect(out.toLowerCase()).toContain("haven't")
    expect(out).not.toMatch(/\d{2}:\d{2} UTC/)
  })

  test('lastStreamContext grounds the model and forbids guessing', () => {
    const ctx = lastStreamContext('nl_kripp', sessions, now, { isLive: false })
    expect(ctx).toContain('21:07')
    expect(ctx.toLowerCase()).toContain('do not guess')
  })

  test('lastStreamContext with no data says so', () => {
    const ctx = lastStreamContext('nl_kripp', [], now, { isLive: false })
    expect(ctx.toLowerCase()).toContain('no logged')
  })
})

describe('humanizeDelta', () => {
  test.each([
    [30 * 60_000, '30m'],
    [3 * HOUR, '~3h'],
    [3 * DAY, '~3d'],
  ])('%p → %p', (ms, want) => expect(humanizeDelta(ms as number)).toBe(want))
})

describe('broadened schedule phrasings', () => {
  test('"getting on" family counts as a stream word', () => {
    expect(isScheduleQuery('when kripp getting on')).toBe(true)
    expect(isScheduleQuery("when's he coming on")).toBe(true)
    expect(isScheduleQuery('when will kripp be on')).toBe(true)
    expect(isScheduleQuery('when is kripp online')).toBe(true)
  })
  test('idioms stay excluded', () => {
    expect(isScheduleQuery("what's going on")).toBe(false)
    expect(isScheduleQuery('how long is this going on')).toBe(false)
    expect(isScheduleQuery('put your shoes on')).toBe(false)
  })
})

describe('resolveScheduleChannel', () => {
  const CHANNELS = ['nl_kripp', 'rogue', 'mellen']
  test('names another tracked channel, tolerating prefix and possessive', () => {
    expect(resolveScheduleChannel('when kripp getting on', 'mellen', CHANNELS)).toBe('nl_kripp')
    expect(resolveScheduleChannel("kripps title says next stream wednesday", 'mellen', CHANNELS)).toBe('nl_kripp')
    expect(resolveScheduleChannel('when does rogue stream', 'mellen', CHANNELS)).toBe('rogue')
  })
  test('defaults to the current channel', () => {
    expect(resolveScheduleChannel('when is the next stream', 'nl_kripp', CHANNELS)).toBe('nl_kripp')
    expect(resolveScheduleChannel('when is kripp live', 'nl_kripp', CHANNELS)).toBe('nl_kripp')
  })
})

describe('title override', () => {
  const offline = { isLive: false }
  test('a schedule-stating title leads the reply', () => {
    const out = withTitleOverride('base prediction.', 'nl_kripp', 'NEXT STREAM WEDNESDAY ~5PM EST', offline)
    expect(out.startsWith('nl_kripp\'s title says: "NEXT STREAM WEDNESDAY ~5PM EST"')).toBe(true)
    expect(out).toContain('base prediction.')
  })
  test('non-schedule titles and live channels leave the reply alone', () => {
    expect(withTitleOverride('base.', 'x', 'chill bazaar grind', offline)).toBe('base.')
    expect(withTitleOverride('base.', 'x', 'back WEDNESDAY', { isLive: true })).toBe('base.')
    expect(withTitleOverride('base.', 'x', null, offline)).toBe('base.')
  })
  test('TITLE_SCHEDULE_RE catches the real shapes', () => {
    expect(TITLE_SCHEDULE_RE.test('NEXT STREAM WEDNESDAY')).toBe(true)
    expect(TITLE_SCHEDULE_RE.test('back tomorrow 5pm')).toBe(true)
    expect(TITLE_SCHEDULE_RE.test('no stream today')).toBe(true)
    expect(TITLE_SCHEDULE_RE.test('bazaar ranked grind w/ chat')).toBe(false)
  })
})
