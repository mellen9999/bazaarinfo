import { describe, expect, it } from 'bun:test'
import { parseNewsFeed, summarizeNewsHtml, getGrNewsLine, __setGrNewsForTest } from './guildrun-news'

// The steam feed is entity-encoded steam-bb HTML — the parser's whole job is turning
// that into a couple of honest headline lines and never crashing on feed weirdness.

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item>
  <title>Patch 0.5.5</title>
  <description>&lt;p&gt;Hello Guildmasters!&lt;/p&gt;&lt;ul&gt;&lt;li&gt;&lt;p&gt;Heroes now build up Stun Resistance against repeated enemy stuns&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;Buffs across the board to Class Modifiers&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;</description>
  <pubDate>Tue, 19 Aug 2026 17:00:00 +0000</pubDate>
</item>
<item>
  <title><![CDATA[Demo Update]]></title>
  <description><![CDATA[&lt;p&gt;Small fixes only.&lt;/p&gt;]]></description>
  <pubDate>not a date</pubDate>
</item>
</channel></rss>`

describe('parseNewsFeed', () => {
  it('extracts title, display date and a list-item summary', () => {
    const items = parseNewsFeed(FEED)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Patch 0.5.5')
    expect(items[0].date).toBe('Aug 19')
    expect(items[0].summary).toContain('Stun Resistance')
    expect(items[0].summary).toContain('Class Modifiers')
    expect(items[0].summary).not.toContain('<')
  })

  it('a malformed date costs the date, never the item', () => {
    const items = parseNewsFeed(FEED)
    expect(items[1].title).toBe('Demo Update')
    expect(items[1].date).toBe('')
    expect(items[1].summary).toBe('Small fixes only.')
  })

  it('garbage in, empty out — never a throw', () => {
    expect(parseNewsFeed('')).toEqual([])
    expect(parseNewsFeed('<item><description>no title</description></item>')).toEqual([])
  })
})

describe('summarizeNewsHtml', () => {
  it('prefers list items over greeting paragraphs', () => {
    const s = summarizeNewsHtml('&lt;p&gt;Hello!&lt;/p&gt;&lt;ul&gt;&lt;li&gt;real change&lt;/li&gt;&lt;/ul&gt;')
    expect(s).toBe('real change')
  })

  it('falls back to plain text when a post has no lists', () => {
    expect(summarizeNewsHtml('&lt;p&gt;Just an announcement.&lt;/p&gt;')).toBe('Just an announcement.')
  })

  it('caps runaway posts at a word boundary', () => {
    const s = summarizeNewsHtml('&lt;li&gt;' + 'change every hero '.repeat(50) + '&lt;/li&gt;')
    expect(s.length).toBeLessThanOrEqual(260)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('getGrNewsLine', () => {
  it('renders newest-first with an explicit source label', () => {
    __setGrNewsForTest([{ title: 'Patch 0.5.5', date: 'Aug 19', summary: 'stun resistance' }])
    const line = getGrNewsLine()
    expect(line).toContain('official news (steam')
    expect(line).toContain('Patch 0.5.5 (Aug 19): stun resistance')
  })
})
