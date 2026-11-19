import { describe, expect, it } from 'bun:test'
import { eventLineFrom, mergePosts, pickOfficial } from './official-posts'
import { parseNewsFeed } from './steam-news'
import { META_QUERY_RE } from './intents'

const NOW = Date.parse('2026-10-28T20:00:00Z')
const entry = (title: string, iso = '2026-10-28T15:43:05.000Z') =>
  ({ title, date: '', iso, summary: 'Partner Portal runs until Season 20 on November 4.' })

// real steam news item (trimmed), the shape the feed actually serves
const REAL = `<rss><channel>
    <item>
      <title>Patch 19.4: End of Season Event</title>
      <description>&lt;div class=&quot;bb_h3&quot;&gt;&lt;b&gt;Partner Portal&lt;/b&gt;&lt;/div&gt;&lt;ul class=&quot;bb_ul&quot;&gt;&lt;li&gt;&lt;p class=&quot;bb_paragraph&quot;&gt;Select a Partner Hero to join you on your journey&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p class=&quot;bb_paragraph&quot;&gt;The items from the Hero you select will now have a chance to show up at Merchants&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p class=&quot;bb_paragraph&quot;&gt;This event runs until the start of Season 20 on November 4th&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;</description>
      <pubDate>Wed, 28 Oct 2026 15:35:40 +0000</pubDate>

    </item>
</channel></rss>`

describe('official posts', () => {
  it('real steam item -> event line with the end date', () => {
    const line = eventLineFrom(pickOfficial(parseNewsFeed(REAL)), NOW)
    expect(line).toContain('End of Season Event')
    expect(line).toContain('Oct 28')
    expect(line).toContain('November 4th')
  })

  it('keeps dated posts and drops undated ones', () => {
    const got = pickOfficial([entry('End of Season Event - Partner Portal!'), entry('no date', '')])
    expect(got.map((p) => p.title)).toEqual(['End of Season Event - Partner Portal!'])
  })

  it('caps the body', () => {
    expect(pickOfficial([{ ...entry('X'), summary: 'a'.repeat(900) }])[0].body).toHaveLength(500)
  })

  it('serves the event post as a line with its date and body', () => {
    const line = eventLineFrom(pickOfficial([entry('End of Season Event - Partner Portal!')]), NOW)
    expect(line).toContain('Partner Portal')
    expect(line).toContain('Oct 28')
    expect(line).toContain('November 4')
  })

  it('ignores non-event posts and stale events', () => {
    expect(eventLineFrom(pickOfficial([entry('Patch 18.0 notes')]), NOW)).toBe('')
    expect(eventLineFrom(pickOfficial([entry('Old Event', '2026-08-01T00:00:00.000Z')]), NOW)).toBe('')
  })

  it('merge dedupes by title, newest first, drops posts past retention', () => {
    const old = pickOfficial([entry('A', '2026-10-01T00:00:00.000Z'), entry('Ancient', '2026-08-01T00:00:00.000Z')])
    const fresh = pickOfficial([entry('A', '2026-10-05T00:00:00.000Z'), entry('B', '2026-10-20T00:00:00.000Z')])
    const out = mergePosts(old, fresh, NOW)
    expect(out.map((p) => p.title)).toEqual(['B', 'A'])
    expect(out[1].updated).toBe('2026-10-05T00:00:00.000Z')
  })

  it('"what\'s the new bazaar event" routes as a meta query', () => {
    for (const q of ["what's the new bazaar event?", 'whats the current event', 'is the end of season event live'])
      expect(META_QUERY_RE.test(q)).toBe(true)
  })
})
