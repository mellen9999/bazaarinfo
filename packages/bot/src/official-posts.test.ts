import { describe, expect, it } from 'bun:test'
import { eventLineFrom, mergePosts, pickOfficial } from './official-posts'
import { META_QUERY_RE } from './intents'

const NOW = Date.parse('2026-10-28T20:00:00Z')
const entry = (author: string, title: string, updated = '2026-10-28T15:43:05+00:00') =>
  ({ author, title, body: 'Partner Portal runs until Season 20 on November 4.', updated })

describe('official posts', () => {
  it('keeps only the official account', () => {
    const got = pickOfficial([entry('TempoStormReddit', 'End of Season Event - Partner Portal!'), entry('randomguy', 'my event idea')])
    expect(got.map((p) => p.title)).toEqual(['End of Season Event - Partner Portal!'])
  })

  it('drops the submitted-by footer from the body', () => {
    const e = { ...entry('TempoStormReddit', 'X Event'), body: 'runs until Nov 4. submitted by /u/TempoStormReddit to r/PlayTheBazaar [link] [comments]' }
    expect(pickOfficial([e])[0].body).toBe('runs until Nov 4.')
  })

  it('serves the event post as a line with its date and body', () => {
    const line = eventLineFrom(pickOfficial([entry('TempoStormReddit', 'End of Season Event - Partner Portal!')]), NOW)
    expect(line).toContain('Partner Portal')
    expect(line).toContain('Oct 28')
    expect(line).toContain('November 4')
  })

  it('ignores non-event posts and stale events', () => {
    expect(eventLineFrom(pickOfficial([entry('TempoStormReddit', 'Patch 18.0 notes')]), NOW)).toBe('')
    expect(eventLineFrom(pickOfficial([entry('TempoStormReddit', 'Old Event', '2026-08-01T00:00:00+00:00')]), NOW)).toBe('')
  })

  it('merge dedupes by title, newest first, drops posts past retention', () => {
    const old = pickOfficial([entry('TempoStormReddit', 'A', '2026-10-01T00:00:00+00:00'), entry('TempoStormReddit', 'Ancient', '2026-08-01T00:00:00+00:00')])
    const fresh = pickOfficial([entry('TempoStormReddit', 'A', '2026-10-05T00:00:00+00:00'), entry('TempoStormReddit', 'B', '2026-10-20T00:00:00+00:00')])
    const out = mergePosts(old, fresh, NOW)
    expect(out.map((p) => p.title)).toEqual(['B', 'A'])
    expect(out[1].updated).toBe('2026-10-05T00:00:00+00:00')
  })

  it('"what\'s the new bazaar event" routes as a meta query', () => {
    for (const q of ["what's the new bazaar event?", 'whats the current event', 'is the end of season event live'])
      expect(META_QUERY_RE.test(q)).toBe(true)
  })
})
