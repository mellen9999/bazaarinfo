import { describe, it, expect } from 'bun:test'
import { fitToBudget, nowLine, streamLine, shapeLine, TRIVIA_REF_RE, STANDINGS_RE, COMPARISON_RE } from './ai-build'
import { markLiveStateKnown, setChannelLive, setChannelOffline, setStreamInfo } from './ai-cache'
import { META_QUERY_RE } from './intents'

describe('nowLine — the bot can state the weekday instead of deriving it', () => {
  it('names the weekday, date and UTC time', () => {
    const l = nowLine(new Date(Date.UTC(2026, 7, 12, 17, 42)))
    expect(l).toContain('wednesday 12 aug 2026')
    expect(l).toContain('17:42 UTC')
  })

  it('zero-pads and rolls the weekday correctly', () => {
    expect(nowLine(new Date(Date.UTC(2026, 0, 4, 9, 5)))).toContain('sunday 4 jan 2026, 09:05 UTC')
    expect(nowLine(new Date(Date.UTC(2026, 11, 31, 0, 0)))).toContain('thursday 31 dec 2026, 00:00 UTC')
  })

  it('stays small enough to never lose its slot in the context budget', () => {
    expect(nowLine().length).toBeLessThan(220)
  })
})

describe('streamLine — the bot knows whether the stream is live, like everyone else in chat', () => {
  it('says nothing until the first Helix poll lands', () => {
    // a fresh process has an empty live set; that is "not asked yet", not "offline"
    expect(streamLine('nl_kripp')).toBe('')
  })

  it('reports live with the game, and offline plainly, once state is known', () => {
    markLiveStateKnown()
    expect(streamLine('nl_kripp')).toContain('offline')
    setChannelLive('nl_kripp', 'The Bazaar')
    expect(streamLine('nl_kripp')).toContain('LIVE')
    expect(streamLine('nl_kripp')).toContain('The Bazaar')
    setChannelOffline('nl_kripp')
  })

  it('carries everything the channel page shows: title, uptime, viewers', () => {
    markLiveStateKnown()
    setChannelLive('nl_kripp', 'The Bazaar')
    const start = Date.UTC(2026, 7, 12, 14, 0)
    setStreamInfo('nl_kripp', { title: 'dragons or bust', viewers: 8234, startedAt: start })
    const l = streamLine('nl_kripp', start + (3 * 60 + 12) * 60_000)
    expect(l).toContain('"dragons or bust"')
    expect(l).toContain('live for 3h12m')
    expect(l).toContain('8.2k watching')
    // the count is public, but moving it into a jab is not
    expect(l).toContain('Never editorialise the viewer count')
    setChannelOffline('nl_kripp')
  })

  it('rounds viewers and uptime the way a viewer reads them', () => {
    markLiveStateKnown()
    setChannelLive('nl_kripp')
    const t = Date.UTC(2026, 7, 12, 14, 0)
    setStreamInfo('nl_kripp', { viewers: 47, startedAt: t })
    expect(streamLine('nl_kripp', t + 25 * 60_000)).toContain('live for 25m, 47 watching')
    setStreamInfo('nl_kripp', { viewers: 124_000, startedAt: t })
    expect(streamLine('nl_kripp', t)).toContain('124k watching')
    setChannelOffline('nl_kripp')
  })

  it('never invents a clock: no started_at means no uptime claim', () => {
    markLiveStateKnown()
    setChannelLive('nl_kripp')
    setStreamInfo('nl_kripp', { title: 'no timestamp here' })
    expect(streamLine('nl_kripp')).not.toContain('live for')
    setChannelOffline('nl_kripp')
  })
})

describe('shapeLine — the streak breaker costs a context line, not a second call', () => {
  const dash = (s) => `${s} carries the run — that is the whole build in one card`

  it('stays quiet until the pattern is actually a pattern', () => {
    expect(shapeLine([])).toBe('')
    expect(shapeLine(['plain sentence with no dash at all in it'])).toBe('')
    expect(shapeLine([dash('a')])).toBe('')
  })

  it('names the streak so the instruction is actionable', () => {
    expect(shapeLine([dash('a'), dash('b')])).toContain('last 2 replies')
    expect(shapeLine([dash('a'), dash('b'), dash('c')])).toContain('last 3 replies')
    expect(shapeLine([dash('a'), dash('b')])).toContain('No em-dash')
  })
})

describe('fitToBudget — graceful section truncation', () => {
  it('returns text unchanged when it fits', () => {
    expect(fitToBudget('abc', 10)).toBe('abc')
    expect(fitToBudget('abc', 3)).toBe('abc')
  })

  it('truncates at the last newline within budget', () => {
    const t = 'line1\nline2\nline3' // \n at idx 5 and 11
    // budget 10 lands mid "line2" -> cut back to the \n at idx 5
    expect(fitToBudget(t, 10)).toBe('line1')
    // budget 14 lands mid "line3" -> cut back to the \n at idx 11
    expect(fitToBudget(t, 14)).toBe('line1\nline2')
  })

  it('drops single-line sections that overflow (no newline to cut at)', () => {
    expect(fitToBudget('one long single line', 5)).toBeNull()
  })

  it('drops leading-newline sections too small for even their first line', () => {
    // many sections start with "\n"; budget too small to reach the second newline
    expect(fitToBudget('\nActivity: something long here', 5)).toBeNull()
  })

  it('keeps the head of a leading-newline list when budget allows', () => {
    const t = '\nemotes: a b c\nmore: d e f'
    expect(fitToBudget(t, 20)).toBe('\nemotes: a b c')
  })
})

describe('TRIVIA_REF_RE — references to the just-played round inject the real Q+A', () => {
  // every match requires an explicit trivia/round anchor so generic doubt phrases
  // ("is that real", "that question about builds") don't inject stale context.
  it('fires on explicit trivia/round-anchored references', () => {
    for (const q of [
      'fact check that trivia answer',
      'fact-check the answer',        // "answer" alone counts as anchor in fact-check path
      'fact check the question',
      'fact check that round',
      'that trivia answer is cap',
      'the trivia question',
      'what was the last trivia question',
      'the answer was wrong',         // "answer was wrong" — trivia-answer result phrasing
      'the answer is correct',
      'wait was the previous round legit',
      'previous trivia round',
      'trivia answer was right',
    ]) expect(TRIVIA_REF_RE.test(q)).toBe(true)
  })

  it('does not fire on generic doubt/reaction phrases without a trivia/round anchor', () => {
    for (const q of [
      // previously false-positives that injected stale trivia context:
      'is that real',
      'that question about builds',
      'was that right',               // no trivia anchor
      'is that even correct',         // no trivia anchor
      'was that answer wrong',        // "that answer wrong" — word order doesn't match "answer was wrong"
      'factcheck that',               // no answer/question/round specified
      'the answer is bs',             // "bs" not in legit/right/wrong list
      // unrelated chatter:
      "what's kripp's best item",
      'tell me a joke about hamstornado',
      'who is the strongest hero',
      'how many queries do you serve',
      'spam Pog 5 times',
      'is dooley good right now',
    ]) expect(TRIVIA_REF_RE.test(q)).toBe(false)
  })
})

describe('STANDINGS_RE — new intent phrasings ground AI with real leaderboard data', () => {
  it('matches new phrasings that previously deflected or fabricated', () => {
    for (const q of [
      // defect 1 — "who has the most" family
      'who has the most wins',
      'who has the most points',
      "who's got the highest score",
      'who got the top wins',
      // defect 2 — leader/leading phrasing
      'points leader',
      'score leader',
      'wins leader',
      'leading in points',
      'leader in wins',
      // defect 4 — first-person count
      'how many trivia wins do i have',
      'how many points do i have',
      'how many wins have i got',
      // defect 5 — @-mention comparison
      'do i have more wins than @bob',
      'more points than @alice',
      'fewer wins than @charlie',
    ]) expect(STANDINGS_RE.test(q)).toBe(true)
  })

  it('does not hijack "trivia about winning" (topic round request)', () => {
    // "trivia about X" routes to custom round generation — must NOT be grounded as standings
    expect(STANDINGS_RE.test('trivia about winning')).toBe(false)
  })

  it('preserves existing phrasings', () => {
    for (const q of [
      'leaderboard',
      'standings',
      'scoreboard',
      "who's winning",
      'who is leading',
      'my trivia stats',
      'where do i rank',
      'am i winning',
      'top players',
    ]) expect(STANDINGS_RE.test(q)).toBe(true)
  })
})

describe('COMPARISON_RE — detects @-mention win/point comparison for dual-user injection', () => {
  it('fires on comparison phrasings', () => {
    for (const q of [
      'do i have more wins than @bob',
      'more points than @alice',
      'fewer wins than @charlie',
      'higher score than @dave',
      'better points than @eve',
    ]) expect(COMPARISON_RE.test(q)).toBe(true)
  })

  it('does not fire on non-comparison standings questions', () => {
    expect(COMPARISON_RE.test('who has the most wins')).toBe(false)
    expect(COMPARISON_RE.test('leaderboard')).toBe(false)
    expect(COMPARISON_RE.test('how many wins do i have')).toBe(false)
  })
})

describe('META_QUERY_RE — live patch/event questions route to the bazaardb patch line', () => {
  it('fires on what-is-new / event / patch phrasings', () => {
    for (const q of [
      'whats new', "what's new in the game", 'is there a new event', 'any events right now',
      'tell me about this new event', 'current patch', 'latest patch notes', 'any updates',
      'whats happening', 'is there an event', 'new season',
    ]) expect(META_QUERY_RE.test(q)).toBe(true)
  })

  // real miss: no qualifier (current/latest/new/this) before "patch" and not "patch notes"
  // either — a release-timing ask, which getPatchInfo() actually has an answer for
  it('fires on release-timing patch phrasings with no qualifier', () => {
    for (const q of [
      'do u know when the patch drops for bazaar?',
      "when's the patch dropping",
      'when does the next patch release',
      'when is the patch coming out',
      'when does the patch land',
    ]) expect(META_QUERY_RE.test(q)).toBe(true)
  })

  it('does not fire on ordinary item/card queries', () => {
    for (const q of [
      'eyepatch', 'patchwork', 'vanessa', 'fiery boomerang', 'diamond heart', 'whats subscraper',
    ]) expect(META_QUERY_RE.test(q)).toBe(false)
  })
})
